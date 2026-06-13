import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type Database from "better-sqlite3";
import { getDb } from "./connection";
import { config } from "../utils/config";
import { createLogger } from "../utils/logger";

const log = createLogger("Hydrator");
const PAGE_SIZE = 1000;

// ─── Supabase fetch (paginated) ───────────────────────────────────────────────

async function fetchAllRows(
    supabase: SupabaseClient,
    table: string,
    orderCol = "id"
): Promise<any[]> {
    const all: any[] = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from(table)
            .select("*")
            .order(orderCol, { ascending: true })
            .range(from, from + PAGE_SIZE - 1);

        if (error) throw new Error(`Supabase fetch on "${table}": ${error.message}`);
        if (!data || data.length === 0) break;

        all.push(...data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
        log.debug(`  ${table}: fetched ${all.length} so far…`);
    }

    return all;
}

// ─── SQLite bulk insert ───────────────────────────────────────────────────────

function bulkInsert(db: Database.Database, table: string, rows: any[]): void {
    if (!rows.length) return;

    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => "?").join(", ");
    const stmt = db.prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`
    );

    const insertAll = db.transaction((items: any[]) => {
        for (const row of items) {
            stmt.run(cols.map(c => {
                const v = row[c];
                // Supabase returns JS booleans for INTEGER columns; SQLite wants 0/1
                return typeof v === "boolean" ? (v ? 1 : 0) : v;
            }));
        }
    });

    insertAll(rows);
}

// ─── Initialize sync_state so the sync engine doesn't re-push everything ─────

function initSyncState(db: Database.Database, table: string, rows: any[]): void {
    if (!rows.length) return;

    // For tables with a numeric `id`, record the max id as already synced.
    // For messages (text PK), use the last_synced_at timestamp approach.
    const firstRow = rows[0];
    if (typeof firstRow.id === "number" || typeof firstRow.id === "bigint") {
        const maxId = Math.max(...rows.map(r => Number(r.id)));
        db.prepare(
            `INSERT INTO sync_state (table_name, last_synced_id, last_synced_at)
             VALUES (?, ?, ?)
             ON CONFLICT(table_name) DO UPDATE SET
                 last_synced_id = excluded.last_synced_id,
                 last_synced_at = excluded.last_synced_at`
        ).run(table, maxId, Date.now());
    } else if (table === "messages") {
        // messages uses timestamp-based sync tracking
        db.prepare(
            `INSERT INTO sync_state (table_name, last_synced_id, last_synced_at)
             VALUES (?, 0, ?)
             ON CONFLICT(table_name) DO UPDATE SET
                 last_synced_at = excluded.last_synced_at`
        ).run(table, Date.now());
    }
}

// ─── Table manifest (insertion order respects FK deps) ────────────────────────

const TABLES: Array<{ name: string; orderCol: string }> = [
    { name: "targets",               orderCol: "added_at" },
    { name: "alert_rules",           orderCol: "id" },
    { name: "target_config",         orderCol: "target_id" },
    { name: "behavioral_baselines",  orderCol: "id" },
    { name: "profile_snapshots",     orderCol: "id" },
    { name: "events",                orderCol: "id" },
    { name: "presence_sessions",     orderCol: "id" },
    { name: "activity_sessions",     orderCol: "id" },
    { name: "voice_sessions",        orderCol: "id" },
    { name: "messages",              orderCol: "created_at" },
    { name: "message_categories",    orderCol: "categorized_at" },
    { name: "daily_briefs",          orderCol: "id" },
    { name: "backfill_progress",     orderCol: "id" },
    { name: "typing_events",         orderCol: "id" },
    { name: "reactions",             orderCol: "id" },
    { name: "guild_member_events",   orderCol: "id" },
    { name: "alert_history",         orderCol: "id" },
    { name: "daily_summaries",       orderCol: "id" },
    { name: "relationship_analysis", orderCol: "id" },
    { name: "relationship_history",  orderCol: "id" },
    // runtime_config last so any FK-bearing tables loaded above don't depend
    // on it. Sensitive values arrive in the `enc:v1:` envelope and are
    // decrypted lazily by runtime-config.ts:loadRuntimeConfig at startup.
    { name: "runtime_config",        orderCol: "key" },
];

// ─── Public entry point ───────────────────────────────────────────────────────

export async function hydrateFromSupabase(): Promise<void> {
    log.info("=== Hydrating SQLite from Supabase ===");
    const started = Date.now();

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    // Connectivity check
    const { error: pingErr } = await supabase
        .from("targets")
        .select("user_id")
        .limit(1);

    if (pingErr) {
        throw new Error(
            `Cannot reach Supabase for hydration: ${pingErr.message}\n` +
            `Check SUPABASE_URL / SUPABASE_SERVICE_KEY and that supabase-schema.sql has been run.`
        );
    }

    const db = getDb();
    let totalRows = 0;

    for (const { name, orderCol } of TABLES) {
        log.info(`Fetching ${name}…`);
        const rows = await fetchAllRows(supabase, name, orderCol);

        if (rows.length > 0) {
            bulkInsert(db, name, rows);
            initSyncState(db, name, rows);
            log.info(`  ${name}: ${rows.length} rows`);
            totalRows += rows.length;
        } else {
            log.info(`  ${name}: empty`);
        }
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    log.info(`=== Hydration complete: ${totalRows} total rows in ${elapsed}s ===`);
}
