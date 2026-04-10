import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { withJitter } from "../utils/jitter";
import { discordFetch } from "../utils/rate-limiter";
import { getStmts } from "../database/queries";

const log = createLogger("ConnectedAccounts");

let intervalHandle: NodeJS.Timeout | null = null;
const POLL_INTERVAL_BASE = 1_800_000; // 30 minutes

async function pollTarget(targetId: string): Promise<void> {
    try {
        const res = await discordFetch(
            `/users/${targetId}/profile`,
            config.discordToken
        );

        if (!res.ok) {
            log.warn(`Failed to fetch connected accounts for ${targetId}: ${res.status}`);
            return;
        }

        const data        = await res.json() as any;
        const newAccounts: any[] = data.connected_accounts || [];
        const stmts       = getStmts();
        const now         = Date.now();

        const lastSnapshot = stmts.getLatestSnapshot.get(targetId) as any;
        let oldAccounts: any[] = [];
        if (lastSnapshot?.connected_accounts) {
            try { oldAccounts = JSON.parse(lastSnapshot.connected_accounts); } catch { }
        }

        const oldTypes = new Map(oldAccounts.map((a: any) => [a.type + ":" + (a.id || a.name), a]));
        const newTypes = new Map(newAccounts.map((a: any) => [a.type + ":" + (a.id || a.name), a]));

        for (const [key, account] of newTypes) {
            if (!oldTypes.has(key)) {
                stmts.insertEvent.run(
                    targetId, "ACCOUNT_CONNECTED", now,
                    JSON.stringify({
                        type:       account.type,
                        name:       account.name,
                        id:         account.id,
                        verified:   account.verified,
                        visibility: account.visibility,
                    }),
                    null, null
                );
                log.info(`${targetId}: connected ${account.type} account "${account.name}"`);
            }
        }

        for (const [key, account] of oldTypes) {
            if (!newTypes.has(key)) {
                stmts.insertEvent.run(
                    targetId, "ACCOUNT_DISCONNECTED", now,
                    JSON.stringify({ type: account.type, name: account.name, id: account.id }),
                    null, null
                );
                log.info(`${targetId}: disconnected ${account.type} account "${account.name}"`);
            }
        }
    } catch (err: any) {
        log.error(`Connected accounts poll error for ${targetId}: ${err.message}`);
    }
}

async function pollAllTargets(): Promise<void> {
    const stmts   = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    log.debug(`Polling connected accounts for ${targets.length} targets`);

    for (const target of targets) {
        await pollTarget(target.user_id);
        await new Promise(resolve => setTimeout(resolve, withJitter(3_000)));
    }
}

export function startConnectedAccountsPoller(): void {
    log.info("Starting connected accounts poller (interval: ~30 min)");

    const scheduleNext = () => {
        intervalHandle = setTimeout(async () => {
            await pollAllTargets();
            scheduleNext();
        }, withJitter(POLL_INTERVAL_BASE));
    };

    setTimeout(async () => {
        await pollAllTargets();
        scheduleNext();
    }, withJitter(90_000));
}

export function stopConnectedAccountsPoller(): void {
    if (intervalHandle) {
        clearTimeout(intervalHandle);
        intervalHandle = null;
    }
    log.info("Connected accounts poller stopped");
}