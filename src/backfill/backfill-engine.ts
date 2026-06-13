import { createLogger } from "../utils/logger";
import { getDb } from "../database/connection";
import { getStmts } from "../database/queries";
import { config } from "../utils/config";
import { discordFetch } from "../utils/rate-limiter";
import { jitterSleep } from "../utils/jitter";
import { handleMessageCreate } from "../collectors/message";
import { handleProfileUpdate } from "../collectors/profile";

const log = createLogger("BackfillEngine");

// How long to wait between fetching pages of 100 messages within a single channel.
// High enough that the sustained-throughput signature does not look like an
// automated scraper. Jitter (±30 %) is layered on top. Previously 2 500 ms but
// raised to 5 000 ms because backfill is the longest-lived sustained-request
// path in the bot — Discord's abuse heuristics weight sustained throughput
// heavily, so the floor is the lever that matters most here.
const BACKFILL_PAGE_DELAY_MS = 5_000;

// How long to wait after finishing one channel before starting the next one
// within the same guild. Gives Discord's abuse detection nothing to latch onto.
const INTER_CHANNEL_DELAY_MS = 5_000;

// How long to wait after finishing one guild before starting the next one.
const INTER_GUILD_DELAY_MS = 20_000;

// Only one target backfill may run at a time. Running multiple concurrently
// multiplies the request rate, which is the primary trigger for account flags.
const MAX_CONCURRENT_TARGETS = 1;

// Track which targets are currently being backfilled
const activeBackfills = new Set<string>();

// Simple FIFO queue — prevents multiple setTimeout chains when several targets
// request a backfill while one is already running.
const backfillQueue: string[] = [];
let queueDraining = false;

// Paused flag per target
const pausedTargets = new Set<string>();

// ── Queue management ──────────────────────────────────────────────────────────

async function drainQueue(): Promise<void> {
    if (queueDraining) return;
    queueDraining = true;

    while (backfillQueue.length > 0) {
        if (activeBackfills.size >= MAX_CONCURRENT_TARGETS) {
            // Wait until the active backfill finishes rather than busy-polling.
            await new Promise<void>(resolve => setTimeout(resolve, 30_000));
            continue;
        }

        const targetId = backfillQueue.shift()!;
        if (activeBackfills.has(targetId)) continue; // already running somehow

        activeBackfills.add(targetId);
        try {
            await runBackfillForTarget(targetId);
        } catch (err: any) {
            log.error(`Backfill error for ${targetId}: ${err.message}`);
        } finally {
            activeBackfills.delete(targetId);
        }

        // Brief pause between targets so there's no immediate burst when the
        // queue has multiple entries (e.g. startup with several new targets).
        if (backfillQueue.length > 0) {
            await jitterSleep(INTER_GUILD_DELAY_MS, 30);
        }
    }

    queueDraining = false;
}

// ── Profile fetch helper ──────────────────────────────────────────────────────

async function fetchAndStoreProfile(targetId: string): Promise<any[] | null> {
    log.info(`Fetching Discord profile for ${targetId}`);
    try {
        const res = await discordFetch(
            `/users/${targetId}/profile?with_mutual_guilds=true&with_mutual_friends_count=false`,
            config.discordToken
        );

        if (res.status === 404) {
            // 404 = selfbot shares no mutual servers with this user.
            // Fall back to the basic user endpoint so we at least store
            // username / avatar. Return [] (not null) so the caller knows the
            // user exists but has no guilds to backfill (not a hard failure).
            log.info(`Profile endpoint 404 for ${targetId} — no mutual servers. Storing basic user info.`);
            try {
                const basicRes = await discordFetch(`/users/${targetId}`, config.discordToken);
                if (basicRes.ok) {
                    const basicData = await basicRes.json() as any;
                    handleProfileUpdate(targetId, basicData, undefined, undefined, undefined);
                } else {
                    log.warn(`Failed to fetch basic user info for ${targetId}: ${basicRes.status}`);
                }
            } catch (basicErr: any) {
                log.warn(`Basic user fetch error for ${targetId}: ${basicErr.message}`);
            }
            return []; // empty = no guilds to backfill, not an error
        }

        if (!res.ok) {
            log.warn(`Failed to fetch profile for ${targetId}: HTTP ${res.status}`);
            return null; // null = hard failure
        }

        const data = await res.json() as any;

        handleProfileUpdate(
            targetId,
            data.user,
            data.user_profile,
            data.connected_accounts,
            data.mutual_guilds
        );

        const guilds: any[] = data.mutual_guilds || [];
        log.info(`Fetched profile for ${targetId}: ${guilds.length} mutual guild(s)`);
        return guilds;
    } catch (err: any) {
        log.error(`Profile fetch error for ${targetId}: ${err.message}`);
        return null;
    }
}

