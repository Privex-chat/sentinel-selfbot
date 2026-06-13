import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { withJitter } from "../utils/jitter";
import { discordFetch } from "../utils/rate-limiter";
import { getStmts } from "../database/queries";
import { handleProfileUpdate } from "../collectors/profile";

const log = createLogger("ProfilePoller");

let intervalHandle: NodeJS.Timeout | null = null;
let firstPollTimeout: NodeJS.Timeout | null = null;

/**
 * Fall back to the basic /users/{id} endpoint when the full profile endpoint
 * returns 404 (selfbot shares no mutual servers with the target). Stores
 * username / avatar so change-tracking still works. Does NOT overwrite the
 * existing mutual_guilds value in the snapshot — profile.ts preserves it when
 * mutualGuilds is passed as undefined.
 */
async function pollTargetBasic(targetId: string): Promise<void> {
    try {
        const res = await discordFetch(`/users/${targetId}`, config.discordToken);
        if (!res.ok) {
            log.warn(`Failed to fetch basic user info for ${targetId}: ${res.status}`);
            return;
        }
        const userData = await res.json() as any;
        // Pass undefined for optional params — profile.ts will preserve existing
        // connected_accounts / mutual_guilds from the last snapshot.
        handleProfileUpdate(targetId, userData, undefined, undefined, undefined);
    } catch (err: any) {
        log.error(`Basic user fetch error for ${targetId}: ${err.message}`);
    }
}

async function pollTarget(targetId: string): Promise<void> {
    try {
        const res = await discordFetch(
            `/users/${targetId}/profile?with_mutual_guilds=true&with_mutual_friends_count=false`,
            config.discordToken
        );

        if (res.status === 404) {
            // 404 = selfbot shares no mutual servers with this user.
            // Fall back to basic user info so username/avatar are still tracked.
            log.debug(`Profile endpoint 404 for ${targetId} (no mutual servers) — using basic user endpoint`);
            await pollTargetBasic(targetId);
            return;
        }

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

    firstPollTimeout = setTimeout(async () => {
        firstPollTimeout = null;
        await pollAllTargets();
        scheduleNext();
    }, 30_000);
}

export function stopProfilePoller(): void {
    if (firstPollTimeout) {
        clearTimeout(firstPollTimeout);
        firstPollTimeout = null;
    }
    if (intervalHandle) {
        clearTimeout(intervalHandle);
        intervalHandle = null;
    }
    log.info("Profile poller stopped");
}