import { config } from "./config";

/**
 * Returns `intervalMs` with ±`percent`% random jitter applied when
 * RANDOM_JITTER=true, otherwise returns the value unchanged.
 * The result is always at least 1 000 ms.
 */
export function withJitter(intervalMs: number, percent = 20): number {
    if (!config.randomJitter) return intervalMs;
    const delta = intervalMs * (percent / 100);
    return Math.max(1_000, Math.round(intervalMs + (Math.random() * 2 - 1) * delta));
}

/**
 * Sleep for `baseMs` ± `percent`% jitter.
 */
export function jitterSleep(baseMs: number, percent = 20): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, withJitter(baseMs, percent)));
}