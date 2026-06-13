// Engine tests need a working DB (KEYWORD_MENTION reads messages, NEW_GAME
// uses the games-seen cache that lazy-seeds from activity_sessions).
process.env.DB_PATH        = ":memory:";
process.env.API_AUTH_TOKEN = "test-token";
process.env.DISCORD_TOKEN  = "test-token";
process.env.LOG_LEVEL      = "error";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupTestDb, teardownTestDb, insertTestTarget } from "../helpers";
import { getDb } from "../../src/database/connection";
import { getStmts } from "../../src/database/queries";
import { setAlertCallback, reloadRules, evaluateEvent } from "../../src/alerts/engine";
import { refreshTargetCache } from "../../src/target-lifecycle";

const TARGET = "111111111111111111";

interface CapturedAlert {
    ruleId: number;
    targetId: string;
    alertType: string;
    message: string;
}

function captureAlerts(): { fired: CapturedAlert[]; reset: () => void } {
    const fired: CapturedAlert[] = [];
    setAlertCallback(alert => fired.push(alert));
    return { fired, reset: () => fired.splice(0, fired.length) };
}

function insertRule(ruleType: string, condition: any = {}, opts: { target?: string | null; targetId?: string } = {}): number {
    const target = "target" in opts ? opts.target : TARGET;
    const result = getStmts().insertAlertRule.run(
        target ?? null,
        ruleType,
        JSON.stringify(condition),
        1,
        Date.now(),
        0,    // digest_mode
        20,   // fatigue_threshold
        null, // composite_condition
    );
    reloadRules();
    return Number(result.lastInsertRowid);
}

describe("evaluateEvent — presence rules", () => {
    let fired: CapturedAlert[];

    beforeEach(() => {
        setupTestDb();
        insertTestTarget(TARGET);
        refreshTargetCache();
        ({ fired } = captureAlerts());
    });
    afterEach(teardownTestDb);

    it("COMES_ONLINE fires when newStatus is online", () => {
        insertRule("COMES_ONLINE");
        evaluateEvent("PRESENCE_UPDATE", TARGET, JSON.stringify({
            oldStatus: "offline", newStatus: "online",
        }));
        assert.equal(fired.length, 1);
        assert.equal(fired[0].alertType, "COMES_ONLINE");
    });

    it("COMES_ONLINE skips non-online transitions", () => {
        insertRule("COMES_ONLINE");
        evaluateEvent("PRESENCE_UPDATE", TARGET, JSON.stringify({
            oldStatus: "online", newStatus: "idle",
        }));
        assert.equal(fired.length, 0);
    });

    it("COMES_ONLINE respects after_hour against the target's timezone", () => {
        // Target in America/New_York (UTC-4 DST). Rule fires only after 22:00 NY time.
        const db = getDb();
        db.prepare("UPDATE targets SET timezone = ? WHERE user_id = ?").run("America/New_York", TARGET);
        refreshTargetCache();
        insertRule("COMES_ONLINE", { after_hour: 22 });

        // 2026-06-13T01:00:00Z = 21:00 NY → should NOT fire
        evaluateEvent(
            "PRESENCE_UPDATE", TARGET,
            JSON.stringify({ oldStatus: "offline", newStatus: "online" }),
            Date.UTC(2026, 5, 13, 1, 0, 0)
        );
        assert.equal(fired.length, 0);

        // 2026-06-13T03:00:00Z = 23:00 NY → should fire
        evaluateEvent(
            "PRESENCE_UPDATE", TARGET,
            JSON.stringify({ oldStatus: "offline", newStatus: "online" }),
            Date.UTC(2026, 5, 13, 3, 0, 0)
        );
        assert.equal(fired.length, 1);
    });

    it("GOES_OFFLINE fires when newStatus is offline", () => {
        insertRule("GOES_OFFLINE");
        evaluateEvent("PRESENCE_UPDATE", TARGET, JSON.stringify({
            oldStatus: "online", newStatus: "offline",
        }));
        assert.equal(fired.length, 1);
    });

    it("STATUS_CHANGE matches a specific transition", () => {
        insertRule("STATUS_CHANGE", { field: "transition", value: "online->idle" });
        evaluateEvent("PRESENCE_UPDATE", TARGET, JSON.stringify({
            oldStatus: "online", newStatus: "idle",
        }));
        assert.equal(fired.length, 1);
    });

    it("STATUS_CHANGE specific transition does NOT match other transitions", () => {
        insertRule("STATUS_CHANGE", { field: "transition", value: "online->idle" });
        evaluateEvent("PRESENCE_UPDATE", TARGET, JSON.stringify({
            oldStatus: "online", newStatus: "offline",
        }));
        assert.equal(fired.length, 0);
    });

    it("UNUSUAL_HOUR fires in the target's local 02:00–06:00 window", () => {
        const db = getDb();
        db.prepare("UPDATE targets SET timezone = ? WHERE user_id = ?").run("America/New_York", TARGET);
        refreshTargetCache();
        insertRule("UNUSUAL_HOUR", { start_hour: 2, end_hour: 6 });

        // 2026-06-13T07:00:00Z = 03:00 NY → fires
        evaluateEvent(
            "PRESENCE_UPDATE", TARGET,
            JSON.stringify({ newStatus: "online" }),
            Date.UTC(2026, 5, 13, 7, 0, 0)
        );
        assert.equal(fired.length, 1);
    });

    it("UNUSUAL_HOUR ignores offline transitions", () => {
        insertRule("UNUSUAL_HOUR", { start_hour: 0, end_hour: 24 });
        evaluateEvent(
            "PRESENCE_UPDATE", TARGET,
            JSON.stringify({ newStatus: "offline" }),
            Date.UTC(2026, 5, 13, 4, 0, 0)
        );
        assert.equal(fired.length, 0);
    });
});

