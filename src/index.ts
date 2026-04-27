import { config, validateConfig } from "./utils/config";
import { createLogger } from "./utils/logger";
import { withJitter } from "./utils/jitter";
import { initDatabase, closeDatabase, getDb } from "./database/connection";
import { runMigrations } from "./database/migrations";
import { resetStmts, getStmts } from "./database/queries";
import { hydrateFromSupabase } from "./database/hydrator";
import { GatewayClient } from "./gateway/client";
import {
    handlePresenceUpdate, initPresence, getCurrentPresence,
} from "./collectors/presence";
import {
    handleActivityUpdate, initActivities, getCurrentActivities,
} from "./collectors/activity";
import {
    handleMessageCreate, handleMessageUpdate, handleMessageDelete,
} from "./collectors/message";
import { handleTypingStart } from "./collectors/typing";
import {
    handleVoiceStateUpdate, updateCoParticipants, getCurrentVoiceState,
} from "./collectors/voice";
import { handleProfileUpdate } from "./collectors/profile";
import { handleReactionAdd, handleReactionRemove } from "./collectors/reaction";
import { handleGuildMemberUpdate } from "./collectors/guild-member";
import { handleChannelCreate } from "./collectors/dm-detection";
import { startProfilePoller, stopProfilePoller } from "./pollers/profile-poller";
import {
    startStatusPoller, stopStatusPoller, setRequestGuildMembersFn,
} from "./pollers/status-poller";
import { startMutualServersPoller, stopMutualServersPoller } from "./pollers/mutual-servers";
import { startConnectedAccountsPoller, stopConnectedAccountsPoller } from "./pollers/connected-accounts";
import { startApiServer } from "./api/server";
import { pushSSEEvent } from "./api/routes/events";
import { setAlertCallback, reloadRules, evaluateEvent, resetAlertFireCounts } from "./alerts/engine";
import { computeDailySummaries } from "./daily-summary";
import { initSupabaseSync, SupabaseSyncEngine } from "./database/supabase-sync";
import { runAISocialGraphAnalysis } from "./analyzers/social-graph-ai";
import { runAllCategorization } from "./categorization/categorizer";
import { runAllBaselineComputation } from "./analyzers/baseline";
import { scheduleBriefGeneration } from "./briefs/brief-generator";
import { startBackfillOnStartup } from "./backfill/backfill-engine";
import { startDigestFlusher } from "./alerts/digest";
import { notifyStartup, notifyCriticalError } from "./utils/webhook-notifier";

const log = createLogger("Sentinel");

let gateway:                  GatewayClient | null      = null;
let dailySummaryInterval:     NodeJS.Timeout | null      = null;
let voiceParticipantInterval: NodeJS.Timeout | null      = null;
let heartbeatInterval:        NodeJS.Timeout | null      = null;
let supabaseSync:             SupabaseSyncEngine | null  = null;
let briefHandle:              NodeJS.Timeout | null      = null;
let digestHandle:             NodeJS.Timeout | null      = null;
let aiAnalysisInterval:       NodeJS.Timeout | null      = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTarget(userId: string): boolean {
    const stmts  = getStmts();
    const target = stmts.getTarget.get(userId) as any;
    return target?.active === 1;
}

function startHeartbeatLogger(): void {
    const INTERVAL = 60_000;
    heartbeatInterval = setInterval(() => {
        try {
            const stmts = getStmts();
            stmts.insertHeartbeat.run(Date.now());
            stmts.pruneHeartbeats.run();
        } catch { /* non-fatal */ }
    }, INTERVAL);
    log.info("Heartbeat logger started (60 s interval)");
}

