/**
 * Per-target timezone helpers.
 *
 * Every analyser that interprets an epoch-ms timestamp as "what hour was the
 * target awake" / "what day of week was this" goes through here. The previous
 * implementation used Date.prototype.getHours()/getDay() which silently
 * computed in the *host* timezone — wrong for any cross-timezone tracking and
 * a steady source of off-by-N anomalies on non-UTC servers.
 *
 * Uses Intl.DateTimeFormat (zero deps, ICU data already bundled with Node).
 * Formatters are cached per (zone, kind) so analysers iterating thousands of
 * events pay one ICU construction and N microsecond format calls.
 *
 * Default zone everywhere is "UTC" — matches the targets.timezone column
 * default. Invalid zones fall back to UTC with a one-time warn so a typo'd
 * IANA name never crashes the analyser pipeline.
 */

import { createLogger } from "./logger";

const log = createLogger("Timezone");

const PARTS_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
const warnedBadZones = new Set<string>();

/** True iff the string is an IANA timezone Node can resolve (e.g. "UTC", "America/New_York"). */
export function isValidTimezone(tz: string): boolean {
    if (!tz || typeof tz !== "string") return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function getPartsFormatter(tz: string): Intl.DateTimeFormat {
    let f = PARTS_FMT_CACHE.get(tz);
    if (f) return f;

    try {
        f = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour12:   false,
            year:     "numeric",
            month:    "2-digit",
            day:      "2-digit",
            hour:     "2-digit",
            minute:   "2-digit",
            second:   "2-digit",
            weekday:  "short",
        });
    } catch {
        // Invalid tz — fall back to UTC. Warn once per zone so the operator
        // notices a typo without flooding the log.
        if (!warnedBadZones.has(tz)) {
            warnedBadZones.add(tz);
            log.warn(`Invalid IANA timezone "${tz}" — falling back to UTC for affected operations`);
        }
        f = PARTS_FMT_CACHE.get("UTC") ?? new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC", hour12: false,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            weekday: "short",
        });
    }

    PARTS_FMT_CACHE.set(tz, f);
    return f;
}

export interface TzParts {
    year:    number;     // e.g. 2026
    month:   number;     // 1-12
    day:     number;     // 1-31
    hour:    number;     // 0-23
    minute:  number;     // 0-59
    second:  number;     // 0-59
    weekday: number;     // 0=Sunday … 6=Saturday (matches Date.prototype.getDay)
}

const WEEKDAY_INDEX: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Decompose an epoch into local-to-`tz` calendar parts (single ICU call). */
export function getPartsInTz(epochMs: number, tz: string): TzParts {
    const fmt = getPartsFormatter(tz);
    const parts = fmt.formatToParts(new Date(epochMs));

    let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, weekday = 0;
    for (const p of parts) {
        switch (p.type) {
            case "year":    year    = parseInt(p.value, 10); break;
            case "month":   month   = parseInt(p.value, 10); break;
            case "day":     day     = parseInt(p.value, 10); break;
            case "hour":    hour    = parseInt(p.value, 10); break;
            case "minute":  minute  = parseInt(p.value, 10); break;
            case "second":  second  = parseInt(p.value, 10); break;
            case "weekday": weekday = WEEKDAY_INDEX[p.value] ?? 0; break;
        }
    }

    // Intl reports hour as "24" at midnight in some Node versions — normalize.
    if (hour === 24) hour = 0;

    return { year, month, day, hour, minute, second, weekday };
}

/** Hour-of-day in `tz` (0-23). */
export function getHourInTz(epochMs: number, tz: string): number {
    return getPartsInTz(epochMs, tz).hour;
}

/** Hour-of-day plus minute fraction in `tz` (e.g. 23.5 for 23:30). */
export function getHourFloatInTz(epochMs: number, tz: string): number {
    const p = getPartsInTz(epochMs, tz);
    return p.hour + p.minute / 60;
}

/** 0 = Sunday … 6 = Saturday, in `tz`. Matches Date.prototype.getDay(). */
export function getDayOfWeekInTz(epochMs: number, tz: string): number {
    return getPartsInTz(epochMs, tz).weekday;
}

/** YYYY-MM-DD as observed in `tz`. */
export function getDateStrInTz(epochMs: number, tz: string): string {
    const p = getPartsInTz(epochMs, tz);
    const mm = String(p.month).padStart(2, "0");
    const dd = String(p.day).padStart(2, "0");
    return `${p.year}-${mm}-${dd}`;
}
