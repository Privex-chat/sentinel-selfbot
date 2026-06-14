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
import { handleTypingStart, cancelAllPendingTyping } from "./collectors/typing";
import {
    handleVoiceStateUpdate, updateCoParticipants, getCurrentVoiceState,
    reconcileOpenVoiceSessions,
} from "./collectors/voice";
import { handleProfileUpdate } from "./collectors/profile";
import { handleReactionAdd, handleReactionRemove } from "./collectors/reaction";
import { handleSelfCommand, setGatewayRef } from "./commands/handler";
import { handleGuildMemberUpdate } from "./collectors/guild-member";
import { handleChannelCreate } from "./collectors/dm-detection";
import { startTargetProfilePoller, stopTargetProfilePoller } from "./pollers/target-profile-poller";
import {
    startStatusPoller, stopStatusPoller, setRequestGuildMembersFn,
    setSelfbotGuildsFn, setSubscribePresenceFn,
} from "./pollers/status-poller";
import { startApiServer, setGatewayHealthFn } from "./api/server";
import { pushSSEEvent } from "./api/routes/events";
import { setAlertCallback, reloadRules, evaluateEvent, resetAlertFireCounts } from "./alerts/engine";
import { computeDailySummaries } from "./daily-summary";
import { initSupabaseSync, SupabaseSyncEngine } from "./database/supabase-sync";
import { runAISocialGraphAnalysis } from "./analyzers/social-graph-ai";
import { runAllCategorization } from "./categorization/categorizer";
import { runAllBaselineComputation } from "./analyzers/baseline";
import { scheduleBriefGeneration, cancelBriefGeneration } from "./briefs/brief-generator";
import { startBackfillOnStartup } from "./backfill/backfill-engine";
import { startDigestFlusher } from "./alerts/digest";
import { notifyStartup, notifyCriticalError } from "./utils/webhook-notifier";
import { loadRuntimeConfig, onConfigChange } from "./runtime-config";
import { resetAIProvider } from "./ai/provider";
import { isTargetCached, refreshTargetCache } from "./target-lifecycle";
import { hasDataKey } from "./utils/crypto";

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

// Active-target gate for the gateway dispatch handler. Backed by an in-memory
// Set refreshed on every mutation site — avoids hitting SQLite once per event
// per active rule. See target-lifecycle.ts for the cache + refresh policy.
const isTarget = isTargetCached;

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

/**
 * Sweep any session that's been left open longer than 48 h and cap its end_time
 * at start_time + 48 h. Runs periodically (alongside daily summaries) so
 * abandoned sessions don't accumulate between restarts.
 *
 * 48 h is wide enough that any plausible real human session — even an
 * always-online phone presence — stays untouched. Anything that crosses it is
 * almost always the result of a missed close event (gateway disconnect, voice
 * subsystem race) rather than a real continuous presence.
 *
 * Uses a fixed cap (not "now") so the bounded session doesn't grow each tick.
 */
