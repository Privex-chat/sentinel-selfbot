import { createLogger } from "./logger";
import { notifyCriticalError } from "./webhook-notifier";
import { chosenProfile, superPropertiesHeader } from "./discord-properties";

const log = createLogger("RateLimiter");

let discordAuthFailedNotified = false;

// Minimum wall-clock gap between any two outbound Discord REST requests.
// This acts as a safety floor independent of bucket state — even if buckets
// say we have remaining capacity, firing back-to-back requests at full speed
// looks like automation to Discord's abuse detection. 600 ms ± 30% jitter
// keeps sustained REST throughput well under what an attentive human could
// produce by hand while still letting interactive commands feel responsive.
const MIN_REQUEST_INTERVAL_MS = 600;

// Extra safety buffer added on top of Discord's retry_after value.
// We wait retry_after × (1 + RETRY_AFTER_BUFFER) so we don't immediately
// re-trigger the limit the moment the window resets.
const RETRY_AFTER_BUFFER = 0.25;

interface RateLimitBucket {
    remaining: number;
    resetAt: number;
    limit: number;
}

export class RateLimiter {
    private buckets: Map<string, RateLimitBucket> = new Map();
    private globalResetAt = 0;
    private lastRequestAt = 0;

    constructor() {
        // Prune buckets whose reset window expired more than 5 minutes ago.
        // Each unique URL (including its query string) gets its own bucket;
        // without this the Map grows unbounded for long-running deployments
        // that touch a wide range of profile/channel/message endpoints.
        const evict = setInterval(() => {
            const cutoff = Date.now() - 5 * 60_000;
            for (const [key, b] of this.buckets) {
                if (b.resetAt < cutoff) this.buckets.delete(key);
            }
        }, 60_000);
        evict.unref?.();
    }

    async waitForBucket(route: string): Promise<void> {
        const now = Date.now();

        if (this.globalResetAt > now) {
            const wait = this.globalResetAt - now;
            log.warn(`Global rate limit hit, waiting ${wait}ms`);
            await this.sleep(wait);
        }

        const bucket = this.buckets.get(route);
        if (bucket) {
            if (bucket.remaining <= 1 && bucket.resetAt > Date.now()) {
                const wait = bucket.resetAt - Date.now() + 100;
                log.debug(`Rate limit bucket ${route}: waiting ${wait}ms`);
                await this.sleep(wait);
            }
        }

        // Enforce minimum inter-request gap — add ±30% jitter so requests
        // don't arrive at perfectly predictable intervals.
        const sinceLastRequest = Date.now() - this.lastRequestAt;
        const jitter = (Math.random() * 0.6 - 0.3) * MIN_REQUEST_INTERVAL_MS;
        const minGap = Math.max(100, MIN_REQUEST_INTERVAL_MS + jitter);
        if (sinceLastRequest < minGap) {
            await this.sleep(minGap - sinceLastRequest);
        }
        this.lastRequestAt = Date.now();
    }

    updateFromHeaders(route: string, headers: Record<string, string>): void {
        const remaining = parseInt(headers["x-ratelimit-remaining"] || "10", 10);
        const resetAfter = parseFloat(headers["x-ratelimit-reset-after"] || "0") * 1000;
        const limit = parseInt(headers["x-ratelimit-limit"] || "10", 10);
        const isGlobal = headers["x-ratelimit-global"] === "true";

        if (isGlobal && resetAfter > 0) {
            this.globalResetAt = Date.now() + resetAfter;
            log.warn(`Global rate limit set, resets in ${resetAfter}ms`);
        }

        this.buckets.set(route, {
            remaining,
            resetAt: Date.now() + resetAfter,
            limit,
        });
    }

    handleRetryAfter(retryAfterMs: number, isGlobal: boolean): void {
        const buffered = retryAfterMs * (1 + RETRY_AFTER_BUFFER);
        if (isGlobal) {
            this.globalResetAt = Date.now() + buffered;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export const rateLimiter = new RateLimiter();

export async function discordFetch(
    route: string,
    token: string,
    options: RequestInit = {}
): Promise<Response> {
    const url = route.startsWith("http") ? route : `https://discord.com/api/v10${route}`;
    const MAX_RETRIES = 5;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        await rateLimiter.waitForBucket(route);

        let res: Response;
        try {
            res = await fetch(url, {
                ...options,
                headers: {
                    Authorization:        token,
                    "Content-Type":       "application/json",
                    // These headers are required for Discord's undocumented user-account
                    // endpoints (e.g. /users/{id}/profile). Without them Discord returns
                    // 404 even when the selfbot shares mutual servers with the target.
                    "User-Agent":         chosenProfile.browser_user_agent,
                    "X-Super-Properties": superPropertiesHeader,
                    "X-Discord-Locale":   "en-US",
                    ...options.headers,
                },
            });
        } catch (fetchErr: any) {
            if (attempt < MAX_RETRIES - 1) {
                const backoffMs = Math.min(1000 * 2 ** attempt, 30_000); // 1s, 2s, 4s, 8s, 16s
                log.warn(`Fetch network error on ${route} (attempt ${attempt + 1}/${MAX_RETRIES}): ${fetchErr.message}, retrying in ${backoffMs}ms`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                continue;
            }
            throw fetchErr;
        }

        const headerObj: Record<string, string> = {};
        res.headers.forEach((v, k) => { headerObj[k.toLowerCase()] = v; });
        rateLimiter.updateFromHeaders(route, headerObj);

        if (res.status === 429) {
            const body = await res.json() as { retry_after: number; global?: boolean };
            // Buffer the retry_after so we don't immediately re-trigger the limit.
            const retryMs = Math.ceil(body.retry_after * 1000 * (1 + RETRY_AFTER_BUFFER));
            log.warn(`429 on ${route} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying after ${retryMs}ms`);
            rateLimiter.handleRetryAfter(body.retry_after * 1000, !!body.global);
            await new Promise(resolve => setTimeout(resolve, retryMs));
            continue;
        }

        // 401 Unauthorized — token is invalid or was rotated
        if (res.status === 401 && !discordAuthFailedNotified) {
            discordAuthFailedNotified = true;
            notifyCriticalError(
                `Discord REST API returned 401 Unauthorized on route: ${route}. Token may have been rotated or invalidated.`,
                undefined,
                "Discord Auth"
            );
        }

        // Transient server errors — retry with backoff before giving up
        if (res.status === 500 || res.status === 502 || res.status === 503) {
            if (attempt < MAX_RETRIES - 1) {
                const backoffMs = Math.min(1000 * 2 ** attempt, 30_000); // 1s, 2s, 4s, 8s, 16s
                log.warn(`${res.status} on ${route} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${backoffMs}ms`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                continue;
            }
        }

        return res;
    }

    throw new Error(`discordFetch: exceeded ${MAX_RETRIES} retries on ${route} (sustained rate-limit)`);
}
