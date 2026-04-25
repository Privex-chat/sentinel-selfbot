import { getDb } from "./connection";
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from "./schema";
import { createLogger } from "../utils/logger";

const log = createLogger("Migrations");

export function runMigrations(): void {
    const db = getDb();

    db.exec(CREATE_TABLES_SQL);

    const versionRow = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number } | undefined;
    const currentVersion = versionRow?.version ?? 0;

    if (currentVersion === 0) {
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
        log.info(`Database initialized at schema version ${SCHEMA_VERSION}`);
    } else if (currentVersion < SCHEMA_VERSION) {
        // Future migrations go here
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
        default:
            break;
    }
}