// ── Channel processing ────────────────────────────────────────────────────────

async function processChannel(
    targetId: string,
    channelId: string,
    guildId: string
): Promise<void> {
    const stmts = getStmts();
    const now = Date.now();
    const oldestAllowed = now - config.backfillMaxDays * 86_400_000;

    let cursor: string | null = null;
    let messagesFound = 0;
    let oldestMessageId: string | null = null;

    // Read existing cursor BEFORE marking in_progress — the update nulls oldest_message_id
    const existing = getDb().prepare(
        "SELECT oldest_message_id FROM backfill_progress WHERE target_id = ? AND channel_id = ?"
    ).get(targetId, channelId) as any;
    if (existing?.oldest_message_id) cursor = existing.oldest_message_id;

    // Mark in_progress, preserving cursor so the row stays resumable if the process dies
    stmts.updateBackfillProgress.run(
        "in_progress", 0, cursor, now, null, null,
        targetId, channelId
    );

    try {
        while (true) {
            if (pausedTargets.has(targetId)) {
                log.info(`Backfill paused for ${targetId}`);
                stmts.updateBackfillProgress.run(
                    "paused", messagesFound, oldestMessageId, now, null, null,
                    targetId, channelId
                );
                return;
            }

            let url = `/channels/${channelId}/messages?limit=100`;
            if (cursor) url += `&before=${cursor}`;

            const res = await discordFetch(url, config.discordToken);

            if (res.status === 403 || res.status === 404) {
                stmts.updateBackfillProgress.run(
                    "skipped", messagesFound, oldestMessageId, now, now, null,
                    targetId, channelId
                );
                log.debug(`Backfill skipped channel ${channelId} (${res.status})`);
                return;
            }

            if (!res.ok) {
                throw new Error(`HTTP ${res.status} on channel ${channelId}`);
            }

            const messages = await res.json() as any[];
            if (!messages.length) break;

            // Filter to target's messages and insert (source='backfilled' suppresses alert evaluation)
            for (const msg of messages) {
                if (msg.author?.id === targetId) {
                    handleMessageCreate(targetId, msg, guildId, "backfilled");
                    messagesFound++;
                }
            }

            const oldest = messages[messages.length - 1];
            oldestMessageId = oldest.id;
            cursor = oldest.id;

            // Update progress
            stmts.updateBackfillProgress.run(
                "in_progress", messagesFound, oldestMessageId, now, null, null,
                targetId, channelId
            );

            // Check termination conditions
            const oldestTs = new Date(oldest.timestamp).getTime();
            if (
                messages.length < 100 ||
                oldestTs < oldestAllowed ||
                messagesFound >= config.backfillMaxMsgsPerChannel
            ) {
                break;
            }

            // Wait between pages — this is the main loop that hammers the API,
            // so a generous delay with jitter is critical for avoiding flags.
            await jitterSleep(BACKFILL_PAGE_DELAY_MS, 30);
        }

        stmts.updateBackfillProgress.run(
            "completed", messagesFound, oldestMessageId, now, Date.now(), null,
            targetId, channelId
        );
        log.debug(`Backfill channel ${channelId}: ${messagesFound} messages found`);

    } catch (err: any) {
        stmts.updateBackfillProgress.run(
            "failed", messagesFound, oldestMessageId, now, Date.now(), err.message,
            targetId, channelId
        );
        log.error(`Backfill channel ${channelId} error: ${err.message}`);
    }
}

// ── Guild processing ──────────────────────────────────────────────────────────