describe("evaluateEvent — activity rules", () => {
    let fired: CapturedAlert[];

    beforeEach(() => {
        setupTestDb();
        insertTestTarget(TARGET);
        refreshTargetCache();
        ({ fired } = captureAlerts());
    });
    afterEach(teardownTestDb);

    it("STARTS_ACTIVITY without value matches any start", () => {
        insertRule("STARTS_ACTIVITY");
        evaluateEvent("ACTIVITY_START", TARGET, JSON.stringify({ name: "Anything", type: 0 }));
        assert.equal(fired.length, 1);
    });

    it("STARTS_ACTIVITY value matches case-insensitively", () => {
        insertRule("STARTS_ACTIVITY", { value: "valorant" });
        evaluateEvent("ACTIVITY_START", TARGET, JSON.stringify({ name: "VALORANT", type: 0 }));
        assert.equal(fired.length, 1);
    });

    it("STARTS_ACTIVITY value does not match unrelated activity", () => {
        insertRule("STARTS_ACTIVITY", { value: "valorant" });
        evaluateEvent("ACTIVITY_START", TARGET, JSON.stringify({ name: "Spotify", type: 2 }));
        assert.equal(fired.length, 0);
    });

    it("STOPS_ACTIVITY fires on ACTIVITY_END", () => {
        insertRule("STOPS_ACTIVITY");
        evaluateEvent("ACTIVITY_END", TARGET, JSON.stringify({ name: "Game", type: 0 }));
        assert.equal(fired.length, 1);
    });

    it("NEW_GAME fires the first time and not the second", () => {
        insertRule("NEW_GAME");

        evaluateEvent("ACTIVITY_START", TARGET, JSON.stringify({ name: "Hades II", type: 0 }));
        assert.equal(fired.length, 1, "first start should fire");

        evaluateEvent("ACTIVITY_START", TARGET, JSON.stringify({ name: "Hades II", type: 0 }));
        assert.equal(fired.length, 1, "second start of same game should NOT fire");
    });

    it("NEW_GAME ignores non-game activities (type != 0)", () => {
        insertRule("NEW_GAME");
        evaluateEvent("ACTIVITY_START", TARGET, JSON.stringify({ name: "Some song", type: 2 }));
        assert.equal(fired.length, 0);
    });
});

