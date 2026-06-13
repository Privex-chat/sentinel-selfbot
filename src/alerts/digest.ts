import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("AlertDigest");

// Digest mode batches alert *display* into a single SSE event per (target,
// rule_type) every config.alertDigestIntervalMs. Webhook delivery is
// intentionally NOT batched — fireAlert sends the immediate per-event webhook
// in alerts/engine.ts. Digest is SSE-only so the dashboard live feed isn't
// spammed during a burst; the operator still gets one webhook per real event.

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

    const now = Date.now();

    // Group by target and emit one SSE event per target. No webhook side effect —
    // immediate webhook delivery is the only delivery mode (see fireAlert).
    const byTarget = new Map<string, DigestEntry[]>();
    for (const entry of digestBuffer.values()) {
        const arr = byTarget.get(entry.targetId) || [];
        arr.push(entry);
        byTarget.set(entry.targetId, arr);
    }

    for (const [targetId, entries] of byTarget) {
        pushSSEEvent({
            target_id: targetId,
            event_type: "ALERT_DIGEST",
            timestamp: now,
            data: { alerts: entries, windowMs: config.alertDigestIntervalMs },
        });

        log.info(`Digest flushed for ${targetId}: ${entries.length} alert types`);
    }

    digestBuffer.clear();
}

export function startDigestFlusher(): NodeJS.Timeout {
    log.info(`Digest flusher started (interval: ${config.alertDigestIntervalMs / 1000}s)`);
    return setInterval(() => {
        try { flushDigest(); }
        catch (err: any) { log.error(`Digest flush error: ${err.message}`); }
    }, config.alertDigestIntervalMs);
}

export function flushDigestNow(): void {
    flushDigest();
}
