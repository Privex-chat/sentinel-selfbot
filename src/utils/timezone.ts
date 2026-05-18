/**
 * Timezone parsing and offset utilities.
 *
 * Stores timezones as IANA identifiers when possible (e.g. "Europe/Berlin"),
 * falling back to fixed UTC±N notation (e.g. "UTC+2") for plain offset inputs.
 *
 * Resolution hierarchy:
 *   1. IANA name          →  "Europe/Berlin"
 *   2. Common abbreviation →  mapped to canonical IANA (best-effort)
 *   3. GMT/UTC offset      →  "UTC+2", "UTC-5:30"
 */

const ABBREVIATION_MAP: Record<string, string> = {
    // North America
    EST:  "America/New_York",
    EDT:  "America/New_York",
    CST:  "America/Chicago",
    CDT:  "America/Chicago",
    MST:  "America/Denver",
    MDT:  "America/Denver",
    PST:  "America/Los_Angeles",
    PDT:  "America/Los_Angeles",
    AKST: "America/Anchorage",
    AKDT: "America/Anchorage",
    HST:  "Pacific/Honolulu",

    // Europe
    GMT:  "Europe/London",
    BST:  "Europe/London",
    CET:  "Europe/Berlin",
    CEST: "Europe/Berlin",
    EET:  "Europe/Bucharest",
    EEST: "Europe/Bucharest",
    WET:  "Europe/Lisbon",
    WEST: "Europe/Lisbon",
    MSK:  "Europe/Moscow",

    // Asia / Oceania
    IST:  "Asia/Kolkata",
    JST:  "Asia/Tokyo",
    KST:  "Asia/Seoul",
    CST_ASIA: "Asia/Shanghai",
    HKT:  "Asia/Hong_Kong",
    SGT:  "Asia/Singapore",
    AEST: "Australia/Sydney",
    AEDT: "Australia/Sydney",
    ACST: "Australia/Adelaide",
    ACDT: "Australia/Adelaide",
    AWST: "Australia/Perth",
    NZST: "Pacific/Auckland",
    NZDT: "Pacific/Auckland",

    // Middle East / Africa
    IDT:  "Asia/Jerusalem",
    AST:  "Asia/Riyadh",
    GST:  "Asia/Dubai",
    PKT:  "Asia/Karachi",
    SAST: "Africa/Johannesburg",
    EAT:  "Africa/Nairobi",
    WAT:  "Africa/Lagos",
    CAT:  "Africa/Harare",
};

