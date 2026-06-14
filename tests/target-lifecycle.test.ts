process.env.DB_PATH        = ":memory:";
process.env.API_AUTH_TOKEN = "test-token";
process.env.DISCORD_TOKEN  = "test-token";
process.env.LOG_LEVEL      = "error";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupTestDb, teardownTestDb, insertTestTarget } from "./helpers";
import {
    refreshTargetCache,
    isTargetCached,
    getTargetTimezone,
    getActiveTargetCount,
    onTargetRemoved,
    isBootstrapping,
    getBootstrapCompletedAt,
    markBootstrapComplete,
} from "../src/target-lifecycle";

const TARGET_A = "111111111111111111";
const TARGET_B = "222222222222222222";

describe("target-lifecycle cache", () => {
    beforeEach(() => {
        setupTestDb();
    });
    afterEach(teardownTestDb);

    it("refreshTargetCache populates from active rows only", () => {
        insertTestTarget(TARGET_A, { active: true });
        insertTestTarget(TARGET_B, { active: false });
        refreshTargetCache();

        assert.equal(isTargetCached(TARGET_A), true);
        assert.equal(isTargetCached(TARGET_B), false);
        assert.equal(getActiveTargetCount(), 1);
    });

    it("getTargetTimezone returns 'UTC' for unknown targets", () => {
        assert.equal(getTargetTimezone("999999999999999999"), "UTC");
    });

    it("getTargetTimezone reflects the stored value for paused targets too", () => {
        insertTestTarget(TARGET_B, { active: false, timezone: "Europe/Berlin" });
        refreshTargetCache();
        // Paused targets keep their tz so analytics on past data still uses it.
        assert.equal(getTargetTimezone(TARGET_B), "Europe/Berlin");
    });

    it("getTargetTimezone reflects the stored tz for active targets", () => {
        insertTestTarget(TARGET_A, { timezone: "America/Chicago" });
        refreshTargetCache();
        assert.equal(getTargetTimezone(TARGET_A), "America/Chicago");
    });
});

describe("bootstrap cache", () => {
    beforeEach(() => {
        setupTestDb();
    });
    afterEach(teardownTestDb);

    it("isBootstrapping returns true for a freshly inserted bootstrap=pending row", () => {
        insertTestTarget(TARGET_A, { bootstrap: "pending" });
        refreshTargetCache();
        assert.equal(isBootstrapping(TARGET_A), true);
        // Pending = future timestamp (test helper uses now + 5 min)
        const v = getBootstrapCompletedAt(TARGET_A);
        assert.ok(v != null && v > Date.now(), "pending bootstrap_completed_at must be a future timestamp");
    });

    it("isBootstrapping returns false for a bootstrap=complete row", () => {
        insertTestTarget(TARGET_A, { bootstrap: "complete" });
        refreshTargetCache();
        assert.equal(isBootstrapping(TARGET_A), false);
        const v = getBootstrapCompletedAt(TARGET_A);
        assert.ok(v != null && v <= Date.now(), "complete bootstrap_completed_at must be in the past");
    });

    it("isBootstrapping returns true for unknown user ids (defensive)", () => {
        // Targets the cache hasn't seen yet are treated as bootstrapping so
        // tail events during target-removal races suppress rather than fire.
        assert.equal(isBootstrapping("999999999999999999"), true);
    });

    it("markBootstrapComplete force-completes a pending target and is idempotent", () => {
        insertTestTarget(TARGET_A, { bootstrap: "pending" });
        refreshTargetCache();
        assert.equal(isBootstrapping(TARGET_A), true);

        const firstFlip = markBootstrapComplete(TARGET_A);
        assert.equal(firstFlip, true);
        assert.equal(isBootstrapping(TARGET_A), false);

        // Second call should be a no-op — target is already operational.
        const secondFlip = markBootstrapComplete(TARGET_A);
        assert.equal(secondFlip, false);
        assert.equal(isBootstrapping(TARGET_A), false);
    });

    it("default insertTestTarget produces an operational target (back-compat for old tests)", () => {
        insertTestTarget(TARGET_A);
        refreshTargetCache();
        assert.equal(isBootstrapping(TARGET_A), false);
    });

    it("onTargetRemoved clears bootstrap state too", () => {
        insertTestTarget(TARGET_A, { bootstrap: "pending" });
        refreshTargetCache();
        onTargetRemoved(TARGET_A);
        // After removal the cache no longer has the user — defensive bootstrapping=true
        assert.equal(isBootstrapping(TARGET_A), true);
        assert.equal(getBootstrapCompletedAt(TARGET_A), null);
    });
});

describe("onTargetRemoved", () => {
    beforeEach(() => {
        setupTestDb();
    });
    afterEach(teardownTestDb);

    it("removes the target from the cache", () => {
        insertTestTarget(TARGET_A);
        refreshTargetCache();
        assert.equal(isTargetCached(TARGET_A), true);

        onTargetRemoved(TARGET_A);
        assert.equal(isTargetCached(TARGET_A), false);
        assert.equal(getTargetTimezone(TARGET_A), "UTC", "tz cache should be cleared (UTC default)");
    });

    it("is a no-op for unknown user ids", () => {
        // Should not throw — exercises the catch blocks in onTargetRemoved.
        assert.doesNotThrow(() => onTargetRemoved("000000000000000000"));
    });

    it("leaves other targets' state untouched", () => {
        insertTestTarget(TARGET_A);
        insertTestTarget(TARGET_B, { timezone: "Asia/Tokyo" });
        refreshTargetCache();

        onTargetRemoved(TARGET_A);
        assert.equal(isTargetCached(TARGET_B), true);
        assert.equal(getTargetTimezone(TARGET_B), "Asia/Tokyo");
    });
});
