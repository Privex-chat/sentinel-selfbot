import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { config } from "../utils/config";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("AlertDigest");

interface DigestEntry {
    ruleId: number;
    targetId: string;
    alertType: string;
    message: string;
    timestamp: number;
    count: number;
}

const digestBuffer = new Map<string, DigestEntry>();

export function addToDigest(
    ruleId: number,
    targetId: string,
    alertType: string,
    message: string,
    timestamp: number
): void {
    const key = `${targetId}:${alertType}`;
    const existing = digestBuffer.get(key);
    if (existing) {
        existing.count++;
        existing.timestamp = timestamp; // update to latest
    } else {
        digestBuffer.set(key, { ruleId, targetId, alertType, message, timestamp, count: 1 });
    }
}

function flushDigest(): void {
    if (!digestBuffer.size) return;

    const stmts = getStmts();
    const now = Date.now();

    // Group by target
    const byTarget = new Map<string, DigestEntry[]>();
    for (const entry of digestBuffer.values()) {
        const arr = byTarget.get(entry.targetId) || [];
        arr.push(entry);
        byTarget.set(entry.targetId, arr);
    }

    for (const [targetId, entries] of byTarget) {
        // Emit one digest SSE event per target
        pushSSEEvent({
            target_id: targetId,
            event_type: "ALERT_DIGEST",
            timestamp: now,
            data: { alerts: entries, windowMs: config.alertDigestIntervalMs },
        });

        // Insert one alert_history row per unique alert type
        for (const entry of entries) {
            const digestMessage = entry.count > 1
                ? `[DIGEST x${entry.count}] ${entry.message}`
                : entry.message;
            stmts.insertAlertHistory.run(
                entry.ruleId, targetId, entry.alertType, digestMessage, now
            );
        }

        log.info(`Digest flushed for ${targetId}: ${entries.length} alert types`);
    }

    digestBuffer.clear();
}

export function startDigestFlusher(): NodeJS.Timeout {
    log.info(`Alert digest mode enabled (flush every ${config.alertDigestIntervalMs / 1000}s)`);
    return setInterval(() => {
        try { flushDigest(); }
        catch (err: any) { log.error(`Digest flush error: ${err.message}`); }
    }, config.alertDigestIntervalMs);
}

export function flushDigestNow(): void {
    flushDigest();
}
