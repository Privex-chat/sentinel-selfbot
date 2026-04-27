import { createLogger } from "./logger";

const log = createLogger("WebhookQueue");

const MAX_RETRIES    = 5;
const MIN_INTERVAL   = 550;  // ms between successful sends — keeps us under 30/min
const MAX_QUEUE_SIZE = 200;
const RETRY_BASE_MS  = 1_000;

interface QueueItem {
    url:     string;
    body:    string;
    label:   string;
    retries: number;
}

type SendResult =
    | { type: "ok" }
    | { type: "drop" }
    | { type: "retry";        delayMs: number }
    | { type: "rate_limited"; delayMs: number };

const queue: QueueItem[] = [];
let busy        = false;
let lastSentAt  = 0;
let rateLimitAt = 0; // epoch ms when the current rate-limit window expires

// ── Public API ────────────────────────────────────────────────────────────��───

export function enqueueWebhook(url: string, body: string, label = "webhook"): void {
    if (queue.length >= MAX_QUEUE_SIZE) {
        log.warn(`Webhook queue full — dropping oldest: ${queue[0].label}`);
        queue.shift();
    }
    queue.push({ url, body, label, retries: 0 });
    schedule(0);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function schedule(delayMs: number): void {
    if (busy) return;
    setTimeout(process, delayMs);
}

async function process(): Promise<void> {
    if (busy || queue.length === 0) return;
    busy = true;

    const item = queue[0];
    let nextDelay = MIN_INTERVAL;

    try {
        // Respect active rate-limit window
        const rlWait = rateLimitAt - Date.now();
        if (rlWait > 0) {
            busy = false;
            schedule(rlWait + 50);
            return;
        }

        // Respect minimum inter-request interval
        const gap = Date.now() - lastSentAt;
        if (lastSentAt > 0 && gap < MIN_INTERVAL) {
            busy = false;
            schedule(MIN_INTERVAL - gap + 10);
            return;
        }

        const result = await attemptSend(item);

        if (result.type === "ok") {
            queue.shift();
            lastSentAt = Date.now();
            nextDelay  = MIN_INTERVAL;
        } else if (result.type === "drop") {
            queue.shift();
            nextDelay = 0;
        } else if (result.type === "rate_limited") {
            // item stays at front — retry after the window
            nextDelay = result.delayMs + 50;
        } else {
            // retry with back-off
            nextDelay = result.delayMs;
        }
    } finally {
        busy = false;
        if (queue.length > 0) schedule(nextDelay);
    }
}

async function attemptSend(item: QueueItem): Promise<SendResult> {
    try {
        const res = await fetch(item.url, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    item.body,
        });

        if (res.status === 429) {
            let retryAfterMs = 1_000;
            try {
                const data = await res.json() as any;
                retryAfterMs = Math.ceil((data.retry_after ?? 1) * 1000);
            } catch { /* ignore */ }
            rateLimitAt = Date.now() + retryAfterMs;
            log.warn(`Webhook rate limited (${item.label}) — waiting ${retryAfterMs}ms`);
            return { type: "rate_limited", delayMs: retryAfterMs };
        }

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            return handleFailure(item, `HTTP ${res.status}: ${text.slice(0, 200)}`);
        }

        log.debug(`Webhook delivered: ${item.label}`);
        return { type: "ok" };

    } catch (err: any) {
        return handleFailure(item, err.message);
    }
}

function handleFailure(item: QueueItem, reason: string): SendResult {
    if (item.retries >= MAX_RETRIES) {
        log.error(`Webhook permanently failed (${item.label}) after ${MAX_RETRIES} retries: ${reason}`);
        return { type: "drop" };
    }
    item.retries++;
    const delayMs = Math.min(RETRY_BASE_MS * Math.pow(2, item.retries), 30_000);
    log.warn(`Webhook failed (${item.label}) attempt ${item.retries}/${MAX_RETRIES}: ${reason} — retry in ${delayMs}ms`);
    return { type: "retry", delayMs };
}