function closeStaleOpenSessions(): void {
    const db  = getDb();
    const now = Date.now();

    let closeAt = now;
    try {
        const stmts = getStmts();
        const row   = stmts.getLastHeartbeat.get() as { timestamp: number } | undefined;
        if (row?.timestamp && row.timestamp < now) {
            closeAt = row.timestamp;
            log.info(`Using last heartbeat timestamp for stale session close: ${new Date(closeAt).toISOString()}`);
        }
    } catch { }

    const presenceChanges = db
        .prepare("UPDATE presence_sessions  SET end_time = ?, duration_ms = ? - start_time WHERE end_time IS NULL")
        .run(closeAt, closeAt).changes;

    const activityChanges = db
        .prepare("UPDATE activity_sessions  SET end_time = ?, duration_ms = ? - start_time WHERE end_time IS NULL")
        .run(closeAt, closeAt).changes;

    const voiceChanges = db
        .prepare("UPDATE voice_sessions     SET end_time = ?, duration_ms = ? - start_time WHERE end_time IS NULL")
        .run(closeAt, closeAt).changes;

    if (presenceChanges + activityChanges + voiceChanges > 0) {
        log.info(
            `Closed stale sessions from previous run at ${new Date(closeAt).toISOString()}: ` +
            `${presenceChanges} presence, ${activityChanges} activity, ${voiceChanges} voice`
        );
    }
}

// ── Gateway: initial presence request ─────────────────────────────────────────

function requestInitialPresences(client: GatewayClient): void {
    const stmts   = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    if (targets.length === 0) return;

    const guildTargetMap = new Map<string, string[]>();

    for (const target of targets) {
        const snapshot = stmts.getLatestSnapshot.get(target.user_id) as any;
        if (!snapshot?.mutual_guilds) continue;

        let guilds: any[] = [];
        try { guilds = JSON.parse(snapshot.mutual_guilds); } catch { }

        for (const guild of guilds) {
            const guildId: string = typeof guild === "string" ? guild : guild.id;
            if (!guildId) continue;
            const existing = guildTargetMap.get(guildId) || [];
            existing.push(target.user_id);
            guildTargetMap.set(guildId, existing);
        }
    }

    if (guildTargetMap.size === 0) {
        log.info("No mutual guild data yet — initial presences will arrive via PRESENCE_UPDATE events.");
        return;
    }

    const batches: { guildId: string; userIds: string[] }[] = [];
    for (const [guildId, userIds] of guildTargetMap) {
        for (let i = 0; i < userIds.length; i += 100) {
            batches.push({ guildId, userIds: userIds.slice(i, i + 100) });
        }
    }

    const STAGGER_MS = 600;
    log.info(
        `Requesting initial presences: ${batches.length} batch(es) for ${targets.length} target(s)` +
        ` — staggered over ${(batches.length * STAGGER_MS / 1000).toFixed(1)}s`
    );

    batches.forEach(({ guildId, userIds }, i) => {
        client.requestGuildMembers(guildId, userIds, i * STAGGER_MS);
    });
}

// ── Gateway: event handler ────────────────────────────────────────────────────

