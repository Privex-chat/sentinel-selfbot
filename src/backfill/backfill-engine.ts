import { createLogger } from "../utils/logger";
import { getDb } from "../database/connection";
import { getStmts } from "../database/queries";
import { config } from "../utils/config";
import { discordFetch } from "../utils/rate-limiter";
import { handleMessageCreate } from "../collectors/message";
import { handleProfileUpdate } from "../collectors/profile";

const log = createLogger("BackfillEngine");

const BACKFILL_DELAY_MS = 500;
const MAX_CONCURRENT_TARGETS = 3;
const MAX_CONCURRENT_GUILDS = 2;

// Track which targets are currently being backfilled
const activeBackfills = new Set<string>();

// Paused flag per target
const pausedTargets = new Set<string>();

// ── Profile fetch helper ──────────────────────────────────────────────────────

/**
 * Fetches the target's Discord profile and stores it via handleProfileUpdate.
 * Returns the mutual_guilds array, or null if the fetch fails.
 */
async function fetchAndStoreProfile(targetId: string): Promise<any[] | null> {
    log.info(`No profile snapshot for ${targetId} — fetching profile before backfill`);
    try {
        const res = await discordFetch(
            `/users/${targetId}/profile?with_mutual_guilds=true&with_mutual_friends_count=false`,
            config.discordToken
        );

        if (!res.ok) {
            log.warn(`Failed to fetch profile for ${targetId}: HTTP ${res.status}`);
            return null;
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

    // Mark in_progress
    stmts.updateBackfillProgress.run(
        "in_progress", 0, null, now, null, null,
        targetId, channelId
    );

    let cursor: string | null = null;
    let messagesFound = 0;
    let oldestMessageId: string | null = null;

    // Resume from existing cursor if any
    const existing = getDb().prepare(
        "SELECT oldest_message_id FROM backfill_progress WHERE target_id = ? AND channel_id = ?"
    ).get(targetId, channelId) as any;
    if (existing?.oldest_message_id) cursor = existing.oldest_message_id;

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

            // Filter to target's messages and insert
            for (const msg of messages) {
                if (msg.author?.id === targetId) {
                    handleMessageCreate(targetId, msg, guildId);
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

            await new Promise(resolve => setTimeout(resolve, BACKFILL_DELAY_MS));
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

        // Process channels sequentially
        for (const ch of textChannels) {
            if (pausedTargets.has(targetId)) break;
            await processChannel(targetId, ch.id, guildId);
        }

    } catch (err: any) {
        log.error(`Guild ${guildId} backfill error: ${err.message}`);
    }
}

// ── Target backfill ───────────────────────────────────────────────────────────

export async function startBackfillForTarget(targetId: string): Promise<void> {
    if (!config.backfillEnabled) {
        log.debug(`Backfill disabled, skipping ${targetId}`);
        return;
    }

    if (activeBackfills.size >= MAX_CONCURRENT_TARGETS) {
        log.warn(`Max concurrent backfills reached, queuing ${targetId}`);
        // Simple queue: retry after 60s
        setTimeout(() => startBackfillForTarget(targetId), 60_000);
        return;
    }

    if (activeBackfills.has(targetId)) {
        log.debug(`Backfill already running for ${targetId}`);
        return;
    }

    activeBackfills.add(targetId);
    log.info(`Starting backfill for ${targetId}`);

    try {
        const stmts = getStmts();

        // Try to get mutual guilds from the latest profile snapshot
        let mutualGuilds: any[] = [];
        const snapshot = stmts.getLatestSnapshot.get(targetId) as any;

        if (snapshot?.mutual_guilds) {
            // Snapshot exists — parse it
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
            log.warn(`No mutual guilds found for ${targetId} (not sharing any servers), skipping backfill`);
            return;
        }

        const guildIds = mutualGuilds
            .map((g: any) => (typeof g === "string" ? g : g.id))
            .filter(Boolean) as string[];

        if (!guildIds.length) {
            log.warn(`No valid guild IDs extracted for ${targetId}`);
            return;
        }

        log.info(`Backfilling ${targetId} across ${guildIds.length} mutual guild(s)`);

        // Process guilds concurrently (max 2 at once)
        for (let i = 0; i < guildIds.length; i += MAX_CONCURRENT_GUILDS) {
            if (pausedTargets.has(targetId)) break;
            const batch = guildIds.slice(i, i + MAX_CONCURRENT_GUILDS);
            await Promise.all(batch.map((gid: string) => processGuild(targetId, gid)));
        }

        log.info(`Backfill complete for ${targetId}`);

    } catch (err: any) {
        log.error(`Backfill error for ${targetId}: ${err.message}`);
    } finally {
        activeBackfills.delete(targetId);
    }
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
            log.warn(`No mutual guilds for ${targetId} — custom backfill finished with nothing to do`);
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
            // Only process the new guilds — existing completed channels are untouched.
            for (let i = 0; i < newGuildIds.length; i += MAX_CONCURRENT_GUILDS) {
                if (pausedTargets.has(targetId)) break;
                const batch = newGuildIds.slice(i, i + MAX_CONCURRENT_GUILDS);
                await Promise.all(batch.map((gid: string) => processGuild(targetId, gid)));
            }
            log.info(`Custom backfill (new_channels) complete for ${targetId}`);
            return;
        }

        // full_reset path: process every guild.
        for (let i = 0; i < allGuildIds.length; i += MAX_CONCURRENT_GUILDS) {
            if (pausedTargets.has(targetId)) break;
            const batch = allGuildIds.slice(i, i + MAX_CONCURRENT_GUILDS);
            await Promise.all(batch.map((gid: string) => processGuild(targetId, gid)));
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

    for (const target of targets) {
        const row = stmts.hasBackfillData.get(target.user_id) as any;
        if (!row || row.count === 0) {
            log.info(`Target ${target.user_id} has no backfill data — starting backfill`);
            // Don't await — fire and forget for startup
            startBackfillForTarget(target.user_id).catch(err =>
                log.error(`Startup backfill error for ${target.user_id}: ${err.message}`)
            );
        }
    }
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