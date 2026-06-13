import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { withJitter } from "../utils/jitter";
import { getStmts } from "../database/queries";

const log = createLogger("StatusPoller");

let intervalHandle: NodeJS.Timeout | null = null;
let firstPollTimeout: NodeJS.Timeout | null = null;
let requestGuildMembersFn: ((guildId: string, userIds: string[]) => void) | null = null;
let subscribePresenceFn:   ((guildId: string, memberIds: string[]) => void) | null = null;
let selfbotGuildsFn: (() => any[]) | null = null;

export function setRequestGuildMembersFn(
    fn: (guildId: string, userIds: string[]) => void
): void {
    requestGuildMembersFn = fn;
}

export function setSubscribePresenceFn(
    fn: (guildId: string, memberIds: string[]) => void
): void {
    subscribePresenceFn = fn;
}

/** Provide a getter for the selfbot's own guild list (from GatewayClient.getGuilds). */
export function setSelfbotGuildsFn(fn: () => any[]): void {
    selfbotGuildsFn = fn;
}

/**
 * Immediately subscribe to presence and request current state for a newly added target.
 * Called ~5 s after target insert (giving the profile poller time to fetch mutual guilds).
 *
 * Sends op 14 with `members: [userId]` for each mutual guild so Discord starts pushing
 * PRESENCE_UPDATE in real time, then follows up with op 8 REQUEST_GUILD_MEMBERS to get
 * the target's current status without waiting for the next periodic poll.
 */
export function requestPresenceForUser(userId: string): void {
    const stmts = getStmts();
    const snapshot = stmts.getLatestSnapshot.get(userId) as any;

    const guilds: string[] = [];

    if (snapshot?.mutual_guilds) {
        try {
            const parsed = JSON.parse(snapshot.mutual_guilds) as any[];
            for (const g of parsed) {
                const id: string = typeof g === "string" ? g : g.id;
                if (id) guilds.push(id);
            }
        } catch { /* malformed — fall through to selfbot guilds */ }
    }

    // Fallback: no mutual guild data yet — use all selfbot guilds
    if (guilds.length === 0) {
        const selfbotGuilds: any[] = selfbotGuildsFn?.() ?? [];
        for (const g of selfbotGuilds) {
            const id: string = typeof g === "string" ? g : g.id;
            if (id) guilds.push(id);
        }
    }

    if (guilds.length === 0) {
        log.debug(`requestPresenceForUser(${userId}): no guild data available yet`);
        return;
    }

    const STAGGER_MS = 300;
    guilds.forEach((guildId, i) => {
        const delay = i * STAGGER_MS;
        setTimeout(() => {
            if (subscribePresenceFn)   subscribePresenceFn(guildId, [userId]);
            if (requestGuildMembersFn) requestGuildMembersFn(guildId, [userId]);
        }, delay);
    });

    log.info(`requestPresenceForUser(${userId}): subscribing across ${guilds.length} guild(s)`);
}

/**
 * Build the guild→targets map and send REQUEST_GUILD_MEMBERS for each guild,
 * staggered so we don't spike the 120 ops / 60 s gateway rate limit.
 *
 * NOTE: GUILD_MEMBERS_CHUNK presences only include ACTIVE (non-offline) users.
 * Absence from a chunk does NOT reliably mean offline — a user may be present in
 * guild A's presences but absent from guild B's due to per-guild visibility rules.
 * The chunk handler therefore never forces offline for known users; offline
 * transitions come exclusively from PRESENCE_UPDATE events via op 14 subscriptions.
 * This poll is used only to confirm / refresh active status, and to handle initial
 * presence discovery for newly added targets.
 */
function pollPresences(): void {
    if (!requestGuildMembersFn) return;

    const stmts   = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    if (targets.length === 0) return;

    const guildTargetMap = new Map<string, Set<string>>();

    // Primary: use stored mutual_guilds from profile snapshots
    for (const target of targets) {
        const snapshot = stmts.getLatestSnapshot.get(target.user_id) as any;
        if (!snapshot?.mutual_guilds) continue;

        try {
            const guilds = JSON.parse(snapshot.mutual_guilds) as any[];
            for (const guild of guilds) {
                const guildId: string = typeof guild === "string" ? guild : guild.id;
                if (!guildId) continue;
                const existing = guildTargetMap.get(guildId) ?? new Set();
                existing.add(target.user_id);
                guildTargetMap.set(guildId, existing);
            }
        } catch { /* malformed JSON — skip */ }
    }

    // Fallback: targets without snapshot data get polled against all selfbot guilds
    const selfbotGuilds: any[] = selfbotGuildsFn?.() ?? [];
    for (const target of targets) {
        const snapshot = stmts.getLatestSnapshot.get(target.user_id) as any;
        if (snapshot?.mutual_guilds) continue;

        for (const guild of selfbotGuilds) {
            const guildId: string = typeof guild === "string" ? guild : guild.id;
            if (!guildId) continue;
            const existing = guildTargetMap.get(guildId) ?? new Set();
            existing.add(target.user_id);
            guildTargetMap.set(guildId, existing);
        }
    }

    if (guildTargetMap.size === 0) {
        log.debug("No guild data available for status poll (profiles may not be fetched yet)");
        return;
    }

    // Stagger each guild request by ~500 ms (±20% with jitter) so a large
    // number of targets / guilds never bursts the gateway rate limit.
    const STAGGER_BASE_MS = 500;
    let delay = 0;

    for (const [guildId, userIds] of guildTargetMap) {
        const arr = Array.from(userIds);
        const d   = delay;
        setTimeout(() => {
            if (!requestGuildMembersFn) return;
            requestGuildMembersFn(guildId, arr);
            log.debug(`Status poll: requested ${arr.length} target(s) from guild ${guildId}`);
        }, d);
        delay += withJitter(STAGGER_BASE_MS);
    }
}

export function startStatusPoller(): void {
    log.info(`Starting status poller (base interval: ${config.statusPollIntervalMs}ms, first poll: 90 s)`);

    // Delay the first poll to 90 s so that:
    //   1. The profile poller (starts at 30 s) has populated mutual_guilds.
    //   2. The initial presence stagger in requestInitialPresences has finished
    //      (prevents double-flooding the gateway rate limit).
    const FIRST_POLL_DELAY_MS = 90_000;

    firstPollTimeout = setTimeout(() => {
        firstPollTimeout = null;
        pollPresences();
        // Schedule recurring polls with per-tick jitter
        const scheduleNext = () => {
            intervalHandle = setTimeout(() => {
                pollPresences();
                scheduleNext();
            }, withJitter(config.statusPollIntervalMs));
        };
        scheduleNext();
    }, FIRST_POLL_DELAY_MS);
}

export function stopStatusPoller(): void {
    if (firstPollTimeout) {
        clearTimeout(firstPollTimeout);
        firstPollTimeout = null;
    }
    if (intervalHandle) {
        clearTimeout(intervalHandle);
        intervalHandle = null;
    }
    log.info("Status poller stopped");
}