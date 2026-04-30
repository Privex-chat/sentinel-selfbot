import { config, validateConfig } from "./utils/config";
import { createLogger } from "./utils/logger";
import { withJitter } from "./utils/jitter";
import { initDatabase, closeDatabase, getDb } from "./database/connection";
import { runMigrations } from "./database/migrations";
import { resetStmts, getStmts } from "./database/queries";
import { hydrateFromSupabase } from "./database/hydrator";
import { GatewayClient } from "./gateway/client";
import {
    handlePresenceUpdate, initPresence, getCurrentPresence, isActiveStatus,
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
    setSelfbotGuildsFn,
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
import { loadRuntimeConfig, onConfigChange } from "./runtime-config";
import { resetAIProvider } from "./ai/provider";

const log = createLogger("Sentinel");

let startupNotificationSent = false;

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

    const guildTargetMap = new Map<string, Set<string>>();

    // Primary: use stored mutual_guilds from profile snapshots
    for (const target of targets) {
        const snapshot = stmts.getLatestSnapshot.get(target.user_id) as any;
        if (!snapshot?.mutual_guilds) continue;

        let guilds: any[] = [];
        try { guilds = JSON.parse(snapshot.mutual_guilds); } catch { }

        for (const guild of guilds) {
            const guildId: string = typeof guild === "string" ? guild : guild.id;
            if (!guildId) continue;
            const existing = guildTargetMap.get(guildId) ?? new Set();
            existing.add(target.user_id);
            guildTargetMap.set(guildId, existing);
        }
    }

    // Fallback: for targets with no snapshot data, request from ALL selfbot guilds
    // so new targets get their initial presence without waiting for a profile poll.
    const selfbotGuilds: any[] = client.getGuilds();
    for (const target of targets) {
        const snapshot = stmts.getLatestSnapshot.get(target.user_id) as any;
        if (snapshot?.mutual_guilds) continue; // already covered above

        for (const guild of selfbotGuilds) {
            const guildId: string = typeof guild === "string" ? guild : guild.id;
            if (!guildId) continue;
            const existing = guildTargetMap.get(guildId) ?? new Set();
            existing.add(target.user_id);
            guildTargetMap.set(guildId, existing);
        }
    }

    if (guildTargetMap.size === 0) {
        log.info("No guild data yet — initial presences will arrive via PRESENCE_UPDATE events.");
        return;
    }

    const batches: { guildId: string; userIds: string[] }[] = [];
    for (const [guildId, userIds] of guildTargetMap) {
        const arr = Array.from(userIds);
        for (let i = 0; i < arr.length; i += 100) {
            batches.push({ guildId, userIds: arr.slice(i, i + 100) });
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

// ── Gateway: guild presence subscriptions (op 14) ────────────────────────────
//
// Send GUILD_SUBSCRIBE (op 14) for every guild that contains tracked targets.
// This tells Discord to stream real-time PRESENCE_UPDATE events — including
// offline transitions — for those guilds.  Must be called after READY and
// after RESUMED (Discord drops subscriptions when the session is interrupted).
// Re-called periodically so subscriptions don't silently expire.

let presenceSubscriptionInterval: NodeJS.Timeout | null = null;

function subscribeGuildPresences(client: GatewayClient): void {
    const stmts = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    if (!targets.length) return;

    const guildIds = new Set<string>();

    // Collect all mutual guilds from stored profile snapshots
    for (const target of targets) {
        const snapshot = stmts.getLatestSnapshot.get(target.user_id) as any;
        if (!snapshot?.mutual_guilds) continue;
        try {
            const guilds = JSON.parse(snapshot.mutual_guilds) as any[];
            for (const g of guilds) {
                const id: string | undefined = typeof g === "string" ? g : g.id;
                if (id) guildIds.add(id);
            }
        } catch { /* malformed JSON — skip */ }
    }

    // Fallback: subscribe to all selfbot guilds so targets without a profile
    // snapshot still get their presence streamed on first connect.
    for (const guild of client.getGuilds()) {
        const id: string | undefined = typeof guild === "string" ? guild : guild.id;
        if (id) guildIds.add(id);
    }

    if (!guildIds.size) return;

    // Stagger sends to stay inside the 120 ops/60 s gateway rate limit.
    const ids = Array.from(guildIds);
    const STAGGER_MS = 300;
    ids.forEach((guildId, i) => {
        setTimeout(() => {
            if (client.isConnected()) client.subscribeGuildPresence(guildId);
        }, i * STAGGER_MS);
    });

    log.info(`Subscribed to presence stream for ${ids.length} guild(s) (op 14)`);
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
                    const deleted = handleMessageDelete(data.id, data.channel_id, data.guild_id || null);
                    if (deleted) {
                        evaluateEvent("MESSAGE_DELETE", deleted.targetId, deleted.eventData);
                        pushSSEEvent({
                            target_id:  deleted.targetId,
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
                    // IMPORTANT: Discord only populates data.presences with users who
                    // currently have an ACTIVE (non-offline) status visible in this guild.
                    // Absence from presences does NOT mean the user is offline — they may
                    // be online in a different guild, or have guild-specific presence hidden.
                    // We therefore NEVER force a target to "offline" based on chunk absence.
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
                            // User is confirmed online in this guild — update their state.
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
                            // User is in this chunk's members list but NOT in presences.
                            // For selfbots with GUILD_PRESENCES, absence from presences in a
                            // user_ids-targeted chunk means the user is genuinely offline (or
                            // invisible, which is functionally the same for tracking purposes).
                            const existing = getCurrentPresence(userId);
                            if (!existing) {
                                // First time we've seen this target — initialise as offline.
                                // A real PRESENCE_UPDATE will correct this when they come online.
                                initPresence(userId, { status: "offline", client_status: null });
                                log.debug(`First presence init for ${userId}: offline (awaiting PRESENCE_UPDATE)`);
                            } else if (isActiveStatus(existing.status)) {
                                // Target was active (online/idle/dnd) but is absent from
                                // presences in this targeted chunk → they've gone offline.
                                // Drive through handlePresenceUpdate so the session is closed,
                                // an event is inserted, and SSE + alert engine are notified.
                                // Also flush activities so currentActivities doesn't retain
                                // stale "active" entries after the user goes offline.
                                log.info(`${userId}: absent from GUILD_MEMBERS_CHUNK presences (was ${existing.status}) — marking offline`);
                                handlePresenceUpdate(userId, {
                                    status: "offline",
                                    client_status: {},
                                    activities: [],
                                });
                                handleActivityUpdate(userId, []);
                            }
                            // If already offline or unknown: do nothing.
                        }
                    }
                    break;
                }

                // ── Session resume ─────────────────────────────────────────────
                case "RESUMED": {
                    log.info("Session resumed — re-requesting presences + re-subscribing guilds in 3 s");
                    setTimeout(() => {
                        requestInitialPresences(client);
                        subscribeGuildPresences(client);
                    }, 3_000);
                    break;
                }
            }
        } catch (err: any) {
            log.error(`Error handling ${eventName}: ${err.message}`);
        }
    });

    client.on("ready", (data: any) => {
        const guildCount = data.guilds?.length || 0;
        log.info(`Gateway ready. Guilds: ${guildCount}`);

        setRequestGuildMembersFn((guildId, userIds) =>
            client.requestGuildMembers(guildId, userIds)
        );
        setSelfbotGuildsFn(() => client.getGuilds());

        setTimeout(() => {
            requestInitialPresences(client);
            // Subscribe to presence streams (op 14) so Discord sends PRESENCE_UPDATE
            // events — including offline — for all guilds containing tracked targets.
            subscribeGuildPresences(client);
        }, 2_000);

        // C2 startup notification — only on first READY, not on reconnect re-IDENTIFYs
        if (!startupNotificationSent) {
            startupNotificationSent = true;
            const stmts = getStmts();
            const targets = stmts.getAllTargets.all() as any[];
            const ruleCount = (stmts.getAlertRules.all() as any[]).length;
            notifyStartup({
                guildCount,
                targetCount:       targets.length,
                activeTargetCount: targets.filter((t: any) => t.active).length,
                ruleCount,
                dbMode:            config.dbMode,
            });
        }
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

// ── AI analysis interval ──────────────────────────────────────────────────────

function startAIAnalysisLoop(): NodeJS.Timeout {
    return setInterval(async () => {
        try { await runAllBaselineComputation(); }
        catch (err: any) { log.error(`AI baseline error: ${err.message}`); }
        try { await runAISocialGraphAnalysis(); }
        catch (err: any) { log.error(`AI social graph error: ${err.message}`); }
        try { await runAllCategorization(); }
        catch (err: any) { log.error(`AI categorization error: ${err.message}`); }
    }, config.aiAnalysisIntervalMs);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(): void {
    log.info("Shutting down…");

    if (dailySummaryInterval)        clearInterval(dailySummaryInterval);
    if (voiceParticipantInterval)    clearInterval(voiceParticipantInterval);
    if (heartbeatInterval)           clearInterval(heartbeatInterval);
    if (aiAnalysisInterval)          clearInterval(aiAnalysisInterval);
    if (digestHandle)                clearInterval(digestHandle);
    if (briefHandle)                 clearTimeout(briefHandle);
    if (presenceSubscriptionInterval) clearInterval(presenceSubscriptionInterval);

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

    // Init DB and load runtime config first so any token/key stored in DB
    // is applied before validateConfig() checks for required values.
    initDatabase();
    runMigrations();
    loadRuntimeConfig();

    try {
        validateConfig();
    } catch (err: any) {
        log.error(err.message);
        process.exit(1);
    }

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

    // Re-send op 14 GUILD_SUBSCRIBE every 4 minutes.
    // Discord can silently drop presence subscriptions; periodic renewal ensures
    // we keep receiving PRESENCE_UPDATE (including offline) for all target guilds.
    presenceSubscriptionInterval = setInterval(() => {
        if (gateway?.isConnected()) subscribeGuildPresences(gateway);
    }, 4 * 60 * 1000);

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

            aiAnalysisInterval = startAIAnalysisLoop();
        }, 600_000);
    }

    // ── Runtime config side-effects ────────────────────────────────────────────
    // These callbacks fire whenever the web UI updates a key via PATCH /api/config.

    onConfigChange("DISCORD_TOKEN", () => {
        log.info("DISCORD_TOKEN changed — reconnecting gateway…");
        if (voiceParticipantInterval) { clearInterval(voiceParticipantInterval); voiceParticipantInterval = null; }
        const old = gateway;
        old?.destroy();
        gateway = new GatewayClient();
        setupGatewayHandlers(gateway);
        startVoiceParticipantTracker(gateway);
        gateway.connect().catch(err => log.error(`Gateway reconnect error: ${err.message}`));
    });

    const aiKeys = ["AI_PROVIDER", "AI_MODEL", "AI_API_KEY", "AI_BASE_URL"] as const;
    for (const key of aiKeys) {
        onConfigChange(key, () => resetAIProvider());
    }

    onConfigChange("BRIEF_GENERATION_TIME", () => {
        if (briefHandle) clearTimeout(briefHandle);
        briefHandle = scheduleBriefGeneration();
        log.info("Brief generation rescheduled");
    });

    onConfigChange("ALERT_DIGEST_INTERVAL_MS", () => {
        if (digestHandle) clearInterval(digestHandle);
        digestHandle = startDigestFlusher();
        log.info("Digest flusher rescheduled");
    });

    onConfigChange("AI_ANALYSIS_INTERVAL_MS", () => {
        if (aiAnalysisInterval) {
            clearInterval(aiAnalysisInterval);
            aiAnalysisInterval = startAIAnalysisLoop();
            log.info("AI analysis interval rescheduled");
        }
    });

    log.info("=== Sentinel Fully Operational ===");
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    log.error(err.stack || "");
    notifyCriticalError(err.message, err.stack?.slice(0, 800), "Uncaught Exception");
});
process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error(`Unhandled rejection: ${msg}`);
    notifyCriticalError(msg, undefined, "Unhandled Rejection");
});

main().catch((err) => {
    log.error(`Fatal error: ${err.message}`);
    notifyCriticalError(`Fatal startup error: ${err.message}`, err.stack?.slice(0, 800), "Startup");
    process.exit(1);
});
