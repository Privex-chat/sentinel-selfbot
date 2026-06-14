// Profile collector tests need an in-memory DB so handleProfileUpdate can
// actually insert snapshots + read prior ones for the diff.
process.env.DB_PATH        = ":memory:";
process.env.API_AUTH_TOKEN = "test-token";
process.env.DISCORD_TOKEN  = "test-token";
process.env.LOG_LEVEL      = "error";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupTestDb, teardownTestDb, insertTestTarget } from "../helpers";
import { getDb } from "../../src/database/connection";
import { handleProfileUpdate } from "../../src/collectors/profile";
import { refreshTargetCache, markBootstrapComplete } from "../../src/target-lifecycle";

const TARGET = "111111111111111111";

function countEvents(targetId: string, eventType: string): number {
    const row = getDb()
        .prepare("SELECT COUNT(*) AS c FROM events WHERE target_id = ? AND event_type = ?")
        .get(targetId, eventType) as { c: number };
    return row.c;
}

function countSnapshots(targetId: string): number {
    const row = getDb()
        .prepare("SELECT COUNT(*) AS c FROM profile_snapshots WHERE target_id = ?")
        .get(targetId) as { c: number };
    return row.c;
}

describe("handleProfileUpdate — null → value never emits PROFILE_UPDATE", () => {
    beforeEach(() => {
        setupTestDb();
        insertTestTarget(TARGET, { bootstrap: "complete" });
        refreshTargetCache();
    });
    afterEach(teardownTestDb);

    it("first observation stores snapshot without emitting events", () => {
        handleProfileUpdate(TARGET, {
            username: "alice",
            global_name: "Alice",
            discriminator: "0001",
            avatar: "abc123",
        });
        assert.equal(countSnapshots(TARGET), 1);
        assert.equal(countEvents(TARGET, "PROFILE_UPDATE"), 0);
        assert.equal(countEvents(TARGET, "AVATAR_CHANGE"), 0);
        assert.equal(countEvents(TARGET, "USERNAME_CHANGE"), 0);
    });

    it("subsequent fetch filling in null bio/pronouns/banner does NOT emit PROFILE_UPDATE", () => {
        // First fetch: basic user data (mimics GUILD_MEMBERS_CHUNK path)
        handleProfileUpdate(TARGET, {
            username: "alice",
            global_name: "Alice",
            discriminator: "0001",
            avatar: "abc123",
        });
        // Second fetch: full /users/{id}/profile fills in bio/pronouns/banner
        handleProfileUpdate(
            TARGET,
            { username: "alice", global_name: "Alice", discriminator: "0001", avatar: "abc123" },
            { bio: "Hello world", pronouns: "they/them", banner: "deadbeef" },
        );
        assert.equal(countEvents(TARGET, "PROFILE_UPDATE"), 0, "null→value must never count as a change");
    });

    it("real avatar change (non-null → different non-null) emits PROFILE_UPDATE + AVATAR_CHANGE", () => {
        handleProfileUpdate(TARGET, {
            username: "alice", global_name: "Alice", discriminator: "0001", avatar: "abc123",
        });
        handleProfileUpdate(TARGET, {
            username: "alice", global_name: "Alice", discriminator: "0001", avatar: "xyz789",
        });
        assert.equal(countEvents(TARGET, "PROFILE_UPDATE"), 1);
        assert.equal(countEvents(TARGET, "AVATAR_CHANGE"), 1);
    });

    it("real username change emits PROFILE_UPDATE + USERNAME_CHANGE", () => {
        handleProfileUpdate(TARGET, {
            username: "alice", global_name: "Alice", discriminator: "0001", avatar: "abc",
        });
        handleProfileUpdate(TARGET, {
            username: "alice_v2", global_name: "Alice", discriminator: "0001", avatar: "abc",
        });
        assert.equal(countEvents(TARGET, "PROFILE_UPDATE"), 1);
        assert.equal(countEvents(TARGET, "USERNAME_CHANGE"), 1);
    });

    it("value → null transition does NOT emit a change (could be incomplete fetch)", () => {
        handleProfileUpdate(
            TARGET,
            { username: "alice", global_name: "Alice", discriminator: "0001", avatar: "abc" },
            { bio: "Hello world", pronouns: "they/them", banner: "deadbeef" },
        );
        // Subsequent fetch (e.g. basic /users/{id}) doesn't include bio/pronouns/banner.
        // Those should NOT count as "cleared" — same incomplete-data concern in reverse.
        handleProfileUpdate(TARGET, {
            username: "alice", global_name: "Alice", discriminator: "0001", avatar: "abc",
        });
        assert.equal(countEvents(TARGET, "PROFILE_UPDATE"), 0);
    });
});

describe("handleProfileUpdate — bootstrap suppression", () => {
    beforeEach(() => {
        setupTestDb();
        insertTestTarget(TARGET, { bootstrap: "pending" });
        refreshTargetCache();
    });
    afterEach(teardownTestDb);

    it("stores snapshot even while bootstrapping", () => {
        handleProfileUpdate(TARGET, {
            username: "alice", global_name: "Alice", discriminator: "0001", avatar: "abc",
        });
        assert.equal(countSnapshots(TARGET), 1);
    });

    it("does NOT emit PROFILE_UPDATE event while bootstrapping, even on a real change", () => {
        // Seed first snapshot.
        handleProfileUpdate(TARGET, {
            username: "alice", global_name: "Alice", discriminator: "0001", avatar: "abc",
        });
        // Genuine change (avatar swapped). Would normally fire, but bootstrap suppresses.
        handleProfileUpdate(TARGET, {
            username: "alice", global_name: "Alice", discriminator: "0001", avatar: "xyz",
        });
        assert.equal(countEvents(TARGET, "PROFILE_UPDATE"), 0);
        assert.equal(countEvents(TARGET, "AVATAR_CHANGE"), 0);
    });

    it("events fire normally after markBootstrapComplete()", () => {
        handleProfileUpdate(TARGET, {
            username: "alice", global_name: "Alice", discriminator: "0001", avatar: "abc",
        });
        markBootstrapComplete(TARGET);

        handleProfileUpdate(TARGET, {
            username: "alice", global_name: "Alice", discriminator: "0001", avatar: "xyz",
        });
        assert.equal(countEvents(TARGET, "PROFILE_UPDATE"), 1);
        assert.equal(countEvents(TARGET, "AVATAR_CHANGE"), 1);
    });
});
