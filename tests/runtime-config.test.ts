// runtime-config imports config.ts which reads process.env at module load.
// Set the minimum required env BEFORE importing anything from src/.
process.env.DB_PATH        = ":memory:";
process.env.API_AUTH_TOKEN = "test-token";
process.env.DISCORD_TOKEN  = "test-token";
process.env.LOG_LEVEL      = "error";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateRuntimeValue } from "../src/runtime-config";

describe("validateRuntimeValue — required strings", () => {
    it("rejects empty DISCORD_TOKEN", () => {
        const err = validateRuntimeValue("DISCORD_TOKEN", "");
        assert.match(err ?? "", /cannot be empty/);
    });

    it("accepts non-empty DISCORD_TOKEN", () => {
        assert.equal(validateRuntimeValue("DISCORD_TOKEN", "abc.def.ghi"), null);
    });
});

describe("validateRuntimeValue — BRIEF_GENERATION_TIME", () => {
    it("accepts 07:00", () => {
        assert.equal(validateRuntimeValue("BRIEF_GENERATION_TIME", "07:00"), null);
    });

    it("accepts 23:59", () => {
        assert.equal(validateRuntimeValue("BRIEF_GENERATION_TIME", "23:59"), null);
    });

    it("rejects 24:00 (hour out of range)", () => {
        const err = validateRuntimeValue("BRIEF_GENERATION_TIME", "24:00");
        assert.match(err ?? "", /00:00–23:59/);
    });

    it("rejects 12:60 (minute out of range)", () => {
        const err = validateRuntimeValue("BRIEF_GENERATION_TIME", "12:60");
        assert.match(err ?? "", /00:00–23:59/);
    });

    it("rejects 7am (not HH:MM)", () => {
        const err = validateRuntimeValue("BRIEF_GENERATION_TIME", "7am");
        assert.match(err ?? "", /HH:MM format/);
    });

    it("rejects empty string", () => {
        const err = validateRuntimeValue("BRIEF_GENERATION_TIME", "");
        assert.match(err ?? "", /HH:MM format/);
    });
});

describe("validateRuntimeValue — AI_PROVIDER enum", () => {
    for (const v of ["none", "ollama", "openai", "anthropic", "gemini"]) {
        it(`accepts ${v}`, () => {
            assert.equal(validateRuntimeValue("AI_PROVIDER", v), null);
        });
    }

    it("rejects unknown provider", () => {
        const err = validateRuntimeValue("AI_PROVIDER", "mistral");
        assert.match(err ?? "", /must be one of/);
    });

    it("rejects empty string", () => {
        const err = validateRuntimeValue("AI_PROVIDER", "");
        assert.match(err ?? "", /must be one of/);
    });
});

describe("validateRuntimeValue — numeric minimums", () => {
    it("rejects AI_ANALYSIS_INTERVAL_MS below 60_000", () => {
        const err = validateRuntimeValue("AI_ANALYSIS_INTERVAL_MS", "5000");
        assert.match(err ?? "", /at least 60000/);
    });

    it("accepts AI_ANALYSIS_INTERVAL_MS at the floor", () => {
        assert.equal(validateRuntimeValue("AI_ANALYSIS_INTERVAL_MS", "60000"), null);
    });

    it("rejects negative AI_CATEGORIZATION_BATCH_SIZE", () => {
        const err = validateRuntimeValue("AI_CATEGORIZATION_BATCH_SIZE", "-1");
        assert.match(err ?? "", /at least 1/);
    });

    it("rejects non-integer SUPABASE_SYNC_INTERVAL_MS", () => {
        const err = validateRuntimeValue("SUPABASE_SYNC_INTERVAL_MS", "abc");
        assert.match(err ?? "", /valid integer/);
    });

    it("accepts ALERT_FATIGUE_THRESHOLD = 1", () => {
        assert.equal(validateRuntimeValue("ALERT_FATIGUE_THRESHOLD", "1"), null);
    });

    it("rejects ALERT_FATIGUE_THRESHOLD = 0", () => {
        const err = validateRuntimeValue("ALERT_FATIGUE_THRESHOLD", "0");
        assert.match(err ?? "", /at least 1/);
    });

    it("rejects PROFILE_POLL_INTERVAL_MS below 60_000", () => {
        const err = validateRuntimeValue("PROFILE_POLL_INTERVAL_MS", "10000");
        assert.match(err ?? "", /at least 60000/);
    });
});

describe("validateRuntimeValue — free-form strings", () => {
    it("accepts arbitrary AI_MODEL", () => {
        assert.equal(validateRuntimeValue("AI_MODEL", "gemini-2.0-flash"), null);
    });

    it("accepts arbitrary SUPABASE_URL", () => {
        assert.equal(validateRuntimeValue("SUPABASE_URL", "https://x.supabase.co"), null);
    });

    it("accepts blank AI_API_KEY (validation is enum/numeric only)", () => {
        // The key is free-form here — server-side checks happen elsewhere.
        assert.equal(validateRuntimeValue("AI_API_KEY", ""), null);
    });
});