function isValidIANA(tz: string): boolean {
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

const OFFSET_RE = /^(?:UTC|GMT)\s*([+-])?\s*(\d{1,2})(?::(\d{2}))?$/i;
const BARE_OFFSET_RE = /^([+-])(\d{1,2})(?::(\d{2}))?$/;

export interface ParsedTimezone {
    /** Canonical identifier stored in the DB — IANA name or "UTC+N" / "UTC-N" / "UTC". */
    canonical: string;
    /** Friendly display label, e.g. "Europe/Berlin (CET)" or "UTC+2". */
    display: string;
}

/**
 * Parse a user-supplied timezone string into a canonical identifier.
 *
 * Accepted formats:
 *   - IANA:          "Europe/Berlin", "America/New_York"
 *   - Abbreviation:  "EST", "CET", "JST", "IST"
 *   - UTC/GMT offset: "UTC+2", "GMT-5", "UTC+5:30", "gmt+2", "utc"
 *   - Bare offset:   "+2", "-5", "+5:30"
 *   - Plain number:  "2" (→ UTC+2), "-3" (→ UTC-3)
 *
 * Returns null if the input cannot be parsed.
 */
export function parseTimezone(input: string): ParsedTimezone | null {
    const raw = input.trim();
    if (!raw) return null;

    // "UTC" / "GMT" alone
    if (/^(UTC|GMT)$/i.test(raw)) {
        return { canonical: "UTC", display: "UTC" };
    }

    // IANA identifier (contains "/")
    if (raw.includes("/")) {
        if (isValidIANA(raw)) {
            return { canonical: raw, display: raw };
        }
        // Try case-insensitive matching by normalising each segment
        const segments = raw.split("/").map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
        const normalised = segments.join("/");
        if (isValidIANA(normalised)) {
            return { canonical: normalised, display: normalised };
        }
        return null;
    }

    // UTC/GMT ± offset:  "UTC+2", "GMT-5", "UTC+5:30"
    const offsetMatch = raw.match(OFFSET_RE);
    if (offsetMatch) {
        return buildFromOffset(
            offsetMatch[1] || "+",
            parseInt(offsetMatch[2], 10),
            offsetMatch[3] ? parseInt(offsetMatch[3], 10) : 0,
        );
    }

    // Bare offset: "+2", "-5:30"
    const bareMatch = raw.match(BARE_OFFSET_RE);
    if (bareMatch) {
        return buildFromOffset(
            bareMatch[1],
            parseInt(bareMatch[2], 10),
            bareMatch[3] ? parseInt(bareMatch[3], 10) : 0,
        );
    }

    // Plain integer:  "2" → UTC+2, "-3" → UTC-3
    const numVal = Number(raw);
    if (!Number.isNaN(numVal) && Number.isFinite(numVal) && Number.isInteger(numVal) && Math.abs(numVal) <= 14) {
        const sign = numVal >= 0 ? "+" : "-";
        return buildFromOffset(sign, Math.abs(numVal), 0);
    }

    // Abbreviation lookup (case-insensitive)
    const upper = raw.toUpperCase();
    const mapped = ABBREVIATION_MAP[upper];
    if (mapped) {
        return { canonical: mapped, display: `${mapped} (${upper})` };
    }

    return null;
}

function buildFromOffset(sign: string, hours: number, minutes: number): ParsedTimezone | null {
    if (hours > 14 || minutes > 59) return null;
    if (hours === 0 && minutes === 0) {
        return { canonical: "UTC", display: "UTC" };
    }
    const minPart = minutes > 0 ? `:${String(minutes).padStart(2, "0")}` : "";
    const canonical = `UTC${sign}${hours}${minPart}`;
    return { canonical, display: canonical };
}

/**
 * Get the UTC offset in minutes for a stored timezone identifier at a given epoch-ms timestamp.
 * Positive = east of UTC.
 *
 * For IANA identifiers this correctly accounts for DST at the given timestamp.
 * For "UTC±N" strings it returns a fixed offset.
 * Returns 0 (UTC) for null / unparseable values.
 */
export function getTimezoneOffsetMinutes(tz: string | null | undefined, atMs: number = Date.now()): number {
    if (!tz) return 0;

    // Fixed UTC±H[:MM] offset
    const m = tz.match(/^UTC([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (m) {
        const sign = m[1] === "+" ? 1 : -1;
        return sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
    }
    if (tz === "UTC") return 0;

    // IANA: use Intl to compute offset including DST
    try {
        const d = new Date(atMs);
        const extractParts = (timeZone: string) => {
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone,
                year: "numeric", month: "numeric", day: "numeric",
                hour: "numeric", minute: "numeric", second: "numeric",
                hour12: false,
            }).formatToParts(d);
            const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? "0", 10);
            return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") === 24 ? 0 : get("hour"), get("minute"), get("second"));
        };
        return Math.round((extractParts(tz) - extractParts("UTC")) / 60_000);
    } catch {
        return 0;
    }
}

/**
 * Return the hour (0-23) at the given epoch-ms in the target's timezone.
 */
export function getHourInTimezone(epochMs: number, tz: string | null | undefined): number {
    if (!tz) return new Date(epochMs).getHours();

    // Try IANA first for DST correctness
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour: "numeric",
            hour12: false,
        }).formatToParts(new Date(epochMs));
        const hourPart = parts.find(p => p.type === "hour");
        if (hourPart) {
            const h = parseInt(hourPart.value, 10);
            return h === 24 ? 0 : h;
        }
    } catch {
        // fall through to offset
    }

    const offsetMin = getTimezoneOffsetMinutes(tz, epochMs);
    const shifted = new Date(epochMs + offsetMin * 60_000);
    return shifted.getUTCHours();
}