async function processGuild(targetId: string, guildId: string): Promise<void> {
    try {
        const res = await discordFetch(
            `/guilds/${guildId}/channels`,
            config.discordToken
        );

        if (!res.ok) {
            log.warn(`Cannot fetch channels for guild ${guildId}: ${res.status}`);
            return;
        }

        const channels = await res.json() as any[];
        const textChannels = channels.filter(
            c => c.type === 0 || c.type === 11 // text + thread
        );

        const stmts = getStmts();
        for (const ch of textChannels) {
            stmts.insertBackfillProgress.run(targetId, guildId, ch.id);
        }

        log.debug(`Guild ${guildId}: queued ${textChannels.length} channels for ${targetId}`);

        // Process channels sequentially with a delay between each.
        // Concurrent channel reads are the pattern that looks most like a
        // scraper — sequential reads with pauses look like a human scrolling.
        for (let i = 0; i < textChannels.length; i++) {
            if (pausedTargets.has(targetId)) break;
            await processChannel(targetId, textChannels[i].id, guildId);

            // Pause between channels (skip after the last one)
            if (i < textChannels.length - 1 && !pausedTargets.has(targetId)) {
                await jitterSleep(INTER_CHANNEL_DELAY_MS, 30);
            }
        }

    } catch (err: any) {
        log.error(`Guild ${guildId} backfill error: ${err.message}`);
    }
}

// ── Core backfill runner (used by both queue and custom) ──────────────────────

