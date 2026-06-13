import { config } from "./config";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

// Keys whose values must be masked before any structured logging. Matched
// case-insensitively against the property name. Covers Discord tokens,
// Supabase service keys, AI provider keys, webhook URLs, generic secrets,
// and credential-shaped fields.
const SENSITIVE_KEY_RE = /(token|secret|api[_-]?key|webhook|password|cookie|authorization|service[_-]?key|service_role)/i;

// Discord user / bot token shape. Three base64-url segments separated by dots.
// First segment ~24 chars, second ~6-7 chars, third ~27-38 chars. Catches
// raw token strings dropped into log arguments by accident.
const DISCORD_TOKEN_RE = /\b[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{5,10}\.[A-Za-z0-9_-]{20,40}\b/g;

// Supabase / JWT-shape secrets (header.payload.signature).
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// sk-… / sk-ant-… / Google AI Studio key shape (best-effort, conservative).
const PROVIDER_KEY_RE = /\b(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,})\b/g;

const REDACTED = "[REDACTED]";

function maskString(s: string): string {
    return s
        .replace(DISCORD_TOKEN_RE, REDACTED)
        .replace(JWT_RE, REDACTED)
        .replace(PROVIDER_KEY_RE, REDACTED);
}

/**
 * Walk a value recursively, masking sensitive fields and any string that
 * matches a known secret shape. Handles circular references with a WeakSet.
 */
function redact(value: any, seen: WeakSet<object> = new WeakSet()): any {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return maskString(value);
    if (typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(v => redact(v, seen));
    }
    // Buffers / typed arrays / Errors come through here too — fall back to a
    // safe string representation rather than enumerating arbitrary getters.
    if (value instanceof Error) {
        return { name: value.name, message: maskString(value.message), stack: value.stack ? maskString(value.stack) : undefined };
    }
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
        return "[Binary]";
    }

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(k)) {
            out[k] = REDACTED;
        } else {
            out[k] = redact(v, seen);
        }
    }
    return out;
}

function safeStringify(value: any): string {
    try {
        return JSON.stringify(redact(value));
    } catch {
        return "[Unserialisable]";
    }
}

function getTimestamp(): string {
    return new Date().toISOString();
}

function shouldLog(level: keyof typeof LOG_LEVELS): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
}

function formatMessage(level: string, module: string, message: string, data?: any): string {
    const ts = getTimestamp();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${module}]`;
    // Mask any inline secret that ended up in the message string itself.
    const safeMessage = maskString(message);
    if (data !== undefined) {
        return `${prefix} ${safeMessage} ${safeStringify(data)}`;
    }
    return `${prefix} ${safeMessage}`;
}

export function createLogger(module: string) {
    return {
        debug(message: string, data?: any) {
            if (shouldLog("debug")) {
                console.debug(formatMessage("debug", module, message, data));
            }
        },
        info(message: string, data?: any) {
            if (shouldLog("info")) {
                console.info(formatMessage("info", module, message, data));
            }
        },
        warn(message: string, data?: any) {
            if (shouldLog("warn")) {
                console.warn(formatMessage("warn", module, message, data));
            }
        },
        error(message: string, data?: any) {
            if (shouldLog("error")) {
                console.error(formatMessage("error", module, message, data));
            }
        },
    };
}