/**
 * Return the day-of-week (0=Sunday) at the given epoch-ms in the target's timezone.
 */
export function getDayInTimezone(epochMs: number, tz: string | null | undefined): number {
    if (!tz) return new Date(epochMs).getDay();

    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            weekday: "short",
        }).formatToParts(new Date(epochMs));
        const wdPart = parts.find(p => p.type === "weekday");
        if (wdPart) {
            const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
            return map[wdPart.value] ?? new Date(epochMs).getDay();
        }
    } catch {
        // fall through
    }

    const offsetMin = getTimezoneOffsetMinutes(tz, epochMs);
    const shifted = new Date(epochMs + offsetMin * 60_000);
    return shifted.getUTCDay();
}

/**
 * Format an epoch-ms timestamp as "HH:MM" in the target's timezone.
 */
export function fmtTimeInTz(epochMs: number, tz: string | null | undefined): string {
    if (!tz) {
        const d = new Date(epochMs);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    try {
        return new Intl.DateTimeFormat("en-GB", {
            timeZone: tz,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).format(new Date(epochMs));
    } catch {
        const offsetMin = getTimezoneOffsetMinutes(tz, epochMs);
        const shifted = new Date(epochMs + offsetMin * 60_000);
        return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
    }
}

/**
 * Format an epoch-ms timestamp as "YYYY-MM-DD HH:MM" in the target's timezone.
 */
export function fmtDateTimeInTz(epochMs: number, tz: string | null | undefined): string {
    if (!tz) {
        const d = new Date(epochMs);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${fmtTimeInTz(epochMs, tz)}`;
    }

    try {
        const d = new Date(epochMs);
        const datePart = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(d);
        return `${datePart} ${fmtTimeInTz(epochMs, tz)}`;
    } catch {
        const offsetMin = getTimezoneOffsetMinutes(tz, epochMs);
        const shifted = new Date(epochMs + offsetMin * 60_000);
        return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")} ${fmtTimeInTz(epochMs, tz)}`;
    }
}

/**
 * Return the epoch-ms of the start of the next local hour in the target's tz.
 * Used for accurate per-hour bucketing that respects DST and fractional offsets.
 */
export function getNextLocalHourMs(epochMs: number, tz: string | null | undefined): number {
    if (!tz) {
        const d = new Date(epochMs);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
    }

    const offsetMin = getTimezoneOffsetMinutes(tz, epochMs);
    const localMs = epochMs + offsetMin * 60_000;
    const msIntoHour = localMs % 3_600_000;
    const nextHourUtc = epochMs + (3_600_000 - msIntoHour);

    // Recompute offset at the boundary to handle DST transitions
    const offsetAtBoundary = getTimezoneOffsetMinutes(tz, nextHourUtc);
    if (offsetAtBoundary !== offsetMin) {
        const correctedLocalMs = nextHourUtc + offsetAtBoundary * 60_000;
        const correctedMsIntoHour = correctedLocalMs % 3_600_000;
        return nextHourUtc + (correctedMsIntoHour > 0 ? 3_600_000 - correctedMsIntoHour : 0);
    }

    return nextHourUtc;
}

export function fmtDateInTz(epochMs: number, tz: string | null | undefined): string {
    if (!tz) {
        const d = new Date(epochMs);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    try {
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(new Date(epochMs));
    } catch {
        const offsetMin = getTimezoneOffsetMinutes(tz, epochMs);
        const shifted = new Date(epochMs + offsetMin * 60_000);
        return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
    }
}

/** Short display string for a timezone, e.g. "UTC+2" or "CET". */
export function tzLabel(tz: string | null | undefined): string {
    if (!tz) return "Server";
    if (tz.startsWith("UTC")) return tz;
    // IANA: show the short abbreviation at current time
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            timeZoneName: "short",
        }).formatToParts(new Date());
        const tzPart = parts.find(p => p.type === "timeZoneName");
        return tzPart?.value ?? tz;
    } catch {
        return tz;
    }
}
