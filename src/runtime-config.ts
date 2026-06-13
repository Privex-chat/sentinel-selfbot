import { getDb } from "./database/connection";
import { config } from "./utils/config";
import { createLogger } from "./utils/logger";
import { encryptSensitive, decryptValue } from "./utils/crypto";

const log = createLogger("RuntimeConfig");

// Values masked to "••••••••" in the GET /api/config response
export const SENSITIVE_KEYS = new Set([
    "DISCORD_TOKEN",
    "AI_API_KEY",
    "SUPABASE_SERVICE_KEY",
    "ALERT_WEBHOOK_URL",
    "CRITICAL_WEBHOOK_URL",
]);

// All keys that can be changed at runtime without restarting the selfbot.
// Excluded: DB_MODE, DB_PATH, LOG_LEVEL, API_PORT, API_AUTH_TOKEN, RANDOM_JITTER
export const RUNTIME_KEYS = [
    "DISCORD_TOKEN",
    "ALERT_WEBHOOK_URL",
    "CRITICAL_WEBHOOK_URL",
    "AI_PROVIDER",
    "AI_MODEL",
    "AI_API_KEY",
    "AI_BASE_URL",
    "AI_ANALYSIS_INTERVAL_MS",
    "AI_CATEGORIZATION_BATCH_SIZE",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_SYNC_INTERVAL_MS",
    "BACKFILL_ENABLED",
    "BACKFILL_MAX_DAYS",
    "BACKFILL_MAX_MESSAGES_PER_CHANNEL",
    "ALERT_DIGEST_MODE",
    "ALERT_DIGEST_INTERVAL_MS",
    "ALERT_FATIGUE_THRESHOLD",
    "BRIEF_GENERATION_TIME",
    "PROFILE_POLL_INTERVAL_MS",
    "STATUS_POLL_INTERVAL_MS",
    "DAILY_SUMMARY_INTERVAL_MS",
] as const;

export type RuntimeKey = typeof RUNTIME_KEYS[number];

type ChangeCallback = (key: RuntimeKey, value: string) => void;
const changeListeners = new Map<RuntimeKey, ChangeCallback[]>();

// Minimum values for interval/numeric keys to prevent degenerate configurations.
const NUMERIC_MIN: Partial<Record<RuntimeKey, number>> = {
    AI_ANALYSIS_INTERVAL_MS:          60_000,    // 1 min
    AI_CATEGORIZATION_BATCH_SIZE:     1,
    SUPABASE_SYNC_INTERVAL_MS:        10_000,    // 10 s
    BACKFILL_MAX_DAYS:                1,
    BACKFILL_MAX_MESSAGES_PER_CHANNEL:1,
    ALERT_DIGEST_INTERVAL_MS:         60_000,    // 1 min
    ALERT_FATIGUE_THRESHOLD:          1,
    PROFILE_POLL_INTERVAL_MS:         60_000,    // 1 min
    STATUS_POLL_INTERVAL_MS:          30_000,    // 30 s
    DAILY_SUMMARY_INTERVAL_MS:        300_000,   // 5 min
};

// Maps env key names → config object props + type parsers.
// Declared above validateRuntimeValue so the validator's KEY_MAP reference
// is resolved at definition time (avoids a temporal-dead-zone footgun if a
// caller ever invokes the validator during module init).
const KEY_MAP: Record<RuntimeKey, { prop: keyof typeof config; parse: (v: string) => any }> = {
    DISCORD_TOKEN:                    { prop: "discordToken",              parse: v => v },
    ALERT_WEBHOOK_URL:                { prop: "alertWebhookUrl",           parse: v => v },
    CRITICAL_WEBHOOK_URL:             { prop: "criticalWebhookUrl",        parse: v => v },
    AI_PROVIDER:                      { prop: "aiProvider",                parse: v => v },
    AI_MODEL:                         { prop: "aiModel",                   parse: v => v },
    AI_API_KEY:                       { prop: "aiApiKey",                  parse: v => v },
    AI_BASE_URL:                      { prop: "aiBaseUrl",                 parse: v => v },
    AI_ANALYSIS_INTERVAL_MS:          { prop: "aiAnalysisIntervalMs",      parse: v => parseInt(v, 10) },
    AI_CATEGORIZATION_BATCH_SIZE:     { prop: "aiCategorizationBatchSize", parse: v => parseInt(v, 10) },
    SUPABASE_URL:                     { prop: "supabaseUrl",               parse: v => v },
    SUPABASE_SERVICE_KEY:             { prop: "supabaseServiceKey",        parse: v => v },
    SUPABASE_SYNC_INTERVAL_MS:        { prop: "supabaseSyncIntervalMs",    parse: v => parseInt(v, 10) },
    BACKFILL_ENABLED:                 { prop: "backfillEnabled",           parse: v => v !== "false" },
    BACKFILL_MAX_DAYS:                { prop: "backfillMaxDays",           parse: v => parseInt(v, 10) },
    BACKFILL_MAX_MESSAGES_PER_CHANNEL:{ prop: "backfillMaxMsgsPerChannel", parse: v => parseInt(v, 10) },
    ALERT_DIGEST_MODE:                { prop: "alertDigestMode",           parse: v => v === "true" },
    ALERT_DIGEST_INTERVAL_MS:         { prop: "alertDigestIntervalMs",     parse: v => parseInt(v, 10) },
    ALERT_FATIGUE_THRESHOLD:          { prop: "alertFatigueThreshold",     parse: v => parseInt(v, 10) },
    BRIEF_GENERATION_TIME:            { prop: "briefGenerationTime",       parse: v => v },
    PROFILE_POLL_INTERVAL_MS:         { prop: "profilePollIntervalMs",     parse: v => parseInt(v, 10) },
    STATUS_POLL_INTERVAL_MS:          { prop: "statusPollIntervalMs",      parse: v => parseInt(v, 10) },
    DAILY_SUMMARY_INTERVAL_MS:        { prop: "dailySummaryIntervalMs",    parse: v => parseInt(v, 10) },
};

