import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { withJitter } from "../utils/jitter";
import { discordFetch } from "../utils/rate-limiter";
import { getStmts } from "../database/queries";

const log = createLogger("MutualServers");

let intervalHandle: NodeJS.Timeout | null = null;
const POLL_INTERVAL_BASE = 1_800_000; // 30 minutes

async function pollTarget(targetId: string): Promise<void> {
    try {
        const res = await discordFetch(
            `/users/${targetId}/profile?with_mutual_guilds=true`,
            config.discordToken
        );

        if (!res.ok) {
            log.warn(`Failed to fetch mutual servers for ${targetId}: ${res.status}`);
            return;
        }

        const data = await res.json() as any;
        const newGuilds: { id: string; nick?: string }[] = data.mutual_guilds || [];
        const stmts = getStmts();
        const now   = Date.now();

        const lastSnapshot = stmts.getLatestSnapshot.get(targetId) as any;
        let oldGuilds: { id: string }[] = [];
        if (lastSnapshot?.mutual_guilds) {
            try { oldGuilds = JSON.parse(lastSnapshot.mutual_guilds); } catch { }
        }

        const oldIds = new Set(oldGuilds.map(g => g.id));
        const newIds = new Set(newGuilds.map(g => g.id));

        for (const guild of newGuilds) {
            if (!oldIds.has(guild.id)) {
                stmts.insertEvent.run(targetId, "SERVER_JOIN", now, JSON.stringify({ guildId: guild.id }), guild.id, null);
                stmts.insertGuildMemberEvent.run(targetId, guild.id, "SERVER_JOIN", now, null, null);
                log.info(`${targetId}: joined server ${guild.id}`);
            }
        }

        for (const guild of oldGuilds) {
            if (!newIds.has(guild.id)) {
                stmts.insertEvent.run(targetId, "SERVER_LEAVE", now, JSON.stringify({ guildId: guild.id }), guild.id, null);
                stmts.insertGuildMemberEvent.run(targetId, guild.id, "SERVER_LEAVE", now, null, null);
                log.info(`${targetId}: left server ${guild.id}`);
            }
        }
    } catch (err: any) {
        log.error(`Mutual servers poll error for ${targetId}: ${err.message}`);
    }
}

async function pollAllTargets(): Promise<void> {
    const stmts   = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    log.debug(`Polling mutual servers for ${targets.length} targets`);

    for (const target of targets) {
        await pollTarget(target.user_id);
        await new Promise(resolve => setTimeout(resolve, withJitter(3_000)));
    }
}

export function startMutualServersPoller(): void {
    log.info("Starting mutual servers poller (interval: ~30 min)");

    const scheduleNext = () => {
        intervalHandle = setTimeout(async () => {
            await pollAllTargets();
            scheduleNext();
        }, withJitter(POLL_INTERVAL_BASE));
    };

    setTimeout(async () => {
        await pollAllTargets();
        scheduleNext();
    }, withJitter(60_000));
}

export function stopMutualServersPoller(): void {
    if (intervalHandle) {
        clearTimeout(intervalHandle);
        intervalHandle = null;
    }
    log.info("Mutual servers poller stopped");
}