function setupGatewayHandlers(client: GatewayClient): void {
    client.on("dispatch", (eventName: string, data: any) => {
        try {
            switch (eventName) {

                // ── Presence ───────────────────────────────────────────────────
                // handlePresenceUpdate now pushes processed SSE events directly.
                // handleActivityUpdate now pushes SSE for activity changes.
                case "PRESENCE_UPDATE": {
                    const userId = data.user?.id;
                    if (!userId || !isTarget(userId)) break;
                    handlePresenceUpdate(userId, data);
                    handleActivityUpdate(userId, data.activities || []);
                    break;
                }

                // ── Messages ───────────────────────────────────────────────────
                // Keep pushing raw Discord message data — the live feed needs
                // `content` which isn't in the processed event data.
                case "MESSAGE_CREATE": {
                    const authorId = data.author?.id;
                    if (!authorId || !isTarget(authorId)) break;
                    if (data.author.bot) break;
                    log.info(`MESSAGE_CREATE from tracked target ${authorId} in guild ${data.guild_id || "DM"}`);
                    const msgEventData = handleMessageCreate(authorId, data, data.guild_id || null, "live");
                    evaluateEvent("MESSAGE_CREATE", authorId, msgEventData);
                    pushSSEEvent({
                        target_id:  authorId,
                        event_type: "MESSAGE_CREATE",
                        timestamp:  Date.now(),
                        data,
                    });
                    break;
                }

                case "MESSAGE_UPDATE": {
                    const authorId = data.author?.id;
                    if (!authorId || !isTarget(authorId)) break;
                    handleMessageUpdate(authorId, data, data.guild_id || null);
                    pushSSEEvent({
                        target_id:  authorId,
                        event_type: "MESSAGE_UPDATE",
                        timestamp:  Date.now(),
                        data,
                    });
                    break;
                }

                case "MESSAGE_DELETE": {
                    const deletedTargetId = handleMessageDelete(data.id, data.channel_id, data.guild_id || null);
                    if (deletedTargetId) {
                        pushSSEEvent({
                            target_id:  deletedTargetId,
                            event_type: "MESSAGE_DELETE",
                            timestamp:  Date.now(),
                            data,
                        });
                    }
                    break;
                }

                // ── Typing ─────────────────────────────────────────────────────
                // GHOST_TYPE SSE is pushed inside the typing collector's timeout.
                case "TYPING_START": {
                    const userId = data.user_id;
                    if (!userId || !isTarget(userId)) break;
                    handleTypingStart(userId, data.channel_id, data.guild_id || null);
                    pushSSEEvent({
                        target_id:  userId,
                        event_type: "TYPING_START",
                        timestamp:  Date.now(),
                        data,
                    });
                    break;
                }

                // ── Voice ──────────────────────────────────────────────────────
                // handleVoiceStateUpdate now pushes semantic VOICE_JOIN/LEAVE/MOVE/
                // STATE_CHANGE events to SSE directly.
                case "VOICE_STATE_UPDATE": {
                    const userId = data.user_id;
                    if (!userId || !isTarget(userId)) break;
                    handleVoiceStateUpdate(userId, data);
                    break;
                }

                // ── Profile ────────────────────────────────────────────────────
                // handleProfileUpdate now pushes PROFILE_UPDATE/AVATAR_CHANGE/
                // USERNAME_CHANGE to SSE directly.
                case "USER_UPDATE": {
                    const userId = data.id;
                    if (!userId || !isTarget(userId)) break;
                    handleProfileUpdate(userId, data);
                    break;
                }

                // handleGuildMemberUpdate now pushes NICKNAME_CHANGE/ROLE_ADD/REMOVE to SSE.
                case "GUILD_MEMBER_UPDATE": {
                    const userId = data.user?.id;
                    if (!userId || !isTarget(userId)) break;
                    handleGuildMemberUpdate(userId, data.guild_id, data);
                    break;
                }

                // ── Reactions ──────────────────────────────────────────────────
                // handleReactionAdd/Remove now push REACTION_ADD/REMOVE to SSE.
                case "MESSAGE_REACTION_ADD": {
                    const userId = data.user_id;
                    if (!userId || !isTarget(userId)) break;
                    handleReactionAdd(
                        userId, data.message_id,
                        data.message_author_id || null,
                        data.channel_id, data.guild_id || null,
                        data.emoji
                    );
                    break;
                }

                case "MESSAGE_REACTION_REMOVE": {
                    const userId = data.user_id;
                    if (!userId || !isTarget(userId)) break;
                    handleReactionRemove(
                        userId, data.message_id,
                        data.channel_id, data.guild_id || null,
                        data.emoji
                    );
                    break;
                }

                // ── DM detection ───────────────────────────────────────────────
                // handleChannelCreate now pushes DM_CHANNEL_OPENED to SSE.
                case "CHANNEL_CREATE": {
                    handleChannelCreate(data, isTarget);
                    break;
                }

                // ── Guild members chunk ────────────────────────────────────────
                case "GUILD_MEMBERS_CHUNK": {
                    const presenceMap = new Map<string, any>();
                    for (const presence of data.presences || []) {
                        const uid: string | undefined = presence.user?.id;
                        if (uid) presenceMap.set(uid, presence);
                    }

                    for (const member of data.members || []) {
                        const userId: string | undefined = member.user?.id;
                        if (!userId || !isTarget(userId)) continue;

                        if (member.user) handleProfileUpdate(userId, member.user);

                        const presence = presenceMap.get(userId);

                        if (presence) {
                            const existing = getCurrentPresence(userId);
                            if (!existing) {
                                initPresence(userId, presence);
                                if (presence.activities?.length) {
                                    initActivities(userId, presence.activities);
                                }
                                log.info(`Initialised presence for ${userId}: ${presence.status}`);
                            } else {
                                handlePresenceUpdate(userId, presence);
                                if (presence.activities) {
                                    handleActivityUpdate(userId, presence.activities);
                                }
                            }
                        } else {
                            const existing = getCurrentPresence(userId);
                            if (!existing) {
                                initPresence(userId, { status: "offline", client_status: null });
                                log.info(`Initialised presence for ${userId}: offline (not in chunk)`);
                            } else if (existing.status !== "offline") {
                                log.info(
                                    `${userId}: absent from guild chunk presences — ` +
                                    `correcting ${existing.status} → offline`
                                );
                                handlePresenceUpdate(userId, { status: "offline", client_status: null });
                                handleActivityUpdate(userId, []);
                            }
                        }
                    }
                    break;
                }

                // ── Session resume ─────────────────────────────────────────────
                case "RESUMED": {
                    log.info("Session resumed — re-requesting current presences in 3 s");
                    setTimeout(() => requestInitialPresences(client), 3_000);
                    break;
                }
            }
        } catch (err: any) {
            log.error(`Error handling ${eventName}: ${err.message}`);
        }
    });

    client.on("ready", (data: any) => {
        log.info(`Gateway ready. Guilds: ${data.guilds?.length || 0}`);

        setRequestGuildMembersFn((guildId, userIds) =>
            client.requestGuildMembers(guildId, userIds)
        );

        setTimeout(() => requestInitialPresences(client), 2_000);
    });
}