async function runBackfillForTarget(targetId: string): Promise<void> {
    log.info(`Starting backfill for ${targetId}`);

    const stmts = getStmts();

    // Try to get mutual guilds from the latest profile snapshot
    let mutualGuilds: any[] = [];
    const snapshot = stmts.getLatestSnapshot.get(targetId) as any;

    if (snapshot?.mutual_guilds) {
        try { mutualGuilds = JSON.parse(snapshot.mutual_guilds); } catch { }
    }

    // No snapshot or snapshot has no mutual guilds — fetch profile inline
    if (!mutualGuilds.length) {
        const fetched = await fetchAndStoreProfile(targetId);
        if (fetched === null) {
            log.warn(`Could not obtain profile for ${targetId}, skipping backfill`);
            return;
        }
        mutualGuilds = fetched;
    }

    if (!mutualGuilds.length) {
        log.info(`No mutual guilds found for ${targetId} — selfbot shares no servers with this user. Backfill skipped.`);
        return;
    }

    const guildIds = mutualGuilds
        .map((g: any) => (typeof g === "string" ? g : g.id))
        .filter(Boolean) as string[];

    if (!guildIds.length) {
        log.warn(`No valid guild IDs extracted for ${targetId}`);
        return;
    }

    log.info(`Backfilling ${targetId} across ${guildIds.length} mutual guild(s) — sequential, one at a time`);

    // Process guilds one at a time. Concurrent guild reads multiply the request
    // rate and are a reliable trigger for Discord's automation detection.
    for (let i = 0; i < guildIds.length; i++) {
        if (pausedTargets.has(targetId)) break;
        await processGuild(targetId, guildIds[i]);

        // Pause between guilds (skip after the last one)
        if (i < guildIds.length - 1 && !pausedTargets.has(targetId)) {
            log.debug(`Waiting ${INTER_GUILD_DELAY_MS}ms before next guild for ${targetId}`);
            await jitterSleep(INTER_GUILD_DELAY_MS, 30);
        }
    }

    log.info(`Backfill complete for ${targetId}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startBackfillForTarget(targetId: string): Promise<void> {
    if (!config.backfillEnabled) {
        log.debug(`Backfill disabled, skipping ${targetId}`);
        return;
    }

    if (activeBackfills.has(targetId)) {
        log.debug(`Backfill already running for ${targetId}`);
        return;
    }

    if (backfillQueue.includes(targetId)) {
        log.debug(`Backfill already queued for ${targetId}`);
        return;
    }

    backfillQueue.push(targetId);
    drainQueue(); // fire-and-forget; drainQueue is reentrant-safe
}

// ── Custom / forced backfill ──────────────────────────────────────────────────

export type BackfillMode = "new_channels" | "full_reset";

/**
 * Trigger a backfill with explicit control over what gets re-run.
 *
 * new_channels — Always re-fetches the Discord profile (picks up newly joined
 *                mutual servers). Adds any guild/channel rows that aren't already
 *                tracked. Existing completed/failed channels are left as-is so
 *                only genuinely new channels are processed.
 *
 * full_reset   — Re-fetches the Discord profile, then resets EVERY channel row
 *                for this target back to pending (clears cursors and counters),
 *                and rescans everything from scratch.
 */
export async function customBackfillForTarget(
    targetId: string,
    mode: BackfillMode
): Promise<void> {
    if (!config.backfillEnabled) {
        log.info(`Backfill disabled globally — custom backfill skipped for ${targetId}`);
        return;
    }

    if (activeBackfills.has(targetId)) {
        log.warn(`Backfill already running for ${targetId} — cannot start custom job`);
        throw new Error("A backfill is already running for this target");
    }

    if (backfillQueue.includes(targetId)) {
        log.warn(`Backfill already queued for ${targetId} — cannot start custom job`);
        throw new Error("A backfill is already queued for this target");
    }

    resumeBackfill(targetId);
    activeBackfills.add(targetId);
    log.info(`Custom backfill (${mode}) started for ${targetId}`);

    try {
        const stmts = getStmts();

        // Always re-fetch the profile so newly joined mutual servers are included.
        const freshGuilds = await fetchAndStoreProfile(targetId);
        if (freshGuilds === null) {
            throw new Error("Could not fetch Discord profile — no mutual servers available");
        }

        const allGuildIds = freshGuilds
            .map((g: any) => (typeof g === "string" ? g : g.id))
            .filter(Boolean) as string[];

        if (!allGuildIds.length) {
            log.info(`No mutual guilds for ${targetId} — selfbot shares no servers with this user. Custom backfill skipped.`);
            return;
        }

        if (mode === "full_reset") {
            // Wipe all existing progress rows so every channel is rescanned from the top.
            stmts.resetAllBackfillForTarget.run(targetId);
            log.info(`full_reset: cleared all backfill rows for ${targetId}`);
        } else {
            // new_channels: figure out which guilds aren't tracked yet.
            const knownRows = stmts.getKnownGuildsForTarget.all(targetId) as { guild_id: string }[];
            const knownGuildIds = new Set(knownRows.map(r => r.guild_id));
            const newGuildIds = allGuildIds.filter(id => !knownGuildIds.has(id));

            if (!newGuildIds.length) {
                log.info(`new_channels: no new guilds found for ${targetId} — nothing to add`);
                return;
            }

            log.info(`new_channels: ${newGuildIds.length} new guild(s) for ${targetId}: ${newGuildIds.join(", ")}`);

            for (let i = 0; i < newGuildIds.length; i++) {
                if (pausedTargets.has(targetId)) break;
                await processGuild(targetId, newGuildIds[i]);

                if (i < newGuildIds.length - 1 && !pausedTargets.has(targetId)) {
                    await jitterSleep(INTER_GUILD_DELAY_MS, 30);
                }
            }
            log.info(`Custom backfill (new_channels) complete for ${targetId}`);
            return;
        }

        // full_reset path: process every guild sequentially.
        for (let i = 0; i < allGuildIds.length; i++) {
            if (pausedTargets.has(targetId)) break;
            await processGuild(targetId, allGuildIds[i]);

            if (i < allGuildIds.length - 1 && !pausedTargets.has(targetId)) {
                log.debug(`full_reset: waiting ${INTER_GUILD_DELAY_MS}ms before next guild for ${targetId}`);
                await jitterSleep(INTER_GUILD_DELAY_MS, 30);
            }
        }

        log.info(`Custom backfill (full_reset) complete for ${targetId}`);

    } catch (err: any) {
        log.error(`Custom backfill error for ${targetId}: ${err.message}`);
        throw err;
    } finally {
        activeBackfills.delete(targetId);
    }
}

// ── Startup: backfill targets with no existing progress data ─────────────────

export async function startBackfillOnStartup(): Promise<void> {
    if (!config.backfillEnabled) return;

    const stmts = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];

    // Stagger startup backfills so they don't all queue up and fire in a burst.
    // Each target is scheduled 3 minutes apart — the queue still serialises them,
    // but the stagger means we don't enqueue 10 targets in one tick.
    const STARTUP_STAGGER_MS = 3 * 60_000;

    targets.forEach((target, index) => {
        const row = stmts.hasBackfillData.get(target.user_id) as any;
        if (!row || row.count === 0) {
            const delay = index * STARTUP_STAGGER_MS;
            log.info(
                `Target ${target.user_id} has no backfill data — scheduling backfill in ${delay / 1000}s`
            );
            setTimeout(() => {
                startBackfillForTarget(target.user_id).catch(err =>
                    log.error(`Startup backfill error for ${target.user_id}: ${err.message}`)
                );
            }, delay);
        }
    });
}

// ── Pause / resume ────────────────────────────────────────────────────────────

export function pauseBackfill(targetId: string): void {
    pausedTargets.add(targetId);
    log.info(`Backfill paused for ${targetId}`);
}

export function resumeBackfill(targetId: string): void {
    pausedTargets.delete(targetId);
    log.info(`Backfill resumed for ${targetId}`);
}
