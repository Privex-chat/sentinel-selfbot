import { createLogger } from "./logger";
import { notifyCriticalError } from "./webhook-notifier";
import { chosenProfile, superPropertiesHeader } from "./discord-properties";

const log = createLogger("RateLimiter");

let discordAuthFailedNotified = false;

interface RateLimitBucket {
    remaining: number;
    resetAt: number;
    limit: number;
}

export class RateLimiter {
    private buckets: Map<string, RateLimitBucket> = new Map();
    private globalResetAt = 0;

    async waitForBucket(route: string): Promise<void> {
        const now = Date.now();

        if (this.globalResetAt > now) {
            const wait = this.globalResetAt - now;
            log.warn(`Global rate limit hit, waiting ${wait}ms`);
            await this.sleep(wait);
        }

        const bucket = this.buckets.get(route);
        if (bucket) {
            if (bucket.remaining <= 1 && bucket.resetAt > now) {
                const wait = bucket.resetAt - now + 100;
                log.debug(`Rate limit bucket ${route}: waiting ${wait}ms`);
                await this.sleep(wait);
            }
        }
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
        if (isGlobal) {
            this.globalResetAt = Date.now() + retryAfterMs;
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

        const res = await fetch(url, {
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

        const headerObj: Record<string, string> = {};
        res.headers.forEach((v, k) => { headerObj[k.toLowerCase()] = v; });
        rateLimiter.updateFromHeaders(route, headerObj);

        if (res.status === 429) {
            const body = await res.json() as { retry_after: number; global?: boolean };
            const retryMs = body.retry_after * 1000;
            log.warn(`429 on ${route} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying after ${retryMs}ms`);
            rateLimiter.handleRetryAfter(retryMs, !!body.global);
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
