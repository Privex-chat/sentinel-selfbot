export const SCHEMA_VERSION = 1;

export const CREATE_TABLES_SQL = `
-- Core tables
CREATE TABLE IF NOT EXISTS targets (
    user_id TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL,
    label TEXT,
    notes TEXT,
    priority INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    data TEXT NOT NULL,
    guild_id TEXT,
    channel_id TEXT,
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
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
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
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
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
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
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
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
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
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
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
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
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
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
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
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
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
);

CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT,
    rule_type TEXT NOT NULL,
    condition TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    target_id TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    acknowledged INTEGER DEFAULT 0,
    FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
);

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
    FOREIGN KEY (target_id) REFERENCES targets(user_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_target ON daily_summaries(target_id, date);

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);

-- ─── Supabase sync state ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
    table_name     TEXT    PRIMARY KEY,
    last_synced_id INTEGER NOT NULL DEFAULT 0,
    last_synced_at INTEGER NOT NULL DEFAULT 0
);

-- ─── Heartbeat log ────────────────────────────────────────────────────────────
-- Written every 60 s so that on an unclean exit we know the last moment the
-- process was definitely alive. Used to close stale sessions more accurately
-- than using the restart timestamp. Local-only — not synced to Supabase.
CREATE TABLE IF NOT EXISTS heartbeat_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL
);
`;