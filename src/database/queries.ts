import type Database from "better-sqlite3";
import { getDb } from "./connection";

type Stmts = { [K: string]: Database.Statement };

let _stmts: Stmts | null = null;

function prepareStatements() {
    const db = getDb();
    return {
        // ── Targets ────────────────────────────────────────────────────────────
        insertTarget: db.prepare(
            "INSERT OR IGNORE INTO targets (user_id, added_at, label, notes, priority, active, timezone) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ),
        getTarget: db.prepare("SELECT * FROM targets WHERE user_id = ?"),
        getAllTargets: db.prepare("SELECT * FROM targets"),
        getActiveTargets: db.prepare("SELECT * FROM targets WHERE active = 1"),
        updateTarget: db.prepare(
            "UPDATE targets SET label = COALESCE(?, label), notes = COALESCE(?, notes), priority = COALESCE(?, priority), active = COALESCE(?, active) WHERE user_id = ?"
        ),
        deleteTarget: db.prepare("DELETE FROM targets WHERE user_id = ?"),

        // ── Events ─────────────────────────────────────────────────────────────
        insertEvent: db.prepare(
            "INSERT INTO events (target_id, event_type, timestamp, data, guild_id, channel_id) VALUES (?, ?, ?, ?, ?, ?)"
        ),
        getEventsByTarget: db.prepare(
            "SELECT * FROM events WHERE target_id = ? ORDER BY timestamp DESC LIMIT ?"
        ),
        getEventsByType: db.prepare(
            "SELECT * FROM events WHERE event_type = ? ORDER BY timestamp DESC LIMIT ?"
        ),
        getEventsFiltered: db.prepare(
            "SELECT * FROM events WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ? OFFSET ?"
        ),
        getEventCount: db.prepare("SELECT COUNT(*) as count FROM events"),
        getEventCountByTarget: db.prepare("SELECT COUNT(*) as count FROM events WHERE target_id = ?"),

        // ── Profile snapshots ──────────────────────────────────────────────────
        insertSnapshot: db.prepare(
            `INSERT INTO profile_snapshots
             (target_id, timestamp, username, global_name, discriminator,
              avatar_hash, banner_hash, bio, pronouns, accent_color,
              connected_accounts, mutual_guilds)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        getLatestSnapshot: db.prepare(
            "SELECT * FROM profile_snapshots WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1"
        ),
        getSnapshotHistory: db.prepare(
            "SELECT * FROM profile_snapshots WHERE target_id = ? ORDER BY timestamp DESC LIMIT ?"
        ),

        // ── Presence sessions ──────────────────────────────────────────────────
        insertPresenceSession: db.prepare(
            "INSERT INTO presence_sessions (target_id, status, platform, start_time) VALUES (?, ?, ?, ?)"
        ),
        // Closes ALL open presence sessions for a target in one statement.
        // The single-row close helper was removed because it could leave
        // orphaned sessions if duplicates ever existed.
        closeAllOpenPresenceSessions: db.prepare(
            "UPDATE presence_sessions SET end_time = ?, duration_ms = ? - start_time WHERE target_id = ? AND end_time IS NULL"
        ),
        getOpenPresenceSession: db.prepare(
            "SELECT * FROM presence_sessions WHERE target_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1"
        ),
        getPresenceSessions: db.prepare(
            "SELECT * FROM presence_sessions WHERE target_id = ? AND start_time >= ? AND start_time <= ? ORDER BY start_time DESC"
        ),
        // Most recent closed session where the user was NOT offline (for $seen command).
        getLastSeenOnline: db.prepare(
            `SELECT * FROM presence_sessions
             WHERE target_id = ? AND status != 'offline' AND end_time IS NOT NULL
             ORDER BY end_time DESC LIMIT 1`
        ),
        // Sum of active (non-offline) presence time starting from a given epoch ms.
        // For open sessions (end_time IS NULL) the current time is substituted via param 1.
        // Param order: now_ms, target_id, window_start_ms
        getTodayActiveMs: db.prepare(
            `SELECT COALESCE(SUM(
                 CASE WHEN end_time IS NOT NULL THEN duration_ms
                      ELSE ? - start_time END
             ), 0) AS total_ms
             FROM presence_sessions
             WHERE target_id = ? AND status IN ('online', 'idle', 'dnd') AND start_time >= ?`
        ),
        // Last N presence sessions in reverse chronological order (for $history command).
        getRecentPresenceSessions: db.prepare(
            "SELECT * FROM presence_sessions WHERE target_id = ? ORDER BY start_time DESC LIMIT ?"
        ),

        // ── Activity sessions ──────────────────────────────────────────────────
        insertActivitySession: db.prepare(
            "INSERT INTO activity_sessions (target_id, activity_name, activity_type, application_id, details, state, start_time, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        closeActivitySession: db.prepare(
            "UPDATE activity_sessions SET end_time = ?, duration_ms = ? - start_time WHERE id = ?"
        ),
        getOpenActivitySessions: db.prepare(
            "SELECT * FROM activity_sessions WHERE target_id = ? AND end_time IS NULL"
        ),
        getActivitySessions: db.prepare(
            "SELECT * FROM activity_sessions WHERE target_id = ? AND start_time >= ? ORDER BY start_time DESC LIMIT ?"
        ),

        // ── Voice sessions ─────────────────────────────────────────────────────
        insertVoiceSession: db.prepare(
            "INSERT INTO voice_sessions (target_id, guild_id, channel_id, channel_name, start_time, self_mute, self_deaf, server_mute, server_deaf, streaming) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        closeVoiceSession: db.prepare(
            "UPDATE voice_sessions SET end_time = ?, duration_ms = ? - start_time, co_participants = ? WHERE id = ?"
        ),
        getOpenVoiceSession: db.prepare(
            "SELECT * FROM voice_sessions WHERE target_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1"
        ),
        updateVoiceSessionState: db.prepare(
            "UPDATE voice_sessions SET self_mute = ?, self_deaf = ?, server_mute = ?, server_deaf = ?, streaming = ? WHERE id = ?"
        ),
        updateVoiceCoParticipants: db.prepare(
            "UPDATE voice_sessions SET co_participants = ? WHERE id = ?"
        ),
        getVoiceSessions: db.prepare(
            "SELECT * FROM voice_sessions WHERE target_id = ? AND start_time >= ? ORDER BY start_time DESC LIMIT ?"
        ),

        // ── Messages ───────────────────────────────────────────────────────────
        insertMessage: db.prepare(
            `INSERT OR IGNORE INTO messages
             (message_id, target_id, channel_id, guild_id, content, content_length,
              attachment_count, embed_count, has_sticker, is_reply,
              reply_to_user_id, reply_to_message_id, created_at,
              word_count, emoji_count, mention_count, link_count, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        updateMessageEdited: db.prepare(
            "UPDATE messages SET content = ?, content_length = ?, edited_at = ?, edit_history = ? WHERE message_id = ?"
        ),
        markMessageDeleted: db.prepare(
            "UPDATE messages SET deleted_at = ? WHERE message_id = ?"
        ),
        getMessage: db.prepare("SELECT * FROM messages WHERE message_id = ?"),
        getMessagesByTarget: db.prepare(
            "SELECT * FROM messages WHERE target_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
        ),
        getDeletedMessages: db.prepare(
            "SELECT * FROM messages WHERE target_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?"
        ),
        getEditedMessages: db.prepare(
            "SELECT * FROM messages WHERE target_id = ? AND edited_at IS NOT NULL ORDER BY edited_at DESC LIMIT ? OFFSET ?"
        ),
        searchMessages: db.prepare(
            "SELECT * FROM messages WHERE target_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?"
        ),

        // ── Typing events ──────────────────────────────────────────────────────
        insertTypingEvent: db.prepare(
            "INSERT INTO typing_events (target_id, channel_id, guild_id, timestamp) VALUES (?, ?, ?, ?)"
        ),
        updateTypingResult: db.prepare(
            "UPDATE typing_events SET resulted_in_message = 1, message_delay_ms = ? WHERE id = ?"
        ),
        getRecentTypingEvent: db.prepare(
            "SELECT * FROM typing_events WHERE target_id = ? AND channel_id = ? AND resulted_in_message = 0 ORDER BY timestamp DESC LIMIT 1"
        ),
        getTypingEvents: db.prepare(
            "SELECT * FROM typing_events WHERE target_id = ? ORDER BY timestamp DESC LIMIT ?"
        ),

        // ── Reactions ──────────────────────────────────────────────────────────
        insertReaction: db.prepare(
            "INSERT INTO reactions (target_id, message_id, message_author_id, channel_id, guild_id, emoji_name, emoji_id, is_custom, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        removeReaction: db.prepare(
            "UPDATE reactions SET removed_at = ? WHERE target_id = ? AND message_id = ? AND emoji_name = ? AND removed_at IS NULL"
        ),
        getReactions: db.prepare(
            "SELECT * FROM reactions WHERE target_id = ? ORDER BY added_at DESC LIMIT ?"
        ),

        // ── Guild member events ────────────────────────────────────────────────
        insertGuildMemberEvent: db.prepare(
            "INSERT INTO guild_member_events (target_id, guild_id, event_type, timestamp, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)"
        ),

        // ── Alert rules ────────────────────────────────────────────────────────
        // Includes all v2 columns (fire_count_24h, auto_suppressed, fatigue_threshold,
        // composite_condition, digest_mode). The schema also has these from v2 migration.
        insertAlertRule: db.prepare(
            `INSERT INTO alert_rules
             (target_id, rule_type, condition, enabled, created_at,
              digest_mode, fatigue_threshold, composite_condition)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        getAlertRules: db.prepare("SELECT * FROM alert_rules WHERE enabled = 1"),
        getAllAlertRules: db.prepare("SELECT * FROM alert_rules"),
        deleteAlertRule: db.prepare("DELETE FROM alert_rules WHERE id = ?"),
        toggleAlertRule: db.prepare("UPDATE alert_rules SET enabled = ? WHERE id = ?"),

        // ── Alert history ──────────────────────────────────────────────────────
        insertAlertHistory: db.prepare(
            "INSERT INTO alert_history (rule_id, target_id, alert_type, message, timestamp) VALUES (?, ?, ?, ?, ?)"
        ),
        getAlertHistory: db.prepare(
            "SELECT * FROM alert_history ORDER BY timestamp DESC LIMIT ? OFFSET ?"
        ),
        getAlertHistoryByTarget: db.prepare(
            "SELECT * FROM alert_history WHERE target_id = ? ORDER BY timestamp DESC LIMIT ?"
        ),
        acknowledgeAlert: db.prepare(
            "UPDATE alert_history SET acknowledged = 1 WHERE id = ?"
        ),
        // Set rule_id = NULL before deleting an alert rule to prevent FK violation.
        // alert_history.rule_id has ON DELETE SET NULL in the schema but older
        // databases (pre-v4) may not, so we do it explicitly here as well.
        nullifyAlertRuleInHistory: db.prepare(
            "UPDATE alert_history SET rule_id = NULL WHERE rule_id = ?"
        ),

        // ── Daily summaries ────────────────────────────────────────────────────
        upsertDailySummary: db.prepare(
            `INSERT INTO daily_summaries
             (target_id, date, online_minutes, idle_minutes, dnd_minutes,
              offline_minutes, message_count, edit_count, delete_count,
              ghost_type_count, voice_minutes, activity_minutes,
              reaction_count, first_seen, last_seen, peak_hour)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(target_id, date) DO UPDATE SET
                online_minutes   = excluded.online_minutes,
                idle_minutes     = excluded.idle_minutes,
                dnd_minutes      = excluded.dnd_minutes,
                offline_minutes  = excluded.offline_minutes,
                message_count    = excluded.message_count,
                edit_count       = excluded.edit_count,
                delete_count     = excluded.delete_count,
                ghost_type_count = excluded.ghost_type_count,
                voice_minutes    = excluded.voice_minutes,
                activity_minutes = excluded.activity_minutes,
                reaction_count   = excluded.reaction_count,
                first_seen       = excluded.first_seen,
                last_seen        = excluded.last_seen,
                peak_hour        = excluded.peak_hour`
        ),
        // Returns rows with an extra computed field total_active_minutes
        // = online_minutes + idle_minutes + dnd_minutes
        // (Online, DND, and Idle are all "active" — only Offline is not.)
        getDailySummaries: db.prepare(
            `SELECT *,
                    (online_minutes + idle_minutes + dnd_minutes) AS total_active_minutes
             FROM daily_summaries
             WHERE target_id = ?
             ORDER BY date DESC
             LIMIT ?`
        ),
        getDailySummaryByDate: db.prepare(
            `SELECT *,
                    (online_minutes + idle_minutes + dnd_minutes) AS total_active_minutes
             FROM daily_summaries
             WHERE target_id = ? AND date = ?`
        ),

        // ── Heartbeat log ──────────────────────────────────────────────────────
        insertHeartbeat: db.prepare(
            "INSERT INTO heartbeat_log (timestamp) VALUES (?)"
        ),
        getLastHeartbeat: db.prepare(
            "SELECT timestamp FROM heartbeat_log ORDER BY timestamp DESC LIMIT 1"
        ),
        pruneHeartbeats: db.prepare(
            `DELETE FROM heartbeat_log
             WHERE id NOT IN (
                 SELECT id FROM heartbeat_log ORDER BY timestamp DESC LIMIT 30
             )`
        ),

        // ── Relationship analysis ──────────────────────────────────────────────
        upsertRelationshipAnalysis: db.prepare(
            `INSERT INTO relationship_analysis
             (target_id, other_user_id, classification, confidence, reasoning, analyzed_at, data_window_start, data_window_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(target_id, other_user_id) DO UPDATE SET
                 classification=excluded.classification, confidence=excluded.confidence,
                 reasoning=excluded.reasoning, analyzed_at=excluded.analyzed_at,
                 data_window_start=excluded.data_window_start, data_window_end=excluded.data_window_end`
        ),
        getRelationshipAnalysis: db.prepare(
            "SELECT * FROM relationship_analysis WHERE target_id = ? ORDER BY analyzed_at DESC"
        ),
        getRelationshipPair: db.prepare(
            "SELECT * FROM relationship_analysis WHERE target_id = ? AND other_user_id = ?"
        ),
        insertRelationshipHistory: db.prepare(
            "INSERT INTO relationship_history (target_id, other_user_id, classification, confidence, recorded_at) VALUES (?, ?, ?, ?, ?)"
        ),
        getRelationshipHistory: db.prepare(
            "SELECT * FROM relationship_history WHERE target_id = ? AND other_user_id = ? ORDER BY recorded_at DESC LIMIT ?"
        ),
        getRelationshipChanges: db.prepare(
            "SELECT * FROM relationship_history WHERE target_id = ? ORDER BY recorded_at DESC LIMIT ?"
        ),

        // ── Daily briefs ───────────────────────────────────────────────────────
        insertDailyBrief: db.prepare(
            `INSERT INTO daily_briefs (target_id, date, brief_text, generated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(target_id, date) DO UPDATE SET
                 brief_text=excluded.brief_text, generated_at=excluded.generated_at`
        ),
        getDailyBriefs: db.prepare(
            "SELECT * FROM daily_briefs WHERE target_id = ? ORDER BY date DESC LIMIT ?"
        ),
        getDailyBriefByDate: db.prepare(
            "SELECT * FROM daily_briefs WHERE target_id = ? AND date = ?"
        ),

        // ── Backfill progress ──────────────────────────────────────────────────
        insertBackfillProgress: db.prepare(
            `INSERT OR IGNORE INTO backfill_progress (target_id, guild_id, channel_id, status)
             VALUES (?, ?, ?, 'pending')`
        ),
        updateBackfillProgress: db.prepare(
            `UPDATE backfill_progress SET status=?, messages_found=?, oldest_message_id=?,
             started_at=COALESCE(started_at, ?), completed_at=?, error=?
             WHERE target_id=? AND channel_id=?`
        ),
        getBackfillProgress: db.prepare(
            "SELECT * FROM backfill_progress WHERE target_id = ? ORDER BY status, guild_id, channel_id"
        ),
        getPendingBackfillChannels: db.prepare(
            "SELECT * FROM backfill_progress WHERE target_id = ? AND status IN ('pending', 'in_progress') LIMIT 50"
        ),
        hasBackfillData: db.prepare(
            "SELECT COUNT(*) as count FROM backfill_progress WHERE target_id = ?"
        ),
        resetAllBackfillForTarget: db.prepare(
            `UPDATE backfill_progress
             SET status = 'pending', messages_found = 0, oldest_message_id = NULL,
                 started_at = NULL, completed_at = NULL, error = NULL
             WHERE target_id = ?`
        ),
        deleteAllBackfillForTarget: db.prepare(
            "DELETE FROM backfill_progress WHERE target_id = ?"
        ),
        getKnownGuildsForTarget: db.prepare(
            "SELECT DISTINCT guild_id FROM backfill_progress WHERE target_id = ?"
        ),

        // ── Message categories ─────────────────────────────────────────────────
        insertMessageCategory: db.prepare(
            `INSERT OR REPLACE INTO message_categories (message_id, target_id, category, confidence, categorized_at)
             VALUES (?, ?, ?, ?, ?)`
        ),
        getUncategorizedMessages: db.prepare(
            `SELECT m.message_id, m.content FROM messages m
             LEFT JOIN message_categories mc ON m.message_id = mc.message_id
             WHERE m.target_id = ? AND mc.message_id IS NULL AND m.content IS NOT NULL AND m.content_length > 5
             ORDER BY m.created_at DESC LIMIT ?`
        ),
        getCategoryBreakdown: db.prepare(
            `SELECT category, COUNT(*) as count FROM message_categories WHERE target_id = ? GROUP BY category ORDER BY count DESC`
        ),

        // ── Behavioral baselines ───────────────────────────────────────────────
        upsertBaselineMetric: db.prepare(
            `INSERT INTO behavioral_baselines (target_id, metric_name, baseline_value, std_deviation, computed_at, data_window_days)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(target_id, metric_name) DO UPDATE SET
                 baseline_value=excluded.baseline_value, std_deviation=excluded.std_deviation,
                 computed_at=excluded.computed_at`
        ),
        getBaselineMetric: db.prepare(
            "SELECT * FROM behavioral_baselines WHERE target_id = ? AND metric_name = ?"
        ),
        getAllBaselines: db.prepare(
            "SELECT * FROM behavioral_baselines WHERE target_id = ?"
        ),
        upsertTargetConfig: db.prepare(
            `INSERT INTO target_config (target_id, social_weight_messages, social_weight_reactions, social_weight_voice_hours, social_weight_mentions, anomaly_z_threshold, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(target_id) DO UPDATE SET
                 social_weight_messages=excluded.social_weight_messages,
                 social_weight_reactions=excluded.social_weight_reactions,
                 social_weight_voice_hours=excluded.social_weight_voice_hours,
                 social_weight_mentions=excluded.social_weight_mentions,
                 anomaly_z_threshold=excluded.anomaly_z_threshold,
                 updated_at=excluded.updated_at`
        ),
        getTargetConfig: db.prepare(
            "SELECT * FROM target_config WHERE target_id = ?"
        ),

        // ── Alert fatigue ──────────────────────────────────────────────────────
        incrementAlertFireCount: db.prepare(
            "UPDATE alert_rules SET fire_count_24h = fire_count_24h + 1, last_fire_at = ? WHERE id = ?"
        ),
        suppressAlertRule: db.prepare(
            "UPDATE alert_rules SET auto_suppressed = 1 WHERE id = ?"
        ),
        unsuppressAlertRule: db.prepare(
            "UPDATE alert_rules SET auto_suppressed = 0, fire_count_24h = 0 WHERE id = ?"
        ),
        resetAlertFireCounts: db.prepare(
            "UPDATE alert_rules SET fire_count_24h = 0 WHERE last_fire_at < ? AND last_fire_at IS NOT NULL"
        ),
        getSuppressedRules: db.prepare(
            "SELECT * FROM alert_rules WHERE auto_suppressed = 1"
        ),

        // ── Utility ────────────────────────────────────────────────────────────
        getDbSize: db.prepare(
            "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()"
        ),
    };
}

export function getStmts(): Stmts {
    if (!_stmts) {
        _stmts = prepareStatements();
    }
    return _stmts;
}

export function resetStmts(): void {
    _stmts = null;
}