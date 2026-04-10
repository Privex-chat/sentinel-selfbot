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
import { setAlertCallback, reloadRules, evaluateEvent } from "./alerts/engine";
import { computeDailySummaries } from "./daily-summary";
import { initSupabaseSync, SupabaseSyncEngine } from "./database/supabase-sync";

const log = createLogger("Sentinel");

let gateway:                GatewayClient | null      = null;
let dailySummaryInterval:   NodeJS.Timeout | null      = null;
let voiceParticipantInterval: NodeJS.Timeout | null    = null;
let heartbeatInterval:      NodeJS.Timeout | null      = null;
let supabaseSync:           SupabaseSyncEngine | null  = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTarget(userId: string): boolean {
    const stmts  = getStmts();
    const target = stmts.getTarget.get(userId) as any;
    return target?.active === 1;
}

/**
 * Write the current timestamp into heartbeat_log every 60 s.
 * On an unclean exit, the most recent entry tells us when the process was last
 * definitely alive, giving us a more accurate close-timestamp for stale sessions.
 */
function startHeartbeatLogger(): void {
    const INTERVAL = 60_000; // 1 minute
    heartbeatInterval = setInterval(() => {
        try {
            const stmts = getStmts();
            stmts.insertHeartbeat.run(Date.now());
            stmts.pruneHeartbeats.run(); // keep the table small
        } catch { /* non-fatal */ }
    }, INTERVAL);
    log.info("Heartbeat logger started (60 s interval)");
}

/**
 * Close any sessions that are still open from a previous run.
 *
 * In a clean shutdown these are already closed.  After a crash or force-kill
 * we fall back to the last heartbeat timestamp (most accurate) or, if the
 * heartbeat log is empty, to the current time.
 */