describe("evaluateEvent — message rules", () => {
    let fired: CapturedAlert[];

    beforeEach(() => {
        setupTestDb();
        insertTestTarget(TARGET);
        refreshTargetCache();
        ({ fired } = captureAlerts());
    });
    afterEach(teardownTestDb);

    it("SENDS_MESSAGE fires on every MESSAGE_CREATE by default", () => {
        insertRule("SENDS_MESSAGE");
        evaluateEvent("MESSAGE_CREATE", TARGET, JSON.stringify({
            messageId: "1", channelId: "c1", guildId: "g1",
        }));
        assert.equal(fired.length, 1);
    });

    it("SENDS_MESSAGE with channelId filter ignores other channels", () => {
        insertRule("SENDS_MESSAGE", { field: "channelId", value: "c1" });
        evaluateEvent("MESSAGE_CREATE", TARGET, JSON.stringify({
            messageId: "1", channelId: "c2", guildId: "g1",
        }));
        assert.equal(fired.length, 0);
    });

    it("DELETES_MESSAGE fires on MESSAGE_DELETE", () => {
        insertRule("DELETES_MESSAGE");
        evaluateEvent("MESSAGE_DELETE", TARGET, JSON.stringify({ messageId: "1" }));
        assert.equal(fired.length, 1);
    });

    it("KEYWORD_MENTION looks at stored message content", () => {
        // Seed a message row so the engine can resolve content from messageId.
        getDb().prepare(
            "INSERT INTO messages (message_id, target_id, channel_id, content, content_length, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run("msg-1", TARGET, "c1", "hello panopticon world", 22, Date.now(), "live");

        insertRule("KEYWORD_MENTION", { value: "panopticon" });
        evaluateEvent("MESSAGE_CREATE", TARGET, JSON.stringify({
            messageId: "msg-1", channelId: "c1",
        }));
        assert.equal(fired.length, 1);
    });

    it("KEYWORD_MENTION does not fire on absent keyword", () => {
        getDb().prepare(
            "INSERT INTO messages (message_id, target_id, channel_id, content, content_length, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run("msg-2", TARGET, "c1", "totally innocent message", 24, Date.now(), "live");

        insertRule("KEYWORD_MENTION", { value: "secret" });
        evaluateEvent("MESSAGE_CREATE", TARGET, JSON.stringify({
            messageId: "msg-2", channelId: "c1",
        }));
        assert.equal(fired.length, 0);
    });
});

describe("evaluateEvent — voice + reaction + profile rules", () => {
    let fired: CapturedAlert[];

    beforeEach(() => {
        setupTestDb();
        insertTestTarget(TARGET);
        refreshTargetCache();
        ({ fired } = captureAlerts());
    });
    afterEach(teardownTestDb);

    it("JOINS_VOICE fires on VOICE_JOIN", () => {
        insertRule("JOINS_VOICE");
        evaluateEvent("VOICE_JOIN", TARGET, JSON.stringify({ guildId: "g1", channelId: "c1" }));
        assert.equal(fired.length, 1);
    });

    it("JOINS_VOICE channelId filter matches", () => {
        insertRule("JOINS_VOICE", { field: "channelId", value: "c1" });
        evaluateEvent("VOICE_JOIN", TARGET, JSON.stringify({ guildId: "g1", channelId: "c1" }));
        evaluateEvent("VOICE_JOIN", TARGET, JSON.stringify({ guildId: "g1", channelId: "c2" }));
        assert.equal(fired.length, 1);
    });

    it("LEAVES_VOICE fires on VOICE_LEAVE", () => {
        insertRule("LEAVES_VOICE");
        evaluateEvent("VOICE_LEAVE", TARGET, JSON.stringify({}));
        assert.equal(fired.length, 1);
    });

    it("GHOST_TYPES fires on GHOST_TYPE", () => {
        insertRule("GHOST_TYPES");
        evaluateEvent("GHOST_TYPE", TARGET, JSON.stringify({ channelId: "c1" }));
        assert.equal(fired.length, 1);
    });

    it("PROFILE_CHANGE fires on PROFILE_UPDATE", () => {
        insertRule("PROFILE_CHANGE");
        evaluateEvent("PROFILE_UPDATE", TARGET, JSON.stringify({ changes: ["avatar"] }));
        assert.equal(fired.length, 1);
    });

    it("PROFILE_CHANGE fires on AVATAR_CHANGE", () => {
        insertRule("PROFILE_CHANGE");
        evaluateEvent("AVATAR_CHANGE", TARGET, JSON.stringify({ oldHash: "a", newHash: "b" }));
        assert.equal(fired.length, 1);
    });
});

describe("evaluateEvent — rule targeting", () => {
    let fired: CapturedAlert[];

    beforeEach(() => {
        setupTestDb();
        insertTestTarget(TARGET);
        insertTestTarget("222222222222222222");
        refreshTargetCache();
        ({ fired } = captureAlerts());
    });
    afterEach(teardownTestDb);

    it("global rule (target_id null) fires for any target", () => {
        insertRule("COMES_ONLINE", {}, { target: null });
        evaluateEvent("PRESENCE_UPDATE", TARGET, JSON.stringify({ newStatus: "online" }));
        evaluateEvent("PRESENCE_UPDATE", "222222222222222222", JSON.stringify({ newStatus: "online" }));
        assert.equal(fired.length, 2);
    });

    it("per-target rule only fires for its target", () => {
        insertRule("COMES_ONLINE", {}, { target: TARGET });
        evaluateEvent("PRESENCE_UPDATE", "222222222222222222", JSON.stringify({ newStatus: "online" }));
        assert.equal(fired.length, 0);

        evaluateEvent("PRESENCE_UPDATE", TARGET, JSON.stringify({ newStatus: "online" }));
        assert.equal(fired.length, 1);
    });
});