// ── Voice participant tracker ─────────────────────────────────────────────────

function startVoiceParticipantTracker(client: GatewayClient): void {
    voiceParticipantInterval = setInterval(() => {
        const stmts   = getStmts();
        const targets = stmts.getActiveTargets.all() as any[];
        for (const target of targets) {
            const voiceState = getCurrentVoiceState(target.user_id);
            if (voiceState) {
                client.requestGuildMembers(voiceState.guildId, [target.user_id]);
            }
        }
    }, withJitter(60_000));
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(): void {
    log.info("Shutting down…");

    if (dailySummaryInterval)     clearInterval(dailySummaryInterval);
    if (voiceParticipantInterval) clearInterval(voiceParticipantInterval);
    if (heartbeatInterval)        clearInterval(heartbeatInterval);
    if (aiAnalysisInterval)       clearInterval(aiAnalysisInterval);
    if (digestHandle)             clearInterval(digestHandle);
    if (briefHandle)              clearTimeout(briefHandle);

    stopProfilePoller();
    stopStatusPoller();
    stopMutualServersPoller();
    stopConnectedAccountsPoller();

    supabaseSync?.stop();

    try {
        const db  = getDb();
        const now = Date.now();
        db.prepare("UPDATE presence_sessions  SET end_time = ?, duration_ms = ? - start_time WHERE end_time IS NULL").run(now, now);
        db.prepare("UPDATE activity_sessions  SET end_time = ?, duration_ms = ? - start_time WHERE end_time IS NULL").run(now, now);
        db.prepare("UPDATE voice_sessions     SET end_time = ?, duration_ms = ? - start_time WHERE end_time IS NULL").run(now, now);
    } catch { /* best-effort */ }

    gateway?.destroy();
    resetStmts();
    closeDatabase();

    log.info("Sentinel shut down gracefully.");
    process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    log.info("=== Sentinel Starting ===");
    if (config.randomJitter) {
        log.info("RANDOM_JITTER is enabled — polling intervals and IDENTIFY profile will vary");
    }

    try {
        validateConfig();
    } catch (err: any) {
        log.error(err.message);
        process.exit(1);
    }

    initDatabase();
    runMigrations();

    if (config.dbMode === "cloud") {
        try {
            await hydrateFromSupabase();
        } catch (err: any) {
            log.error(`Hydration failed: ${err.message}`);
            log.error(
                "Cannot start in cloud mode without a successful Supabase hydration. " +
                "Check your credentials and that supabase-schema.sql has been run."
            );
            process.exit(1);
        }
    }

    closeStaleOpenSessions();
    reloadRules();

    setAlertCallback((alert) => {
        pushSSEEvent({
            target_id:  alert.targetId,
            event_type: "ALERT",
            timestamp:  Date.now(),
            data:       alert,
        });
    });

    supabaseSync = initSupabaseSync();
    if (supabaseSync.enabled) {
        supabaseSync.testConnection()
            .then((ok) => {
                if (!ok) {
                    log.warn(
                        "Supabase initial connection test failed. " +
                        "Sync will keep retrying. " +
                        "Check SUPABASE_URL / SUPABASE_SERVICE_KEY and confirm " +
                        "you have run supabase-schema.sql."
                    );
                }
            })
            .catch(() => {});

        supabaseSync.start();
    }

    await startApiServer();

    startHeartbeatLogger();

    gateway = new GatewayClient();
    setupGatewayHandlers(gateway);
    await gateway.connect();

    startProfilePoller();
    startStatusPoller();
    startMutualServersPoller();
    startConnectedAccountsPoller();

    startVoiceParticipantTracker(gateway);

    dailySummaryInterval = setInterval(() => {
        try { computeDailySummaries(); }
        catch (err: any) { log.error(`Daily summary error: ${err.message}`); }
        try { runAllBaselineComputation(); }
        catch (err: any) { log.error(`Baseline computation error: ${err.message}`); }
        try { resetAlertFireCounts(); }
        catch (err: any) { log.error(`Alert fire count reset error: ${err.message}`); }
    }, withJitter(config.dailySummaryIntervalMs));

    setTimeout(() => {
        try { computeDailySummaries(); } catch { /* non-fatal */ }
        try { runAllBaselineComputation(); } catch { /* non-fatal */ }
    }, 120_000);

    briefHandle = scheduleBriefGeneration();

    digestHandle = startDigestFlusher();

    if (config.backfillEnabled) {
        setTimeout(() => {
            startBackfillOnStartup().catch(err =>
                log.error(`Startup backfill error: ${err.message}`)
            );
        }, 120_000);
    }

    if (config.aiProvider !== "none") {
        setTimeout(async () => {
            try {
                await runAllBaselineComputation();
                await runAISocialGraphAnalysis();
                await runAllCategorization();
            } catch (err: any) {
                log.error(`AI analysis first run error: ${err.message}`);
            }

            aiAnalysisInterval = setInterval(async () => {
                try { await runAllBaselineComputation(); }
                catch (err: any) { log.error(`AI baseline error: ${err.message}`); }
                try { await runAISocialGraphAnalysis(); }
                catch (err: any) { log.error(`AI social graph error: ${err.message}`); }
                try { await runAllCategorization(); }
                catch (err: any) { log.error(`AI categorization error: ${err.message}`); }
            }, config.aiAnalysisIntervalMs);
        }, 600_000);
    }

    log.info("=== Sentinel Fully Operational ===");
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    log.error(err.stack || "");
    notifyCriticalError(err.message, err.stack?.slice(0, 800)).catch(() => {});
});
process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error(`Unhandled rejection: ${msg}`);
    notifyCriticalError(`Unhandled rejection: ${msg}`).catch(() => {});
});

main().catch((err) => {
    log.error(`Fatal error: ${err.message}`);
    notifyCriticalError(`Fatal startup error: ${err.message}`, err.stack?.slice(0, 800))
        .catch(() => {})
        .finally(() => process.exit(1));
});