function closeStaleOpenSessions(): void {
    const db  = getDb();
    const now = Date.now();

    // Prefer the last heartbeat timestamp — it reflects when the process was
    // last alive rather than the (potentially much later) restart time.
    let closeAt = now;
    try {
        const stmts = getStmts();
        const row   = stmts.getLastHeartbeat.get() as { timestamp: number } | undefined;
        if (row?.timestamp && row.timestamp < now) {
            closeAt = row.timestamp;
            log.info(`Using last heartbeat timestamp for stale session close: ${new Date(closeAt).toISOString()}`);
        }
    } catch { /* heartbeat_log may not exist on very first run */ }

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

    // Batch up to 100 user-ids per guild, then stagger each batch 600 ms apart
    // to stay well inside the 120 ops / 60 s gateway rate limit.
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
                case "PRESENCE_UPDATE": {
                    const userId = data.user?.id;
                    if (!userId || !isTarget(userId)) break;
                    handlePresenceUpdate(userId, data);
                    if (data.activities) handleActivityUpdate(userId, data.activities);
                    pushEvent(userId, "PRESENCE_UPDATE", data);
                    break;
                }

                // ── Messages ───────────────────────────────────────────────────
                case "MESSAGE_CREATE": {
                    const authorId = data.author?.id;
                    if (!authorId || !isTarget(authorId)) break;
                    if (data.author.bot) break;
                    handleMessageCreate(authorId, data, data.guild_id || null);
                    pushEvent(authorId, "MESSAGE_CREATE", data);
                    break;
                }

                case "MESSAGE_UPDATE": {
                    const authorId = data.author?.id;
                    if (!authorId || !isTarget(authorId)) break;
                    handleMessageUpdate(authorId, data, data.guild_id || null);
                    pushEvent(authorId, "MESSAGE_UPDATE", data);
                    break;
                }

                case "MESSAGE_DELETE": {
                    handleMessageDelete(data.id, data.channel_id, data.guild_id || null);
                    break;
                }

                // ── Typing ─────────────────────────────────────────────────────
                case "TYPING_START": {
                    const userId = data.user_id;
                    if (!userId || !isTarget(userId)) break;
                    handleTypingStart(userId, data.channel_id, data.guild_id || null);
                    pushEvent(userId, "TYPING_START", data);
                    break;
                }

                // ── Voice ──────────────────────────────────────────────────────
                case "VOICE_STATE_UPDATE": {
                    const userId = data.user_id;
                    if (!userId || !isTarget(userId)) break;
                    handleVoiceStateUpdate(userId, data);
                    pushEvent(userId, "VOICE_STATE_UPDATE", data);
                    break;
                }

                // ── Profile ────────────────────────────────────────────────────
                case "USER_UPDATE": {
                    const userId = data.id;
                    if (!userId || !isTarget(userId)) break;
                    handleProfileUpdate(userId, data);
                    pushEvent(userId, "USER_UPDATE", data);
                    break;
                }

                case "GUILD_MEMBER_UPDATE": {
                    const userId = data.user?.id;
                    if (!userId || !isTarget(userId)) break;
                    handleGuildMemberUpdate(userId, data.guild_id, data);
                    pushEvent(userId, "GUILD_MEMBER_UPDATE", data);
                    break;
                }

                // ── Reactions ──────────────────────────────────────────────────
                case "MESSAGE_REACTION_ADD": {
                    const userId = data.user_id;
                    if (!userId || !isTarget(userId)) break;
                    handleReactionAdd(
                        userId, data.message_id,
                        data.message_author_id || null,
                        data.channel_id, data.guild_id || null,
                        data.emoji
                    );
                    pushEvent(userId, "MESSAGE_REACTION_ADD", data);
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
                    pushEvent(userId, "MESSAGE_REACTION_REMOVE", data);
                    break;
                }

                // ── DM detection ───────────────────────────────────────────────
                case "CHANNEL_CREATE": {
                    handleChannelCreate(data, isTarget);
                    break;
                }

                // ── Guild members chunk ────────────────────────────────────────
                // This is the response to REQUEST_GUILD_MEMBERS.
                //
                // KEY FIX: Discord only includes *non-offline* users in the
                // `presences` array.  Users present in `members` but absent
                // from `presences` are therefore offline.  We must handle both
                // cases explicitly so stale "online" state is cleared.
                case "GUILD_MEMBERS_CHUNK": {
                    // Build a fast lookup: userId → presence data
                    const presenceMap = new Map<string, any>();
                    for (const presence of data.presences || []) {
                        const uid: string | undefined = presence.user?.id;
                        if (uid) presenceMap.set(uid, presence);
                    }

                    for (const member of data.members || []) {
                        const userId: string | undefined = member.user?.id;
                        if (!userId || !isTarget(userId)) continue;

                        // Always keep profile snapshot up-to-date
                        if (member.user) handleProfileUpdate(userId, member.user);

                        const presence = presenceMap.get(userId);

                        if (presence) {
                            // ── User is online / idle / dnd ───────────────────
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
                            // ── User absent from presences → offline ──────────
                            // Discord omits offline users from the presences
                            // array, so absence is authoritative evidence of
                            // an offline state.
                            const existing = getCurrentPresence(userId);
                            if (!existing) {
                                // First time we see this target — record offline
                                initPresence(userId, { status: "offline", client_status: null });
                                log.info(`Initialised presence for ${userId}: offline (not in chunk)`);
                            } else if (existing.status !== "offline") {
                                // Was previously tracked as active — correct it
                                log.info(
                                    `${userId}: absent from guild chunk presences — ` +
                                    `correcting ${existing.status} → offline`
                                );
                                handlePresenceUpdate(userId, { status: "offline", client_status: null });
                                // Close any open activities (Spotify, games, etc.)
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

        // Give the gateway 2 s to settle before flooding it with member requests
        setTimeout(() => requestInitialPresences(client), 2_000);
    });
}

// ── SSE + alert forwarding ────────────────────────────────────────────────────

function pushEvent(targetId: string, eventType: string, data: any): void {
    const event = {
        target_id:  targetId,
        event_type: eventType,
        timestamp:  Date.now(),
        data,
    };
    pushSSEEvent(event);
    evaluateEvent(eventType, targetId, JSON.stringify(data));
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

    if (dailySummaryInterval)    clearInterval(dailySummaryInterval);
    if (voiceParticipantInterval) clearInterval(voiceParticipantInterval);
    if (heartbeatInterval)       clearInterval(heartbeatInterval);

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

    // Cloud mode: hydrate SQLite from Supabase before anything else
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

    // Supabase sync
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

    // Heartbeat logger — must start after DB is initialised
    startHeartbeatLogger();

    // Gateway
    gateway = new GatewayClient();
    setupGatewayHandlers(gateway);
    await gateway.connect();

    // Pollers
    startProfilePoller();
    startStatusPoller();
    startMutualServersPoller();
    startConnectedAccountsPoller();

    startVoiceParticipantTracker(gateway);

    // Daily summaries
    dailySummaryInterval = setInterval(() => {
        try { computeDailySummaries(); }
        catch (err: any) { log.error(`Daily summary error: ${err.message}`); }
    }, withJitter(config.dailySummaryIntervalMs));

    // Run first summary after 2 minutes
    setTimeout(() => {
        try { computeDailySummaries(); } catch { /* non-fatal */ }
    }, 120_000);

    log.info("=== Sentinel Fully Operational ===");
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    log.error(err.stack || "");
});
process.on("unhandledRejection", (reason) => {
    log.error(`Unhandled rejection: ${reason}`);
});

main().catch((err) => {
    log.error(`Fatal error: ${err.message}`);
    process.exit(1);
});