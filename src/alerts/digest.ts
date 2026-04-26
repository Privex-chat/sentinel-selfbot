import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { config } from "../utils/config";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("AlertDigest");

const DISCORD_RE = /https?:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//i;

async function sendDigestWebhook(entries: DigestEntry[]): Promise<void> {
    if (!config.alertWebhookUrl) return;

    const isDiscord = DISCORD_RE.test(config.alertWebhookUrl);
    const lines = entries.map(e =>
        e.count > 1
            ? `**[${e.alertType.replace(/_/g, " ")}]** (×${e.count}) ${e.message}`
            : `**[${e.alertType.replace(/_/g, " ")}]** ${e.message}`
    );

    const body = isDiscord
        ? JSON.stringify({
            username: "Sentinel",
            content: `**[DIGEST — ${entries.length} alert${entries.length === 1 ? "" : "s"}]**\n${lines.join("\n")}`.slice(0, 2000),
        })
        : JSON.stringify({
            event: "alert_digest",
            alerts: entries.map(e => ({
                ruleId: e.ruleId,
                targetId: e.targetId,
                alertType: e.alertType,
                message: e.message,
                count: e.count,
            })),
            timestamp: Date.now(),
        });

    try {
        const res = await fetch(config.alertWebhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            log.warn(`Digest webhook failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
        } else {
            log.info(`Digest webhook delivered (${entries.length} alerts)`);
        }
    } catch (err: any) {
        log.warn(`Digest webhook error: ${err.message}`);
    }
}

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
    const allEntries: DigestEntry[] = [];

    // Group by target
    const byTarget = new Map<string, DigestEntry[]>();
    for (const entry of digestBuffer.values()) {
        const arr = byTarget.get(entry.targetId) || [];
        arr.push(entry);
        byTarget.set(entry.targetId, arr);
        allEntries.push(entry);
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

    // Send one webhook call covering all buffered alerts
    sendDigestWebhook(allEntries).catch(() => {});
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
