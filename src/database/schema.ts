export const SCHEMA_VERSION = 6;

export const CREATE_TABLES_SQL = `
-- Core tables
CREATE TABLE IF NOT EXISTS targets (
    user_id TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL,
    label TEXT,
    notes TEXT,
    priority INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    timezone TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    data TEXT NOT NULL,
    guild_id TEXT,
    channel_id TEXT,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_guild ON events(guild_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel_id, timestamp);

CREATE TABLE IF NOT EXISTS profile_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    username TEXT,
    global_name TEXT,
    discriminator TEXT,
    avatar_hash TEXT,
    banner_hash TEXT,
    bio TEXT,
    pronouns TEXT,
    accent_color INTEGER,
    connected_accounts TEXT,
    mutual_guilds TEXT,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_snapshots_target ON profile_snapshots(target_id, timestamp);

CREATE TABLE IF NOT EXISTS presence_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL,
    platform TEXT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    duration_ms INTEGER,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_presence_target ON presence_sessions(target_id, start_time);

CREATE TABLE IF NOT EXISTS activity_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    activity_name TEXT NOT NULL,
    activity_type INTEGER NOT NULL,
    application_id TEXT,
    details TEXT,
    state TEXT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    duration_ms INTEGER,
    metadata TEXT,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activity_target ON activity_sessions(target_id, start_time);
CREATE INDEX IF NOT EXISTS idx_activity_name ON activity_sessions(activity_name, start_time);

CREATE TABLE IF NOT EXISTS voice_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    duration_ms INTEGER,
    self_mute INTEGER DEFAULT 0,
    self_deaf INTEGER DEFAULT 0,
    server_mute INTEGER DEFAULT 0,
    server_deaf INTEGER DEFAULT 0,
    streaming INTEGER DEFAULT 0,
    co_participants TEXT,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_voice_target ON voice_sessions(target_id, start_time);

CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    guild_id TEXT,
    content TEXT,
    content_length INTEGER,
    attachment_count INTEGER DEFAULT 0,
    embed_count INTEGER DEFAULT 0,
    has_sticker INTEGER DEFAULT 0,
    is_reply INTEGER DEFAULT 0,
    reply_to_user_id TEXT,
    reply_to_message_id TEXT,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    edit_history TEXT,
    word_count INTEGER,
    emoji_count INTEGER,
    mention_count INTEGER,
    link_count INTEGER,
    source TEXT NOT NULL DEFAULT 'live',
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS typing_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    guild_id TEXT,
    timestamp INTEGER NOT NULL,
    resulted_in_message INTEGER DEFAULT 0,
    message_delay_ms INTEGER,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_typing_target ON typing_events(target_id, timestamp);

CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_author_id TEXT,
    channel_id TEXT NOT NULL,
    guild_id TEXT,
    emoji_name TEXT NOT NULL,
    emoji_id TEXT,
    is_custom INTEGER DEFAULT 0,
    added_at INTEGER NOT NULL,
    removed_at INTEGER,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_id, added_at);

CREATE TABLE IF NOT EXISTS guild_member_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    old_value TEXT,
    new_value TEXT,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);

-- alert_rules includes all v2 columns in the base definition.
-- Migration v2 handles ALTER TABLE for databases that pre-date v2 (try/catch).
CREATE TABLE IF NOT EXISTS alert_rules (
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
    digest_mode INTEGER NOT NULL DEFAULT 0
);

-- alert_history uses ON DELETE SET NULL so deleting an alert rule never
-- blocks on referencing history rows (matches Supabase FK behaviour).
-- Migration v4 recreates this table for databases that pre-date v4.
CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    target_id TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    acknowledged INTEGER DEFAULT 0,
    FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_alert_history_target ON alert_history(target_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_alert_history_rule ON alert_history(rule_id);

CREATE TABLE IF NOT EXISTS daily_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    date TEXT NOT NULL,
    online_minutes INTEGER DEFAULT 0,
    idle_minutes INTEGER DEFAULT 0,
    dnd_minutes INTEGER DEFAULT 0,
    offline_minutes INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    edit_count INTEGER DEFAULT 0,
    delete_count INTEGER DEFAULT 0,
    ghost_type_count INTEGER DEFAULT 0,
    voice_minutes INTEGER DEFAULT 0,
    activity_minutes TEXT,
    reaction_count INTEGER DEFAULT 0,
    first_seen INTEGER,
    last_seen INTEGER,
    peak_hour INTEGER,
    UNIQUE(target_id, date),
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_daily_target ON daily_summaries(target_id, date);

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);

-- ── Relationship Analysis (AI Social Graph) ────────────────────────────────
CREATE TABLE IF NOT EXISTS relationship_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    other_user_id TEXT NOT NULL,
    classification TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.0,
    reasoning TEXT,
    analyzed_at INTEGER NOT NULL,
    data_window_start INTEGER NOT NULL,
    data_window_end INTEGER NOT NULL,
    UNIQUE(target_id, other_user_id),
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_relationship_target
    ON relationship_analysis(target_id, analyzed_at DESC);

-- ── Relationship History ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relationship_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    other_user_id TEXT NOT NULL,
    classification TEXT NOT NULL,
    confidence REAL NOT NULL,
    recorded_at INTEGER NOT NULL,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_relationship_history_pair
    ON relationship_history(target_id, other_user_id, recorded_at DESC);

-- ── Daily Briefs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    date TEXT NOT NULL,
    brief_text TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    UNIQUE(target_id, date),
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_daily_briefs_target
    ON daily_briefs(target_id, date DESC);

-- ── Backfill Progress ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backfill_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    messages_found INTEGER NOT NULL DEFAULT 0,
    oldest_message_id TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    UNIQUE(target_id, channel_id),
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_backfill_target
    ON backfill_progress(target_id, status);

-- ── Behavioral Baselines ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS behavioral_baselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    baseline_value REAL NOT NULL,
    std_deviation REAL NOT NULL,
    computed_at INTEGER NOT NULL,
    data_window_days INTEGER NOT NULL DEFAULT 30,
    UNIQUE(target_id, metric_name),
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);

-- ── Target Config ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS target_config (
    target_id TEXT PRIMARY KEY,
    social_weight_messages REAL NOT NULL DEFAULT 3.0,
    social_weight_reactions REAL NOT NULL DEFAULT 1.0,
    social_weight_voice_hours REAL NOT NULL DEFAULT 5.0,
    social_weight_mentions REAL NOT NULL DEFAULT 2.0,
    anomaly_z_threshold REAL NOT NULL DEFAULT 2.0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);

-- ── Message Categories ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_categories (
    message_id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    categorized_at INTEGER NOT NULL,
    FOREIGN KEY (target_id) REFERENCES targets(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_msg_categories_target
    ON message_categories(target_id, category);

-- ─── Supabase sync state ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
    table_name     TEXT    PRIMARY KEY,
    last_synced_id INTEGER NOT NULL DEFAULT 0,
    last_synced_at INTEGER NOT NULL DEFAULT 0
);

-- ─── Heartbeat log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS heartbeat_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL
);

-- ── Runtime Config ─────────────────────────────────────────────────────────────
-- Stores hot-swappable settings that override .env values without restart.
-- Sensitive keys (tokens, keys, URLs) are never returned in plaintext by the API.
CREATE TABLE IF NOT EXISTS runtime_config (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
`;