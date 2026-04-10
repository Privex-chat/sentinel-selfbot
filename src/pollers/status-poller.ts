import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { withJitter } from "../utils/jitter";
import { getStmts } from "../database/queries";

const log = createLogger("StatusPoller");

let intervalHandle: NodeJS.Timeout | null = null;
let requestGuildMembersFn: ((guildId: string, userIds: string[]) => void) | null = null;

export function setRequestGuildMembersFn(
    fn: (guildId: string, userIds: string[]) => void
): void {
    requestGuildMembersFn = fn;
}

/**
 * Build the guild→targets map and send REQUEST_GUILD_MEMBERS for each guild,
 * staggered so we don't spike the 120 ops / 60 s gateway rate limit.
 */
function pollPresences(): void {
    if (!requestGuildMembersFn) return;

    const stmts   = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    if (targets.length === 0) return;

    const guildTargetMap = new Map<string, string[]>();

    for (const target of targets) {
        const snapshot = stmts.getLatestSnapshot.get(target.user_id) as any;
        if (!snapshot?.mutual_guilds) continue;

        try {
            const guilds = JSON.parse(snapshot.mutual_guilds) as any[];
            for (const guild of guilds) {
                const guildId: string = typeof guild === "string" ? guild : guild.id;
                if (!guildId) continue;
                const existing = guildTargetMap.get(guildId) || [];
                existing.push(target.user_id);
                guildTargetMap.set(guildId, existing);
            }
        } catch { /* malformed JSON — skip */ }
    }

    if (guildTargetMap.size === 0) {
        log.debug("No mutual guild data available for status poll (profiles may not be fetched yet)");
        return;
    }

    // Stagger each guild request by ~500 ms (±20% with jitter) so a large
    // number of targets / guilds never bursts the gateway rate limit.
    const STAGGER_BASE_MS = 500;
    let delay = 0;

    for (const [guildId, userIds] of guildTargetMap) {
        const d = delay;
        setTimeout(() => {
            if (!requestGuildMembersFn) return;
            requestGuildMembersFn(guildId, userIds);
            log.debug(`Status poll: requested guild members for ${guildId} (${userIds.length} target(s))`);
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