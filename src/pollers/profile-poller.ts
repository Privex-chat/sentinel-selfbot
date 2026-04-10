import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { withJitter } from "../utils/jitter";
import { discordFetch } from "../utils/rate-limiter";
import { getStmts } from "../database/queries";
import { handleProfileUpdate } from "../collectors/profile";

const log = createLogger("ProfilePoller");

let intervalHandle: NodeJS.Timeout | null = null;

async function pollTarget(targetId: string): Promise<void> {
    try {
        const res = await discordFetch(
            `/users/${targetId}/profile?with_mutual_guilds=true&with_mutual_friends_count=false`,
            config.discordToken
        );

        if (!res.ok) {
            log.warn(`Failed to fetch profile for ${targetId}: ${res.status}`);
            return;
        }

        const data = await res.json() as any;
        handleProfileUpdate(
            targetId,
            data.user,
            data.user_profile,
            data.connected_accounts,
            data.mutual_guilds
        );
    } catch (err: any) {
        log.error(`Profile poll error for ${targetId}: ${err.message}`);
    }
}

async function pollAllTargets(): Promise<void> {
    const stmts   = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];

    log.debug(`Polling profiles for ${targets.length} targets`);

    for (const target of targets) {
        await pollTarget(target.user_id);
        // Stagger requests: 3 s base delay (±20% jitter) between each target
        await new Promise(resolve => setTimeout(resolve, withJitter(3_000)));
    }
}

export function startProfilePoller(): void {
    log.info(`Starting profile poller (interval: ${config.profilePollIntervalMs}ms)`);

    // Initial poll after 30 s so mutual_guilds are available for the status poller
    const scheduleNext = () => {
        intervalHandle = setTimeout(async () => {
            await pollAllTargets();
            scheduleNext();
        }, withJitter(config.profilePollIntervalMs));
    };

    setTimeout(async () => {
        await pollAllTargets();
        scheduleNext();
    }, 30_000);
}

export function stopProfilePoller(): void {
    if (intervalHandle) {
        clearTimeout(intervalHandle);
        intervalHandle = null;
    }
    log.info("Profile poller stopped");
}