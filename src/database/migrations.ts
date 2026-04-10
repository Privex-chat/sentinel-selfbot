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

function applyMigration(_version: number): void {
    // Future migrations will be added here as switch cases
}
