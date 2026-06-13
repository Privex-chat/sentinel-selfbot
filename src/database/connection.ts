import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger";
import { config } from "../utils/config";

const log = createLogger("Database");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
    if (!db) {
        throw new Error("Database not initialized. Call initDatabase() first.");
    }
    return db;
}

/**
 * Open the SQLite handle and apply standard PRAGMAs.
 *
 * `pathOverride` is an explicit-opt-in for tests so they can ask for `:memory:`
 * without mucking about with `process.env.DB_PATH` ordering and module init.
 * Production callers pass nothing — `config.dbPath` is the source of truth.
 */
export function initDatabase(pathOverride?: string): Database.Database {
    const dbPath = pathOverride ?? config.dbPath;

    // Skip mkdir for in-memory and URI-style paths (`:memory:`, `file::memory:?...`)
    // — they don't have a directory.
    if (dbPath !== ":memory:" && !dbPath.startsWith("file:")) {
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
    }

    log.info(`Opening database at ${dbPath}`);
    db = new Database(dbPath);

    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("cache_size = -64000"); // 64MB cache
    // Wait up to 5 s for the file lock instead of failing immediately with
    // SQLITE_BUSY. better-sqlite3 is single-writer in-process, but if another
    // process (web UI, CLI inspector, backup tool) holds the file lock the
    // default zero-timeout surfaces an opaque error rather than waiting.
    db.pragma("busy_timeout = 5000");

    log.info("Database initialized with WAL mode");
    return db;
}

export function closeDatabase(): void {
    if (db) {
        log.info("Closing database");
        db.close();
        db = null;
    }
}
