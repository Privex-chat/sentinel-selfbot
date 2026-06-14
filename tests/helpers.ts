/**
 * Shared test setup. Tests that need a working SQLite open an in-memory database
 * + run migrations. Tests of pure functions skip this entirely.
 *
 * Every test file is responsible for setting required env vars BEFORE importing
 * anything from src/ — config.ts reads `process.env` at import time, and once
 * read those values are baked in for the lifetime of the test process. The
 * canonical pattern at the top of a test file is:
 *
 *     process.env.DB_PATH         = ":memory:";
 *     process.env.API_AUTH_TOKEN  = "test";
 *     process.env.DISCORD_TOKEN   = "test";
 *     process.env.LOG_LEVEL       = "error";
 *     // ... then imports
 */

import { initDatabase, closeDatabase, getDb } from "../src/database/connection";
import { runMigrations } from "../src/database/migrations";
import { resetStmts } from "../src/database/queries";

/** Open a fresh in-memory DB and run all migrations. Call at the start of any
 *  test that needs persistent storage. Safe to call repeatedly — each call
 *  closes the previous handle first. */
export function setupTestDb(): void {
    try { closeDatabase(); } catch { /* no prior handle */ }
    resetStmts();
    initDatabase(":memory:");
    runMigrations();
}

export function teardownTestDb(): void {
    try { closeDatabase(); } catch { /* already closed */ }
    resetStmts();
}

/** Insert a target row directly into the in-memory DB.
 *
 * `bootstrap`: when omitted (default) the target is inserted as already-
 * operational so existing tests that pre-date the bootstrap pipeline don't
 * accidentally trip the new suppression logic. Pass `"pending"` to test the
 * bootstrap-in-progress path. */
export function insertTestTarget(
    userId: string,
    opts: {
        active?: boolean;
        timezone?: string;
        label?: string;
        bootstrap?: "complete" | "pending";
    } = {},
): void {
    const db = getDb();
    const now = Date.now();
    db.prepare(
        "INSERT OR REPLACE INTO targets (user_id, added_at, label, notes, priority, active, timezone, bootstrap_completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
        userId,
        now,
        opts.label ?? null,
        null,
        0,
        opts.active === false ? 0 : 1,
        opts.timezone ?? "UTC",
        opts.bootstrap === "pending" ? null : now,
    );
}
