import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type Database from "better-sqlite3";
import { getDb } from "./connection";
import { config } from "../utils/config";
import { createLogger } from "../utils/logger";

const log = createLogger("SupabaseSync");

const BATCH_SIZE = 500;
const UPDATE_WINDOW_MS = 3_600_000;
// Messages can be edited or deleted weeks after creation, but the schema has
// no per-row last-modified timestamp. Use a wide window for message updates
// so day-old edits/deletes still propagate to Supabase instead of going stale
// at the 1-hour UPDATE_WINDOW_MS boundary. The widened window is bounded by
// BATCH_SIZE × maxBatches so it stays paginatable.
const MESSAGE_UPDATE_WINDOW_MS = 7 * 86_400_000;  // 7 days

// Columns to strip per table because they don't yet exist in the remote Supabase
// schema. Populated automatically on the first upsert failure for that column;
// persists for the lifetime of the process. On restart the column is retried —
// if it's been added to Supabase in the meantime it will work fine.
const excludedCols = new Map<string, Set<string>>();

interface SyncStateEntry {
    lastId: number;
    lastAt: number;
}

function getSyncState(db: Database.Database, tableName: string): SyncStateEntry {
    const row = db
        .prepare("SELECT last_synced_id, last_synced_at FROM sync_state WHERE table_name = ?")
        .get(tableName) as { last_synced_id: number; last_synced_at: number } | undefined;
    return {
        lastId: row?.last_synced_id ?? 0,
        lastAt: row?.last_synced_at ?? 0,
    };
}

function setSyncState(
    db: Database.Database,
    tableName: string,
    lastId: number,
    lastAt: number = Date.now()
): void {
    db.prepare(
        `INSERT INTO sync_state (table_name, last_synced_id, last_synced_at) VALUES (?, ?, ?)
         ON CONFLICT(table_name) DO UPDATE SET
             last_synced_id  = excluded.last_synced_id,
             last_synced_at  = excluded.last_synced_at`
    ).run(tableName, lastId, lastAt);
}

// Postgres / PostgREST error patterns we can isolate to a bad batch so a single
// malformed row never poisons the entire sync cycle. CHECK / FK / unique
// violations are skipped after logging; everything else propagates so genuine
// connectivity / auth failures still abort the cycle.
function classifySupabaseError(msg: string): "check" | "fk" | "unique" | null {
    if (/violates check constraint/i.test(msg)) return "check";
    if (/violates foreign key constraint/i.test(msg)) return "fk";
    if (/duplicate key value violates unique constraint/i.test(msg)) return "unique";
    return null;
}

async function upsertBatched(
    supabase: SupabaseClient,
    table: string,
    rows: any[],
    onConflict: string
): Promise<void> {
    if (!rows.length) return;

    const toExclude = excludedCols.get(table) ?? new Set<string>();

    const strip = (r: any): any => {
        if (!toExclude.size) return r;
        return Object.fromEntries(Object.entries(r).filter(([k]) => !toExclude.has(k)));
    };

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        let batch = rows.slice(i, i + BATCH_SIZE).map(strip);

        // Retry loop: each iteration strips one more unknown column until
        // the batch succeeds or a non-schema error is thrown.
        while (true) {
            const { error } = await supabase.from(table).upsert(batch, { onConflict });
            if (!error) break;

            // PostgREST schema-cache miss: "Could not find the 'X' column of 'Y'"
            const m = error.message.match(/Could not find the '(\w+)' column/);
            if (m) {
                const col = m[1];
                if (!excludedCols.has(table)) excludedCols.set(table, new Set());
                excludedCols.get(table)!.add(col);
                toExclude.add(col);
                log.warn(
                    `Supabase "${table}": column "${col}" not in remote schema — ` +
                    `stripping from sync. Run the latest supabase-schema.sql migration to resolve.`
                );
                batch = batch.map((r: any) => {
                    const out = { ...r };
                    delete out[col];
                    return out;
                });
                continue;
            }

            // Constraint violations — skip the offending batch instead of
            // aborting the entire sync cycle. Without this a single bad row
            // (e.g. a presence_sessions.status the Supabase CHECK rejects,
            // a stale FK reference, a duplicate PK) would prevent every
            // subsequent table from syncing until the row was manually fixed.
            const kind = classifySupabaseError(error.message);
            if (kind) {
                log.error(
                    `Supabase "${table}" ${kind} violation — skipping batch of ${batch.length} ` +
                    `row(s). Underlying error: ${error.message.slice(0, 240)}`
                );
                break;
            }

            throw new Error(`Supabase upsert error on "${table}": ${error.message}`);
        }
    }
}

