import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { withJitter } from "../utils/jitter";
import { getStmts } from "../database/queries";

const log = createLogger("StatusPoller");

let intervalHandle: NodeJS.Timeout | null = null;
let requestGuildMembersFn: ((guildId: string, userIds: string[]) => void) | null = null;
let selfbotGuildsFn: (() => any[]) | null = null;

export function setRequestGuildMembersFn(
    fn: (guildId: string, userIds: string[]) => void
): void {
    requestGuildMembersFn = fn;
}

/** Provide a getter for the selfbot's own guild list (from GatewayClient.getGuilds). */
export function setSelfbotGuildsFn(fn: () => any[]): void {
    selfbotGuildsFn = fn;
}

/**
 * Build the guild→targets map and send REQUEST_GUILD_MEMBERS for each guild,
 * staggered so we don't spike the 120 ops / 60 s gateway rate limit.
 *
 * NOTE: GUILD_MEMBERS_CHUNK presences only include ACTIVE (non-offline) users.
 * Absence from a user_ids-targeted chunk DOES mean the user is offline/invisible,
 * and the chunk handler in index.ts marks them offline accordingly. This poll
 * therefore serves a dual purpose: refreshing online status in case a
 * PRESENCE_UPDATE was missed, and catching offline transitions via chunk absence.
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
    const interval = withJitter(config.statusPollIntervalMs);
    log.info(`Starting status poller (base interval: ${config.statusPollIntervalMs}ms, first poll: 90 s)`);

    // Delay the first poll to 90 s so that:
    //   1. The profile poller (starts at 30 s) has populated mutual_guilds.
    //   2. The initial presence stagger in requestInitialPresences has finished
    //      (prevents double-flooding the gateway rate limit).
    const FIRST_POLL_DELAY_MS = 90_000;

    let firstTimeout: NodeJS.Timeout | null = setTimeout(() => {
        firstTimeout = null;
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
    if (intervalHandle) {
        clearTimeout(intervalHandle);
        intervalHandle = null;
    }
    log.info("Status poller stopped");
}