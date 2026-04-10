import { config as dotenvConfig } from "dotenv";
import path from "path";

dotenvConfig();

// Normalise legacy / alias mode strings to the canonical set.
function normaliseDbMode(raw: string): "local" | "local+cloud" | "cloud" {
    switch (raw) {
        case "both":
        case "local+cloud": return "local+cloud";
        case "cloud":       return "cloud";
        default:            return "local";
    }
}

export const config = {
    discordToken:    process.env.DISCORD_TOKEN    || "",
    apiPort:         parseInt(process.env.API_PORT || "48923", 10),
    apiAuthToken:    process.env.API_AUTH_TOKEN   || "",
    dbPath:          process.env.DB_PATH          || path.join(process.cwd(), "data", "sentinel.db"),
    logLevel:       (process.env.LOG_LEVEL        || "info") as "debug" | "info" | "warn" | "error",

    profilePollIntervalMs:  parseInt(process.env.PROFILE_POLL_INTERVAL_MS  || "300000",  10),
    statusPollIntervalMs:   parseInt(process.env.STATUS_POLL_INTERVAL_MS   || "120000",  10),
    dailySummaryIntervalMs: parseInt(process.env.DAILY_SUMMARY_INTERVAL_MS || "3600000", 10),

    // When true: adds ±20% random jitter to all polling intervals and
    // randomises the browser/OS strings in the Discord gateway IDENTIFY.
    randomJitter: process.env.RANDOM_JITTER === "true",

    // ── Database mode ──────────────────────────────────────────────────────────
    //
    //   local       – SQLite only. Use this on a home server or VPS with a
    //                 persistent disk. No Supabase needed.
    //
    //   local+cloud – SQLite is the working database; Supabase receives an
    //                 async mirror copy on a configurable interval. Good for
    //                 home servers that want a cloud backup.
    //                 ("both" is accepted as a legacy alias.)
    //
    //   cloud       – Designed for ephemeral hosts (Railway, Render, Fly.io).
    //                 On startup, SQLite is hydrated from Supabase so all
    //                 historical data is available immediately. Supabase is
    //                 the permanent store; SQLite is a fast local cache.
    //                 Set SUPABASE_SYNC_INTERVAL_MS low (e.g. 30000) so data
    //                 isn't lost if the container is killed between syncs.
    //
    dbMode: normaliseDbMode(process.env.DB_MODE || "local"),

    supabaseUrl:            process.env.SUPABASE_URL         || "",
    supabaseServiceKey:     process.env.SUPABASE_SERVICE_KEY || "",
    supabaseSyncIntervalMs: parseInt(
        process.env.SUPABASE_SYNC_INTERVAL_MS ||
        // Default to 30 s in cloud mode, 5 min otherwise.
        (normaliseDbMode(process.env.DB_MODE || "local") === "cloud" ? "30000" : "300000"),
        10
    ),
};

export function validateConfig(): void {
    if (!config.discordToken)  throw new Error("DISCORD_TOKEN is required");
    if (!config.apiAuthToken)  throw new Error("API_AUTH_TOKEN is required");

    if (config.dbMode === "local+cloud" || config.dbMode === "cloud") {
        if (!config.supabaseUrl)
            throw new Error(`DB_MODE="${config.dbMode}" requires SUPABASE_URL`);
        if (!config.supabaseServiceKey)
            throw new Error(`DB_MODE="${config.dbMode}" requires SUPABASE_SERVICE_KEY`);
    }
}