/**
 * Validate a runtime value before it is applied and persisted.
 * Returns an error message string on failure, or null on success.
 */
function validateRuntimeValue(key: RuntimeKey, value: string): string | null {
    const entry = KEY_MAP[key];
    if (!entry) return null;

    // Non-empty check for required string keys
    if (key === "DISCORD_TOKEN" && !value.trim()) {
        return "DISCORD_TOKEN cannot be empty";
    }

    // Time format check for brief generation time (HH:MM, 00:00–23:59)
    if (key === "BRIEF_GENERATION_TIME") {
        if (!/^\d{2}:\d{2}$/.test(value)) {
            return "BRIEF_GENERATION_TIME must be in HH:MM format (e.g. 07:00)";
        }
        const [h, m] = value.split(":").map(Number);
        if (h > 23 || m > 59) {
            return "BRIEF_GENERATION_TIME must be a valid time (00:00–23:59)";
        }
    }

    // Numeric range checks
    const min = NUMERIC_MIN[key];
    if (min !== undefined) {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed)) return `${key} must be a valid integer`;
        if (parsed < min)  return `${key} must be at least ${min}`;
    }

    return null;
}

function applyToConfig(key: RuntimeKey, value: string): void {
    const entry = KEY_MAP[key];
    if (!entry) return;
    (config as any)[entry.prop] = entry.parse(value);
}

function getConfigValue(key: RuntimeKey): string {
    const entry = KEY_MAP[key];
    if (!entry) return "";
    const val = (config as any)[entry.prop];
    if (typeof val === "boolean") return val ? "true" : "false";
    if (typeof val === "number") return String(val);
    return String(val ?? "");
}

/** Load persisted overrides from the DB and apply them on top of .env defaults. */
export function loadRuntimeConfig(): void {
    const db   = getDb();
    const rows = db.prepare("SELECT key, value FROM runtime_config").all() as { key: string; value: string }[];

    let applied = 0;
    for (const { key, value } of rows) {
        if (!(RUNTIME_KEYS as readonly string[]).includes(key)) continue;

        // Values written by setRuntimeConfig for sensitive keys carry the
        // `enc:v1:` envelope. Legacy plaintext rows pass through unchanged.
        // Failed decryption (e.g. SENTINEL_DATA_KEY rotated without re-write)
        // is logged and the key is skipped so the bot still boots with .env
        // fallbacks instead of crashing the runtime config load.
        let plaintext: string;
        try {
            plaintext = decryptValue(value);
        } catch (err: any) {
            log.error(
                `Skipping runtime_config "${key}" — decrypt failed: ${err.message}. ` +
                `Falling back to .env value (if any).`
            );
            continue;
        }

        applyToConfig(key as RuntimeKey, plaintext);
        applied++;
        log.debug(`Loaded: ${key}${SENSITIVE_KEYS.has(key) ? " [sensitive]" : ` = ${plaintext}`}`);
    }

    log.info(`Runtime config loaded (${applied} override(s) from DB)`);
}

/** Returns all runtime keys with sensitive values replaced by "••••••••". */
export function getRuntimeConfigMasked(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of RUNTIME_KEYS) {
        const val = getConfigValue(key);
        result[key] = SENSITIVE_KEYS.has(key) && val ? "••••••••" : val;
    }
    return result;
}

/** Persist a new value, update the in-memory config object, and fire callbacks. */
export function setRuntimeConfig(key: RuntimeKey, value: string): void {
    const validationError = validateRuntimeValue(key, value);
    if (validationError) {
        throw new Error(validationError);
    }

    // Encrypt sensitive values before persisting. The in-memory config object
    // and onChange listeners still see plaintext — encryption is purely an
    // at-rest concern. When SENTINEL_DATA_KEY is absent, encryptSensitive is a
    // no-op (with a one-time warn) so this path stays backward-compatible.
    const stored = SENSITIVE_KEYS.has(key) ? encryptSensitive(value) : value;

    const db = getDb();
    db.prepare(
        `INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, stored, Date.now());

    applyToConfig(key, value);
    log.info(`Config updated: ${key}${SENSITIVE_KEYS.has(key) ? " [sensitive]" : ` = ${value}`}`);

    const listeners = changeListeners.get(key) ?? [];
    for (const cb of listeners) {
        try { cb(key, value); }
        catch (err: any) { log.error(`onChange callback error for ${key}: ${err.message}`); }
    }
}

/** Register a side-effect callback that fires whenever a key is changed via setRuntimeConfig. */
export function onConfigChange(key: RuntimeKey, cb: ChangeCallback): void {
    const arr = changeListeners.get(key) ?? [];
    arr.push(cb);
    changeListeners.set(key, arr);
}

/**
 * Re-fire every registered `onConfigChange` listener using the current in-memory
 * value of each key. Intended for the `$reload` self-command which previously
 * called `loadRuntimeConfig()` (which loads values but does *not* fire side-effect
 * callbacks). Without this, $reload could not actually trigger a gateway
 * reconnect, AI provider reset, brief reschedule, etc.
 */
export function triggerAllConfigListeners(): void {
    for (const [key, listeners] of changeListeners) {
        if (!listeners.length) continue;
        const value = getConfigValue(key);
        for (const cb of listeners) {
            try { cb(key, value); }
            catch (err: any) { log.error(`onChange callback error for ${key} during reload: ${err.message}`); }
        }
    }
}
