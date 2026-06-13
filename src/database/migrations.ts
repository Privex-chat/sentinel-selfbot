import { getDb } from "./connection";
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from "./schema";
import { createLogger } from "../utils/logger";

const log = createLogger("Migrations");

export function runMigrations(): void {
    const db = getDb();

    db.exec(CREATE_TABLES_SQL);

    // Detect fresh install: schema_version table will have been created by
    // CREATE_TABLES_SQL but it's empty when this is a brand-new database.
    const versionRow = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number } | undefined;
    const currentVersion = versionRow?.version ?? 0;

    if (currentVersion === 0) {
        // Fresh install — CREATE_TABLES_SQL already created every table at the
        // current schema shape, so we DON'T re-run historical migrations (which
        // would needlessly recreate tables that were just created correctly).
        // Just record the current version so subsequent boots are no-ops.
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
        log.info(`Database initialized at schema version ${SCHEMA_VERSION}`);
    } else if (currentVersion < SCHEMA_VERSION) {
        for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
            applyMigration(v);
        }
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
        log.info(`Database migrated from v${currentVersion} to v${SCHEMA_VERSION}`);
    } else {
        log.info(`Database schema is up to date (v${currentVersion})`);
    }
}

function applyMigration(version: number): void {
    switch (version) {
        case 2: {
            const db = getDb();
            // Add alert_rules v2 columns. These are now in the base CREATE TABLE
            // for new installs; ALTER TABLE is only needed for pre-v2 databases.
            const alterColumns = [
                "ALTER TABLE alert_rules ADD COLUMN fire_count_24h INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE alert_rules ADD COLUMN last_fire_at INTEGER",
                "ALTER TABLE alert_rules ADD COLUMN auto_suppressed INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE alert_rules ADD COLUMN fatigue_threshold INTEGER NOT NULL DEFAULT 20",
                "ALTER TABLE alert_rules ADD COLUMN composite_condition TEXT",
                "ALTER TABLE alert_rules ADD COLUMN digest_mode INTEGER NOT NULL DEFAULT 0",
            ];
            for (const sql of alterColumns) {
                try { db.exec(sql); } catch { /* column may already exist */ }
            }
            log.info("Migration v2: alert_rules columns added");
            break;
        }

        case 3: {
            const db = getDb();
            // Add messages.source for pre-v3 databases. Already in base schema for new installs.
            try {
                db.exec("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'live'");
            } catch { /* column may already exist */ }
            log.info("Migration v3: messages.source column added");
            break;
        }

        case 4: {
            // Recreate alert_history with ON DELETE SET NULL on rule_id, matching
            // the Supabase schema and preventing FK errors when deleting alert rules.
            // Also adds a missing index on rule_id for efficient cascade lookups.
            //
            // The entire swap runs in a single transaction so a mid-migration crash
            // never leaves the database without an alert_history table.
            const db = getDb();

            // Disable FK enforcement temporarily so the table swap doesn't fail
            // on self-referential or cross-table dependencies during the rename.
            db.pragma("foreign_keys = OFF");
            try {
                const migrate = db.transaction(() => {
                    // DROP first in case a previous failed run left a partial
                    // alert_history_new behind (would otherwise collide on insert).
                    db.exec(`
                        DROP TABLE IF EXISTS alert_history_new;
                        CREATE TABLE alert_history_new (
                            id           INTEGER PRIMARY KEY AUTOINCREMENT,
                            rule_id      INTEGER,
                            target_id    TEXT    NOT NULL,
                            alert_type   TEXT    NOT NULL,
                            message      TEXT    NOT NULL,
                            timestamp    INTEGER NOT NULL,
                            acknowledged INTEGER DEFAULT 0,
                            FOREIGN KEY (rule_id)   REFERENCES alert_rules(id) ON DELETE SET NULL,
                            FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
                        );
                        INSERT INTO alert_history_new
                            SELECT id, rule_id, target_id, alert_type, message, timestamp, acknowledged
                            FROM   alert_history;
                        DROP TABLE alert_history;
                        ALTER TABLE alert_history_new RENAME TO alert_history;
                        CREATE INDEX IF NOT EXISTS idx_alert_history_target
                            ON alert_history(target_id, timestamp);
                        CREATE INDEX IF NOT EXISTS idx_alert_history_rule
                            ON alert_history(rule_id);
                    `);

                    // Null-out any orphaned rule_ids whose rules have already been deleted.
                    db.prepare(
                        "UPDATE alert_history SET rule_id = NULL WHERE rule_id IS NOT NULL AND rule_id NOT IN (SELECT id FROM alert_rules)"
                    ).run();
                });

                migrate();
                log.info("Migration v4: alert_history recreated with ON DELETE SET NULL FK");
            } catch (err: any) {
                log.error(`Migration v4 failed: ${err.message}`);
                throw err;
            } finally {
                db.pragma("foreign_keys = ON");
            }
            break;
        }

        case 5: {
            const db = getDb();
            try {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS runtime_config (
                        key        TEXT    PRIMARY KEY,
                        value      TEXT    NOT NULL,
                        updated_at INTEGER NOT NULL
                    )
                `);
            } catch { /* table may already exist */ }
            log.info("Migration v5: runtime_config table created");
            break;
        }

        case 7: {
            // Per-target timezone column. Drives every hour/day-of-week analyser
            // (sleep schedule, routine heatmap, baselines, UNUSUAL_HOUR alert).
            // Default 'UTC' so existing data continues to be interpreted exactly
            // as before — operators set per-target tz via $tz or PATCH /api/targets.
            const db = getDb();
            try {
                db.exec("ALTER TABLE targets ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
            } catch { /* column may already exist (idempotent re-run) */ }
            log.info("Migration v7: targets.timezone column added");
            break;
        }

        case 6: {
            // Recreate alert_rules with a FK to targets so deleting a target
            // cascades to per-target rules (previously orphaned them) and
            // matches the Supabase schema. Same pattern as v4 alert_history:
            // FK pragma off, table-swap inside a transaction, FK pragma on.
            //
            // Orphaned rules (target_id points at a no-longer-existing target)
            // are deleted BEFORE the swap so the new FK is consistent. The
            // alternative — NULL-ing target_id — would silently convert
            // per-target rules into global rules, which is the wrong default.
            const db = getDb();
            db.pragma("foreign_keys = OFF");
            try {
                const migrate = db.transaction(() => {
                    // 1. Drop orphans (their target was previously deleted).
                    const orphanCount = db.prepare(
                        `DELETE FROM alert_rules
                         WHERE target_id IS NOT NULL
                           AND target_id NOT IN (SELECT user_id FROM targets)`
                    ).run().changes;
                    if (orphanCount > 0) {
                        log.info(`Migration v6: dropped ${orphanCount} orphan alert rule(s)`);
                    }

                    // 2. Table swap: new table with FK, copy rows, drop old, rename.
                    // DROP first in case a previous failed run left a partial
                    // alert_rules_new behind (would otherwise collide on insert).
                    db.exec(`
                        DROP TABLE IF EXISTS alert_rules_new;
                        CREATE TABLE alert_rules_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            target_id TEXT,
                            rule_type TEXT NOT NULL,
                            condition TEXT NOT NULL,
                            enabled INTEGER DEFAULT 1,
                            created_at INTEGER NOT NULL,
                            fire_count_24h INTEGER NOT NULL DEFAULT 0,
                            last_fire_at INTEGER,
                            auto_suppressed INTEGER NOT NULL DEFAULT 0,
                            fatigue_threshold INTEGER NOT NULL DEFAULT 20,
                            composite_condition TEXT,
                            digest_mode INTEGER NOT NULL DEFAULT 0,
                            FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE ON UPDATE CASCADE
                        );
                        INSERT INTO alert_rules_new
                            SELECT id, target_id, rule_type, condition, enabled, created_at,
                                   fire_count_24h, last_fire_at, auto_suppressed,
                                   fatigue_threshold, composite_condition, digest_mode
                            FROM alert_rules;
                        DROP TABLE alert_rules;
                        ALTER TABLE alert_rules_new RENAME TO alert_rules;
                        CREATE INDEX IF NOT EXISTS idx_alert_rules_target
                            ON alert_rules(target_id) WHERE target_id IS NOT NULL;
                        CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled
                            ON alert_rules(enabled, rule_type);
                    `);
                });

                migrate();
                log.info("Migration v6: alert_rules recreated with FK to targets");
            } catch (err: any) {
                log.error(`Migration v6 failed: ${err.message}`);
                throw err;
            } finally {
                db.pragma("foreign_keys = ON");
            }
            break;
        }

        default:
            break;
    }
}