function closeAbandonedOpenSessions(): void {
    const db = getDb();
    const ABANDON_AGE_MS = 48 * 60 * 60 * 1000;
    const cutoff = Date.now() - ABANDON_AGE_MS;

    // For each table, set end_time = start_time + ABANDON_AGE_MS (so duration is
    // bounded), guarded by start_time < cutoff so only old open sessions match.
    const presence = db
        .prepare(
            "UPDATE presence_sessions  SET end_time = start_time + ?, duration_ms = ? " +
            "WHERE end_time IS NULL AND start_time < ?"
        )
        .run(ABANDON_AGE_MS, ABANDON_AGE_MS, cutoff).changes;

    const activity = db
        .prepare(
            "UPDATE activity_sessions  SET end_time = start_time + ?, duration_ms = ? " +
            "WHERE end_time IS NULL AND start_time < ?"
        )
        .run(ABANDON_AGE_MS, ABANDON_AGE_MS, cutoff).changes;

    const voice = db
        .prepare(
            "UPDATE voice_sessions     SET end_time = start_time + ?, duration_ms = ? " +
            "WHERE end_time IS NULL AND start_time < ?"
        )
        .run(ABANDON_AGE_MS, ABANDON_AGE_MS, cutoff).changes;

    if (presence + activity + voice > 0) {
        log.warn(
            `Abandoned-session sweep capped ${presence} presence, ${activity} activity, ` +
            `${voice} voice session(s) at ${ABANDON_AGE_MS / 3_600_000} h. ` +
            `Most likely cause: missed close events during a gateway disconnect.`
        );
    }
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
    const stmts = getStmts();
    // Single query returns (user_id, mutual_guilds-or-null) per active target.
    // Replaces the previous 2×N+1 loop that called getLatestSnapshot per target,
    // twice (once for the primary pass, once for the fallback pass).
    const rows = stmts.getActiveTargetsWithMutualGuilds.all() as Array<{ user_id: string; mutual_guilds: string | null }>;
    if (rows.length === 0) return;

    const guildTargetMap = new Map<string, Set<string>>();
    const selfbotGuilds = client.getGuilds();

    for (const row of rows) {
        let guilds: any[] | null = null;
        if (row.mutual_guilds) {
            try { guilds = JSON.parse(row.mutual_guilds); } catch { /* malformed — fall through */ }
        }

        // Primary: per-target mutual guild list, if we have it.
        // Fallback: every selfbot guild, so newly-added targets without snapshot
        // data still get an initial presence request.
        const source: any[] = (guilds && guilds.length > 0) ? guilds : selfbotGuilds;

        for (const guild of source) {
            const guildId: string = typeof guild === "string" ? guild : guild?.id;
            if (!guildId) continue;
            const existing = guildTargetMap.get(guildId) ?? new Set();
            existing.add(row.user_id);
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
        `Requesting initial presences: ${batches.length} batch(es) for ${rows.length} target(s)` +
        ` — staggered over ${(batches.length * STAGGER_MS / 1000).toFixed(1)}s`
    );

    batches.forEach(({ guildId, userIds }, i) => {
        client.requestGuildMembers(guildId, userIds, i * STAGGER_MS);
    });
}

// ── Gateway: guild presence subscriptions (op 14) ────────────────────────────
//
// Send GUILD_SUBSCRIBE (op 14) for every guild that contains tracked targets,
// including the target user IDs in the `members` field.
//
// The `members` field is the critical detail: without it, Discord only pushes
// PRESENCE_UPDATE for users visible in the member list sidebar, which silently
// drops offline transitions for most targets. With it, Discord tracks those
// exact user IDs and delivers every status change — including going offline —
// in real time, regardless of guild size. This is the event-driven alternative
// to periodic REQUEST_GUILD_MEMBERS polling.
//
// Must be called after READY and after RESUMED (subscriptions are dropped on
// session interruption). Re-called periodically so they don't silently expire.

let presenceSubscriptionInterval: NodeJS.Timeout | null = null;

function subscribeGuildPresences(client: GatewayClient): void {
    const stmts = getStmts();
    // Same single-query optimisation as requestInitialPresences. Returns one row
    // per active target; mutual_guilds may be null when no snapshot exists.
    const rows = stmts.getActiveTargetsWithMutualGuilds.all() as Array<{ user_id: string; mutual_guilds: string | null }>;
    if (!rows.length) return;

    // Build guild → Set<userId> so each op 14 carries the right member list.
    const guildMembers = new Map<string, Set<string>>();

    for (const row of rows) {
        if (!row.mutual_guilds) continue;
        try {
            const guilds = JSON.parse(row.mutual_guilds) as any[];
            for (const g of guilds) {
                const id: string | undefined = typeof g === "string" ? g : g.id;
                if (!id) continue;
                const set = guildMembers.get(id) ?? new Set<string>();
                set.add(row.user_id);
                guildMembers.set(id, set);
            }
        } catch { /* malformed JSON — skip */ }
    }

    // Also subscribe to every selfbot guild so new targets (before their first
    // profile poll) still get real-time presence via the guild-level stream.
    for (const guild of client.getGuilds()) {
        const id: string | undefined = typeof guild === "string" ? guild : guild.id;
        if (!id) continue;
        if (!guildMembers.has(id)) guildMembers.set(id, new Set<string>());
    }

    if (!guildMembers.size) return;

    // Stagger sends to stay within the 120 ops/60 s gateway rate limit.
    const STAGGER_MS = 300;
    let i = 0;
    for (const [guildId, memberSet] of guildMembers) {
        const memberIds = Array.from(memberSet);
        const delay = i++ * STAGGER_MS;
        setTimeout(() => {
            if (client.isConnected()) client.subscribeGuildPresence(guildId, memberIds);
        }, delay);
    }

    log.info(
        `Subscribed to presence stream for ${guildMembers.size} guild(s), ` +
        `tracking ${rows.length} target(s) via op 14 member push`
    );
}

// ── Gateway: event handler ────────────────────────────────────────────────────

function setupGatewayHandlers(client: GatewayClient): void {
    client.on("dispatch", async (eventName: string, data: any) => {
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
                    // Self-commands ($add, $remove, $status, $list, $help).
                    // Must run before the isTarget guard — the selfbot's own
                    // account is never in the targets list.
                    const selfUser = client.getUser();
                    if (selfUser?.id && data.author?.id === selfUser.id) {
                        const handled = await handleSelfCommand(selfUser.id, data);
                        if (handled) break;
                    }

                    const authorId = data.author?.id;
                    if (!authorId || !isTarget(authorId)) break;
                    if (data.author.bot) break;
                    log.info(`MESSAGE_CREATE from tracked target ${authorId} in guild ${data.guild_id || "DM"}`);
                    const msgResult = handleMessageCreate(authorId, data, data.guild_id || null, "live");
                    // Duplicate live MESSAGE_CREATE (collector saw the same id twice during
                    // reconnect, or backfill already stored it). Skip alert eval + SSE so
                    // the dashboard live feed doesn't double-display and webhooks don't
                    // double-fire.
                    if (!msgResult.inserted) break;
                    evaluateEvent("MESSAGE_CREATE", authorId, msgResult.eventData);
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
                    // Discord only includes users in data.presences if they have an
                    // ACTIVE (non-offline) status visible in that specific guild.
                    //
                    // Absence from presences does NOT reliably mean the user is offline:
                    // - A user may be visible in guild A's presences but not guild B's,
                    //   depending on guild-specific presence visibility.
                    // - The status poller queries multiple guilds; treating absence in any
                    //   one chunk as "offline" causes rapid false oscillation (DND → offline
                    //   → DND → offline every poll cycle).
                    //
                    // Offline transitions are handled exclusively by PRESENCE_UPDATE events
                    // delivered via op 14 (GUILD_SUBSCRIBE) subscriptions, which are
                    // re-sent every 4 minutes and on every reconnect/resume.
                    //
                    // Chunks are used here ONLY for:
                    //   1. Initial presence discovery (!existing) — safe because we have
                    //      no prior state to contradict.
                    //   2. Confirming / updating online status when a user IS in presences.
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
                            // User confirmed online in this guild — update state.
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
                            // User absent from this chunk's presences.
                            // Only act on this for initial discovery (no existing state).
                            // For known users, do nothing — see comment above.
                            const existing = getCurrentPresence(userId);
                            if (!existing) {
                                initPresence(userId, { status: "offline", client_status: null });
                                log.debug(`First presence init for ${userId}: offline (awaiting PRESENCE_UPDATE)`);
                            }
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
                    // Voice sessions whose targets are cached as offline get
                    // closed: Discord disconnects offline users from voice but
                    // we never saw the VOICE_STATE_UPDATE during the disconnect.
                    // Done immediately (not behind the 3s timeout) since it's
                    // a pure DB+cache operation and doesn't touch Discord.
                    try { reconcileOpenVoiceSessions(getCurrentPresence); }
                    catch (err: any) { log.warn(`Voice reconcile on RESUMED failed: ${err.message}`); }
                    break;
                }
            }
        } catch (err: any) {
            log.error(`Error handling ${eventName}: ${err.message}`);
        }
    });

    // When the gateway socket closes (reconnect, transient network, server
    // requested) the in-memory pending-typing timers should be cleared so they
    // don't fire ghost-type events for messages we never had a chance to see.
    client.on("close", () => {
        try { cancelAllPendingTyping(); }
        catch (err: any) { log.warn(`cancelAllPendingTyping on close: ${err.message}`); }
    });

    client.on("ready", (data: any) => {
        const guildCount = data.guilds?.length || 0;
        log.info(`Gateway ready. Guilds: ${guildCount}`);

        setRequestGuildMembersFn((guildId, userIds) =>
            client.requestGuildMembers(guildId, userIds)
        );
        setSubscribePresenceFn((guildId, memberIds) =>
            client.subscribeGuildPresence(guildId, memberIds)
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
    cancelBriefGeneration();
    if (presenceSubscriptionInterval) clearInterval(presenceSubscriptionInterval);

    stopTargetProfilePoller();
    stopStatusPoller();

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

    // Loud warning: in cloud / local+cloud mode, any sensitive runtime_config
    // values (Discord token, AI key, Supabase service key, webhook URLs) end
    // up in Supabase. Without SENTINEL_DATA_KEY they go in plaintext.
    if (
        (config.dbMode === "cloud" || config.dbMode === "local+cloud") &&
        !hasDataKey()
    ) {
        log.warn(
            "DB_MODE=" + config.dbMode + " is configured but SENTINEL_DATA_KEY is not set. " +
            "Sensitive runtime_config values will be stored as PLAINTEXT in both SQLite and Supabase. " +
            "Generate a key with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
        );
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
    // Prime the active-target cache after any hydration / stale-session sweep
    // so the gateway dispatch handler is correct from the very first event.
    refreshTargetCache();

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
    setGatewayRef(gateway);
    // /health reflects gateway connectivity. Capture via closure so a token
    // rotation (which reassigns `gateway`) is picked up automatically.
    setGatewayHealthFn(() => gateway?.isConnected() ?? false);
    setupGatewayHandlers(gateway);
    await gateway.connect();

    startTargetProfilePoller();
    startStatusPoller();

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
        try { closeAbandonedOpenSessions(); }
        catch (err: any) { log.error(`Abandoned-session sweep error: ${err.message}`); }
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
        setGatewayRef(gateway);
        setupGatewayHandlers(gateway);
        startVoiceParticipantTracker(gateway);
        gateway.connect().catch(err => log.error(`Gateway reconnect error: ${err.message}`));
    });

    const aiKeys = ["AI_PROVIDER", "AI_MODEL", "AI_API_KEY", "AI_BASE_URL"] as const;
    for (const key of aiKeys) {
        onConfigChange(key, () => resetAIProvider());
    }

    onConfigChange("BRIEF_GENERATION_TIME", () => {
        // Cancel the *entire* timeout chain, not just the first arm. The old
        // implementation only cleared the outer handle and the inner re-arm
        // kept firing, duplicating daily briefs (and AI cost) after every
        // reschedule.
        cancelBriefGeneration();
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