export class SupabaseSyncEngine {
    private readonly supabase: SupabaseClient;
    private intervalHandle: NodeJS.Timeout | null = null;
    private syncing = false;
    readonly enabled: boolean;

    constructor() {
        // cloud and local+cloud both need Supabase credentials
        const hasCredentials = !!(config.supabaseUrl && config.supabaseServiceKey);
        const modeNeedsSync  = config.dbMode === "local+cloud" || config.dbMode === "cloud";
        this.enabled = hasCredentials && modeNeedsSync;
    
        if (this.enabled) {
            this.supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
                auth: { persistSession: false, autoRefreshToken: false },
            });
            log.info(`Supabase sync enabled (DB_MODE=${config.dbMode}, interval=${config.supabaseSyncIntervalMs}ms)`);
        } else {
            this.supabase = null as unknown as SupabaseClient;
            if (config.dbMode !== "local") {
                log.warn(
                    `DB_MODE="${config.dbMode}" but Supabase credentials are missing — ` +
                    `falling back to local-only.`
                );
            }
        }
    }

    async testConnection(): Promise<boolean> {
        if (!this.enabled) return false;
        try {
            const { error } = await this.supabase
                .from("targets")
                .select("user_id")
                .limit(1);
            if (error) {
                log.error(`Supabase connection test failed: ${error.message}`);
                log.error(
                    "Hint: have you run supabase-schema.sql in your Supabase project? " +
                    "See docs/SUPABASE_SETUP.md."
                );
                return false;
            }
            log.info("Supabase connection OK");
            return true;
        } catch (err: any) {
            log.error(`Supabase connection test threw: ${err.message}`);
            return false;
        }
    }

    start(): void {
        if (!this.enabled) return;
        log.info(`Supabase sync will run every ${config.supabaseSyncIntervalMs / 1000}s`);

        const initial = setTimeout(() => {
            this.runSync();
            this.intervalHandle = setInterval(
                () => this.runSync(),
                config.supabaseSyncIntervalMs
            );
        }, 60_000);

        if ((initial as any).unref) (initial as any).unref();
    }

    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        log.info("Supabase sync stopped");
    }

    async forceSync(): Promise<void> {
        if (!this.enabled) return;
        await this.runSync();
    }

    private async runSync(): Promise<void> {
        if (this.syncing) {
            log.debug("Sync already in progress — skipping this tick");
            return;
        }
        this.syncing = true;
        const started = Date.now();
        log.info("Supabase sync cycle starting");

        try {
            const db = getDb();
            const windowStart = Date.now() - UPDATE_WINDOW_MS;

            await this.syncTargets(db);
            await this.syncAlertRules(db);
            await this.syncEvents(db);
            await this.syncProfileSnapshots(db, windowStart);
            await this.syncPresenceSessions(db, windowStart);
            await this.syncActivitySessions(db, windowStart);
            await this.syncVoiceSessions(db, windowStart);
            await this.syncMessages(db);
            await this.syncTypingEvents(db, windowStart);
            await this.syncReactions(db, windowStart);
            await this.syncGuildMemberEvents(db);
            await this.syncAlertHistory(db, windowStart);
            await this.syncDailySummaries(db);
            // v2 tables
            await this.syncRelationshipAnalysis(db);
            await this.syncRelationshipHistory(db);
            await this.syncDailyBriefs(db);
            await this.syncBackfillProgress(db);
            await this.syncBehavioralBaselines(db);
            await this.syncTargetConfig(db);
            await this.syncMessageCategories(db, windowStart);
            await this.syncRuntimeConfig(db);

            log.info(`Supabase sync cycle completed in ${Date.now() - started}ms`);
        } catch (err: any) {
            log.error(`Supabase sync cycle failed: ${err.message}`);
        } finally {
            this.syncing = false;
        }
    }

    private async syncTargets(db: Database.Database): Promise<void> {
        const rows = db.prepare("SELECT * FROM targets").all();
        if (!rows.length) return;
        await upsertBatched(this.supabase, "targets", rows, "user_id");
        log.debug(`targets: synced ${rows.length} rows`);
    }

    private async syncAlertRules(db: Database.Database): Promise<void> {
        const rows = db.prepare("SELECT * FROM alert_rules").all();
        if (!rows.length) return;
        await upsertBatched(this.supabase, "alert_rules", rows, "id");
        log.debug(`alert_rules: synced ${rows.length} rows`);
    }

    private async syncEvents(db: Database.Database): Promise<void> {
        const state = getSyncState(db, "events");
        let currentId = state.lastId;
        let totalSynced = 0;

        const maxBatches = currentId === 0 ? 10 : 3;

        for (let b = 0; b < maxBatches; b++) {
            const rows = db
                .prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?")
                .all(currentId, BATCH_SIZE) as any[];

            if (!rows.length) break;
            await upsertBatched(this.supabase, "events", rows, "id");
            currentId = Math.max(...rows.map((r) => r.id));
            totalSynced += rows.length;
            if (rows.length < BATCH_SIZE) break;
        }

        if (totalSynced > 0) {
            setSyncState(db, "events", currentId);
            log.debug(`events: synced ${totalSynced} rows (last id: ${currentId})`);
        }
    }

    private async syncProfileSnapshots(
        db: Database.Database,
        windowStart: number
    ): Promise<void> {
        const { lastId } = getSyncState(db, "profile_snapshots");
        const rows = db
            .prepare(
                `SELECT * FROM profile_snapshots
                 WHERE id > ?
                    OR (id <= ? AND timestamp >= ?)
                 ORDER BY id LIMIT ?`
            )
            .all(lastId, lastId, windowStart, BATCH_SIZE * 5) as any[];

        if (!rows.length) return;
        await upsertBatched(this.supabase, "profile_snapshots", rows, "id");
        const newer = rows.filter((r) => r.id > lastId);
        if (newer.length) {
            setSyncState(db, "profile_snapshots", Math.max(...newer.map((r) => r.id)));
        }
        log.debug(`profile_snapshots: synced ${rows.length} rows`);
    }

    private async syncPresenceSessions(
        db: Database.Database,
        windowStart: number
    ): Promise<void> {
        const { lastId } = getSyncState(db, "presence_sessions");
        const rows = db
            .prepare(
                `SELECT * FROM presence_sessions
                 WHERE id > ?
                    OR (id <= ? AND start_time >= ?)
                 ORDER BY id LIMIT ?`
            )
            .all(lastId, lastId, windowStart, BATCH_SIZE * 5) as any[];

        if (!rows.length) return;
        await upsertBatched(this.supabase, "presence_sessions", rows, "id");
        const newer = rows.filter((r) => r.id > lastId);
        if (newer.length) {
            setSyncState(db, "presence_sessions", Math.max(...newer.map((r) => r.id)));
        }
        log.debug(`presence_sessions: synced ${rows.length} rows`);
    }

    private async syncActivitySessions(
        db: Database.Database,
        windowStart: number
    ): Promise<void> {
        const { lastId } = getSyncState(db, "activity_sessions");
        const rows = db
            .prepare(
                `SELECT * FROM activity_sessions
                 WHERE id > ?
                    OR (id <= ? AND start_time >= ?)
                 ORDER BY id LIMIT ?`
            )
            .all(lastId, lastId, windowStart, BATCH_SIZE * 5) as any[];

        if (!rows.length) return;
        await upsertBatched(this.supabase, "activity_sessions", rows, "id");
        const newer = rows.filter((r) => r.id > lastId);
        if (newer.length) {
            setSyncState(db, "activity_sessions", Math.max(...newer.map((r) => r.id)));
        }
        log.debug(`activity_sessions: synced ${rows.length} rows`);
    }

    private async syncVoiceSessions(
        db: Database.Database,
        windowStart: number
    ): Promise<void> {
        const { lastId } = getSyncState(db, "voice_sessions");
        const rows = db
            .prepare(
                `SELECT * FROM voice_sessions
                 WHERE id > ?
                    OR (id <= ? AND start_time >= ?)
                 ORDER BY id LIMIT ?`
            )
            .all(lastId, lastId, windowStart, BATCH_SIZE * 5) as any[];

        if (!rows.length) return;
        await upsertBatched(this.supabase, "voice_sessions", rows, "id");
        const newer = rows.filter((r) => r.id > lastId);
        if (newer.length) {
            setSyncState(db, "voice_sessions", Math.max(...newer.map((r) => r.id)));
        }
        log.debug(`voice_sessions: synced ${rows.length} rows`);
    }

    private async syncMessages(db: Database.Database): Promise<void> {
        const state = getSyncState(db, "messages");
        // Pull anything created or modified in the last MESSAGE_UPDATE_WINDOW_MS.
        // Previously this used UPDATE_WINDOW_MS (1h) which silently dropped any
        // edit or delete older than the window — local SQLite reflected the
        // change but Supabase still had the original. 7d is wide enough to
        // catch any realistic late edit / delete pattern.
        const since =
            state.lastAt > 0 ? Math.max(0, state.lastAt - MESSAGE_UPDATE_WINDOW_MS) : 0;

        let offset = 0;
        let totalSynced = 0;
        const maxBatches = since === 0 ? 10 : 5;

        for (let b = 0; b < maxBatches; b++) {
            const rows = db
                .prepare(
                    `SELECT * FROM messages
                     WHERE created_at >= ?
                        OR (edited_at  IS NOT NULL AND edited_at  >= ?)
                        OR (deleted_at IS NOT NULL AND deleted_at >= ?)
                     ORDER BY created_at
                     LIMIT ? OFFSET ?`
                )
                .all(since, since, since, BATCH_SIZE, offset) as any[];

            if (!rows.length) break;
            await upsertBatched(this.supabase, "messages", rows, "message_id");
            totalSynced += rows.length;
            offset += rows.length;
            if (rows.length < BATCH_SIZE) break;
        }

        setSyncState(db, "messages", 0, Date.now());
        if (totalSynced) log.debug(`messages: synced ${totalSynced} rows`);
    }

    private async syncTypingEvents(
        db: Database.Database,
        windowStart: number
    ): Promise<void> {
        const { lastId } = getSyncState(db, "typing_events");
        const rows = db
            .prepare(
                `SELECT * FROM typing_events
                 WHERE id > ?
                    OR (id <= ? AND timestamp >= ?)
                 ORDER BY id LIMIT ?`
            )
            .all(lastId, lastId, windowStart, BATCH_SIZE * 5) as any[];

        if (!rows.length) return;
        await upsertBatched(this.supabase, "typing_events", rows, "id");
        const newer = rows.filter((r) => r.id > lastId);
        if (newer.length) {
            setSyncState(db, "typing_events", Math.max(...newer.map((r) => r.id)));
        }
        log.debug(`typing_events: synced ${rows.length} rows`);
    }

    private async syncReactions(
        db: Database.Database,
        windowStart: number
    ): Promise<void> {
        const { lastId } = getSyncState(db, "reactions");
        const rows = db
            .prepare(
                `SELECT * FROM reactions
                 WHERE id > ?
                    OR (id <= ? AND added_at >= ?)
                 ORDER BY id LIMIT ?`
            )
            .all(lastId, lastId, windowStart, BATCH_SIZE * 5) as any[];

        if (!rows.length) return;
        await upsertBatched(this.supabase, "reactions", rows, "id");
        const newer = rows.filter((r) => r.id > lastId);
        if (newer.length) {
            setSyncState(db, "reactions", Math.max(...newer.map((r) => r.id)));
        }
        log.debug(`reactions: synced ${rows.length} rows`);
    }

    private async syncGuildMemberEvents(db: Database.Database): Promise<void> {
        const { lastId } = getSyncState(db, "guild_member_events");
        const rows = db
            .prepare(
                "SELECT * FROM guild_member_events WHERE id > ? ORDER BY id LIMIT ?"
            )
            .all(lastId, BATCH_SIZE * 5) as any[];

        if (!rows.length) return;
        await upsertBatched(this.supabase, "guild_member_events", rows, "id");
        setSyncState(db, "guild_member_events", Math.max(...rows.map((r) => r.id)));
        log.debug(`guild_member_events: synced ${rows.length} rows`);
    }

    private async syncAlertHistory(
        db: Database.Database,
        windowStart: number
    ): Promise<void> {
        const { lastId } = getSyncState(db, "alert_history");
        const rows = db
            .prepare(
                `SELECT * FROM alert_history
                 WHERE id > ?
                    OR (id <= ? AND timestamp >= ?)
                 ORDER BY id LIMIT ?`
            )
            .all(lastId, lastId, windowStart, BATCH_SIZE * 5) as any[];

        if (!rows.length) return;
        await upsertBatched(this.supabase, "alert_history", rows, "id");
        const newer = rows.filter((r) => r.id > lastId);
        if (newer.length) {
            setSyncState(db, "alert_history", Math.max(...newer.map((r) => r.id)));
        }
        log.debug(`alert_history: synced ${rows.length} rows`);
    }

    private async syncDailySummaries(db: Database.Database): Promise<void> {
        const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000)
            .toISOString()
            .split("T")[0];
        const rows = db
            .prepare("SELECT * FROM daily_summaries WHERE date >= ? ORDER BY date")
            .all(sevenDaysAgo) as any[];

        if (!rows.length) return;
        await upsertBatched(this.supabase, "daily_summaries", rows, "id");
        log.debug(`daily_summaries: synced ${rows.length} rows`);
    }

    // ── v2 tables ──────────────────────────────────────────────────────────────

    private async syncRelationshipAnalysis(db: Database.Database): Promise<void> {
        const { lastId } = getSyncState(db, "relationship_analysis");
        const rows = db
            .prepare("SELECT * FROM relationship_analysis WHERE id > ? ORDER BY id LIMIT ?")
            .all(lastId, BATCH_SIZE * 5) as any[];
        if (!rows.length) return;
        await upsertBatched(this.supabase, "relationship_analysis", rows, "id");
        setSyncState(db, "relationship_analysis", Math.max(...rows.map((r) => r.id)));
        log.debug(`relationship_analysis: synced ${rows.length} rows`);
    }

    private async syncRelationshipHistory(db: Database.Database): Promise<void> {
        const { lastId } = getSyncState(db, "relationship_history");
        const rows = db
            .prepare("SELECT * FROM relationship_history WHERE id > ? ORDER BY id LIMIT ?")
            .all(lastId, BATCH_SIZE * 5) as any[];
        if (!rows.length) return;
        await upsertBatched(this.supabase, "relationship_history", rows, "id");
        setSyncState(db, "relationship_history", Math.max(...rows.map((r) => r.id)));
        log.debug(`relationship_history: synced ${rows.length} rows`);
    }

    // ── Watermarked-by-existing-timestamp sync ──────────────────────────────
    //
    // These four tables were previously full-table re-upserted every cycle. At
    // SUPABASE_SYNC_INTERVAL_MS=30000 that's hundreds of thousands of useless
    // Supabase writes per hour on a busy install. The watermark column for each
    // is already present in the schema; we just need to use it.
    //
    // Note: we never decrement the watermark — if a row's timestamp goes
    // backwards (shouldn't happen, but defensively), it would be missed. All
    // four columns are write-once or monotonically-updated by the producers
    // (insertDailyBrief, updateBackfillProgress, upsertBaselineMetric,
    //  upsertTargetConfig), so this is safe.

    private async syncDailyBriefs(db: Database.Database): Promise<void> {
        const { lastAt } = getSyncState(db, "daily_briefs");
        const rows = db
            .prepare("SELECT * FROM daily_briefs WHERE generated_at > ? ORDER BY generated_at LIMIT ?")
            .all(lastAt, BATCH_SIZE * 5) as any[];
        if (!rows.length) return;
        await upsertBatched(this.supabase, "daily_briefs", rows, "id");
        const maxAt = Math.max(...rows.map(r => r.generated_at as number));
        setSyncState(db, "daily_briefs", 0, maxAt);
        log.debug(`daily_briefs: synced ${rows.length} row(s) (lastAt → ${maxAt})`);
    }

    private async syncBackfillProgress(db: Database.Database): Promise<void> {
        // Use the most recent of completed_at / started_at as the activity
        // marker. A row that's still pending has both NULL — those don't need
        // syncing yet because they carry no useful state past their initial
        // creation.
        const { lastAt } = getSyncState(db, "backfill_progress");
        const rows = db
            .prepare(
                `SELECT * FROM backfill_progress
                 WHERE COALESCE(completed_at, started_at, 0) > ?
                 ORDER BY COALESCE(completed_at, started_at, 0)
                 LIMIT ?`
            )
            .all(lastAt, BATCH_SIZE * 5) as any[];
        if (!rows.length) return;
        await upsertBatched(this.supabase, "backfill_progress", rows, "id");
        const maxAt = Math.max(
            ...rows.map(r => (r.completed_at ?? r.started_at ?? 0) as number)
        );
        setSyncState(db, "backfill_progress", 0, maxAt);
        log.debug(`backfill_progress: synced ${rows.length} row(s) (lastAt → ${maxAt})`);
    }

    private async syncBehavioralBaselines(db: Database.Database): Promise<void> {
        const { lastAt } = getSyncState(db, "behavioral_baselines");
        const rows = db
            .prepare(
                "SELECT * FROM behavioral_baselines WHERE computed_at > ? ORDER BY computed_at LIMIT ?"
            )
            .all(lastAt, BATCH_SIZE * 5) as any[];
        if (!rows.length) return;
        await upsertBatched(this.supabase, "behavioral_baselines", rows, "id");
        const maxAt = Math.max(...rows.map(r => r.computed_at as number));
        setSyncState(db, "behavioral_baselines", 0, maxAt);
        log.debug(`behavioral_baselines: synced ${rows.length} row(s) (lastAt → ${maxAt})`);
    }

    private async syncTargetConfig(db: Database.Database): Promise<void> {
        const { lastAt } = getSyncState(db, "target_config");
        const rows = db
            .prepare("SELECT * FROM target_config WHERE updated_at > ? ORDER BY updated_at LIMIT ?")
            .all(lastAt, BATCH_SIZE * 5) as any[];
        if (!rows.length) return;
        await upsertBatched(this.supabase, "target_config", rows, "target_id");
        const maxAt = Math.max(...rows.map(r => r.updated_at as number));
        setSyncState(db, "target_config", 0, maxAt);
        log.debug(`target_config: synced ${rows.length} row(s) (lastAt → ${maxAt})`);
    }

    private async syncRuntimeConfig(db: Database.Database): Promise<void> {
        // Watermarked by updated_at so changes propagate within one sync cycle
        // without re-pushing every key on every tick. Sensitive values are
        // already encrypted at rest (runtime-config.ts:setRuntimeConfig);
        // this method ships the envelope as-is without ever seeing plaintext.
        const { lastAt } = getSyncState(db, "runtime_config");
        const rows = db
            .prepare(
                "SELECT key, value, updated_at FROM runtime_config WHERE updated_at > ? ORDER BY updated_at LIMIT ?"
            )
            .all(lastAt, BATCH_SIZE * 5) as any[];
        if (!rows.length) return;
        await upsertBatched(this.supabase, "runtime_config", rows, "key");
        const maxAt = Math.max(...rows.map(r => r.updated_at as number));
        setSyncState(db, "runtime_config", 0, maxAt);
        log.debug(`runtime_config: synced ${rows.length} row(s) (lastAt → ${maxAt})`);
    }

    private async syncMessageCategories(
        db: Database.Database,
        windowStart: number
    ): Promise<void> {
        const state = getSyncState(db, "message_categories");
        const since = state.lastAt > 0 ? Math.max(0, state.lastAt - UPDATE_WINDOW_MS) : 0;
        const rows = db
            .prepare("SELECT * FROM message_categories WHERE categorized_at >= ? ORDER BY categorized_at LIMIT ?")
            .all(since, BATCH_SIZE * 5) as any[];
        if (!rows.length) return;
        await upsertBatched(this.supabase, "message_categories", rows, "message_id");
        setSyncState(db, "message_categories", 0, Date.now());
        log.debug(`message_categories: synced ${rows.length} rows`);
    }
}

let _engine: SupabaseSyncEngine | null = null;

export function initSupabaseSync(): SupabaseSyncEngine {
    _engine = new SupabaseSyncEngine();
    return _engine;
}

export function getSupabaseSyncEngine(): SupabaseSyncEngine | null {
    return _engine;
}
