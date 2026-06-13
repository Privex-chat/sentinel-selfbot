/**
 * Secret-at-rest encryption for runtime_config values.
 *
 * The selfbot stores Discord tokens, AI API keys, Supabase service keys and
 * webhook URLs in the runtime_config SQLite table — and, in cloud mode, syncs
 * them to Supabase so a redeploy doesn't wipe them. Storing plaintext in two
 * places means a leaked DB backup or stolen service key gives an attacker
 * everything in one go. AES-256-GCM with a host-side key reduces that to "you
 * also need the SENTINEL_DATA_KEY env var".
 *
 * Format on disk:  enc:v1:<iv_b64>:<ciphertext_b64>:<authtag_b64>
 *
 * Plaintext values WITHOUT the `enc:v1:` prefix are still accepted on read —
 * this is what makes the rollout backward-compatible. Existing rows continue
 * to work; the next write upgrades them.
 *
 * Key material: a 32-byte (256-bit) value, base64-encoded, in
 * `process.env.SENTINEL_DATA_KEY`. Generate with:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * When SENTINEL_DATA_KEY is missing or malformed:
 *   - encryptSensitive() returns the plaintext unchanged with a one-time warn
 *     so the operator notices their secrets are still plaintext.
 *   - decryptValue() will fail on any `enc:v1:` row and surface a clear error.
 */

import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    timingSafeEqual,
} from "node:crypto";
import { createLogger } from "./logger";

const log = createLogger("Crypto");

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard
const KEY_LENGTH = 32; // 256-bit

let _key: Buffer | null | undefined;
let warnedMissingKey = false;

function loadKey(): Buffer | null {
    if (_key !== undefined) return _key;
    const raw = process.env.SENTINEL_DATA_KEY;
    if (!raw) { _key = null; return null; }
    try {
        const buf = Buffer.from(raw, "base64");
        if (buf.length !== KEY_LENGTH) {
            log.warn(
                `SENTINEL_DATA_KEY decoded to ${buf.length} bytes; expected ${KEY_LENGTH}. ` +
                `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
            );
            _key = null;
            return null;
        }
        _key = buf;
        return buf;
    } catch (err: any) {
        log.warn(`SENTINEL_DATA_KEY is not valid base64: ${err.message}`);
        _key = null;
        return null;
    }
}

export function hasDataKey(): boolean {
    return loadKey() !== null;
}

function warnOnceMissingKey(): void {
    if (warnedMissingKey) return;
    warnedMissingKey = true;
    log.warn(
        "SENTINEL_DATA_KEY is not set — sensitive runtime_config values " +
        "(DISCORD_TOKEN, AI_API_KEY, SUPABASE_SERVICE_KEY, webhook URLs) " +
        "will be stored as plaintext. Set the env var to enable encryption."
    );
}

/**
 * Encrypt a value if SENTINEL_DATA_KEY is present and the value is non-empty.
 * Returns the original value unchanged when no key is configured.
 *
 * Idempotent: calling on an already-encrypted (`enc:v1:`) value returns it
 * unchanged so accidental double-encrypt is a no-op.
 */
export function encryptSensitive(plaintext: string): string {
    if (!plaintext) return plaintext;
    if (plaintext.startsWith(PREFIX)) return plaintext;

    const key = loadKey();
    if (!key) { warnOnceMissingKey(); return plaintext; }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

/**
 * Decrypt a value if it carries the `enc:v1:` prefix. Returns the value
 * unchanged when it doesn't (legacy plaintext rows). Throws when the prefix
 * is present but decryption fails — caller decides whether to swallow.
 */
export function decryptValue(stored: string): string {
    if (!stored || !stored.startsWith(PREFIX)) return stored;

    const key = loadKey();
    if (!key) {
        throw new Error(
            "Encrypted value present but SENTINEL_DATA_KEY is not set. " +
            "Set the env var to the same value used when the row was written."
        );
    }

    const parts = stored.slice(PREFIX.length).split(":");
    if (parts.length !== 3) {
        throw new Error("Malformed enc:v1 envelope (expected 3 colon-separated segments)");
    }
    const [ivB64, ctB64, tagB64] = parts;
    const iv = Buffer.from(ivB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const tag = Buffer.from(tagB64, "base64");

    // Defensive length checks before passing to crypto APIs that can be
    // sensitive to malformed inputs.
    if (iv.length !== IV_LENGTH || tag.length !== 16) {
        throw new Error("Malformed enc:v1 envelope (bad IV or auth-tag length)");
    }

    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
}

/**
 * Used for unit-test-style equality checks against decrypted values. Exposed
 * so callers don't reach for `===` on a Buffer pair.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}
