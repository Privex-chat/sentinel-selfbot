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

/** Insert a target row directly into the in-memory DB. */
export function insertTestTarget(userId: string, opts: { active?: boolean; timezone?: string; label?: string } = {}): void {
    const db = getDb();
    db.prepare(
        "INSERT OR REPLACE INTO targets (user_id, added_at, label, notes, priority, active, timezone) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
        userId,
        Date.now(),
        opts.label ?? null,
        null,
        0,
        opts.active === false ? 0 : 1,
        opts.timezone ?? "UTC",
    );
}
