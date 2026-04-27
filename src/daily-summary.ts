import { createLogger } from "./utils/logger";
import { getStmts } from "./database/queries";
import { getDb } from "./database/connection";
import { notifyDailySummary } from "./utils/webhook-notifier";

const log = createLogger("DailySummary");

// Track the last date we sent summary notifications so we only send once per UTC day.
let lastNotifiedDate = "";

export function computeDailySummaries(): void {
    const stmts = getStmts();
    const db = getDb();
    const targets = stmts.getActiveTargets.all() as any[];

    const today = new Date();
    const dateStr = today.toISOString().split("T")[0];
    const dayStart = new Date(dateStr + "T00:00:00").getTime();
    const dayEnd = dayStart + 86400000;

    log.info(`Computing daily summaries for ${dateStr} (${targets.length} targets)`);

    const sendNotifications = lastNotifiedDate !== dateStr;
    if (sendNotifications) lastNotifiedDate = dateStr;

    for (const target of targets) {
        try {
            computeForTarget(db, stmts, target.user_id, dateStr, dayStart, dayEnd);

            if (sendNotifications) {
                const row = stmts.getDailySummaryByDate.get(target.user_id, dateStr) as any;
                if (row) {
                    notifyDailySummary(
                        target.user_id,
                        target.label || null,
                        dateStr,
                        {
                            onlineMinutes:  row.online_minutes  || 0,
                            idleMinutes:    row.idle_minutes    || 0,
                            dndMinutes:     row.dnd_minutes     || 0,
                            messageCount:   row.message_count   || 0,
                            voiceMinutes:   row.voice_minutes   || 0,
                            deleteCount:    row.delete_count    || 0,
                            editCount:      row.edit_count      || 0,
                            peakHour:       row.peak_hour       ?? null,
                        }
                    ).catch(() => {});
                }
            }
        } catch (err: any) {
            log.error(`Summary error for ${target.user_id}: ${err.message}`);
        }
    }

    log.info("Daily summaries computed");
}

function computeForTarget(
    db: any, stmts: any, targetId: string,
    dateStr: string, dayStart: number, dayEnd: number
): void {
    // Presence minutes
    const presenceSessions = db.prepare(
        `SELECT status, SUM(
            CASE WHEN end_time IS NOT NULL
                THEN (CASE WHEN end_time < ? THEN end_time ELSE ? END) - (CASE WHEN start_time > ? THEN start_time ELSE ? END)
                ELSE ? - (CASE WHEN start_time > ? THEN start_time ELSE ? END)
            END
        ) as total_ms
        FROM presence_sessions
        WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL)
        GROUP BY status`
    ).all(dayEnd, dayEnd, dayStart, dayStart, Date.now(), dayStart, dayStart, targetId, dayEnd, dayStart) as any[];

    let onlineMin = 0, idleMin = 0, dndMin = 0, offlineMin = 0;
    for (const s of presenceSessions) {
        const mins = Math.max(0, Math.round((s.total_ms || 0) / 60000));
        switch (s.status) {
            case "online": onlineMin = mins; break;
            case "idle": idleMin = mins; break;
            case "dnd": dndMin = mins; break;
            case "offline": offlineMin = mins; break;
        }
    }

    // Message counts
    const msgStats = db.prepare(
        `SELECT
            COUNT(*) as total,
            SUM(CASE WHEN edited_at IS NOT NULL AND edited_at >= ? AND edited_at < ? THEN 1 ELSE 0 END) as edits,
            SUM(CASE WHEN deleted_at IS NOT NULL AND deleted_at >= ? AND deleted_at < ? THEN 1 ELSE 0 END) as deletes
        FROM messages
        WHERE target_id = ? AND created_at >= ? AND created_at < ?`
    ).get(dayStart, dayEnd, dayStart, dayEnd, targetId, dayStart, dayEnd) as any;

    // Ghost typing
    const ghostStats = db.prepare(
        `SELECT COUNT(*) as total FROM typing_events
         WHERE target_id = ? AND timestamp >= ? AND timestamp < ? AND resulted_in_message = 0`
    ).get(targetId, dayStart, dayEnd) as any;

    // Voice minutes
    const voiceStats = db.prepare(
        `SELECT SUM(
            CASE WHEN end_time IS NOT NULL
                THEN (CASE WHEN end_time < ? THEN end_time ELSE ? END) - (CASE WHEN start_time > ? THEN start_time ELSE ? END)
                ELSE ? - (CASE WHEN start_time > ? THEN start_time ELSE ? END)
            END
        ) as total_ms
        FROM voice_sessions
        WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL)`
    ).get(dayEnd, dayEnd, dayStart, dayStart, Date.now(), dayStart, dayStart, targetId, dayEnd, dayStart) as any;

    const voiceMinutes = Math.max(0, Math.round((voiceStats?.total_ms || 0) / 60000));

    // Activity minutes by game
    const activityStats = db.prepare(
        `SELECT activity_name, SUM(
            CASE WHEN end_time IS NOT NULL
                THEN (CASE WHEN end_time < ? THEN end_time ELSE ? END) - (CASE WHEN start_time > ? THEN start_time ELSE ? END)
                ELSE ? - (CASE WHEN start_time > ? THEN start_time ELSE ? END)
            END
        ) as total_ms
        FROM activity_sessions
        WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL)
        GROUP BY activity_name`
    ).all(dayEnd, dayEnd, dayStart, dayStart, Date.now(), dayStart, dayStart, targetId, dayEnd, dayStart) as any[];

    const activityMinutes: Record<string, number> = {};
    for (const a of activityStats) {
        activityMinutes[a.activity_name] = Math.max(0, Math.round((a.total_ms || 0) / 60000));
    }

    // Reaction count
    const reactionCount = db.prepare(
        "SELECT COUNT(*) as count FROM reactions WHERE target_id = ? AND added_at >= ? AND added_at < ?"
    ).get(targetId, dayStart, dayEnd) as any;

    // First/last seen
    const firstSeen = db.prepare(
        "SELECT MIN(start_time) as t FROM presence_sessions WHERE target_id = ? AND start_time >= ? AND start_time < ? AND status != 'offline'"
    ).get(targetId, dayStart, dayEnd) as any;

    const lastSeen = db.prepare(
        "SELECT MAX(COALESCE(end_time, start_time)) as t FROM presence_sessions WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL) AND status != 'offline'"
    ).get(targetId, dayEnd, dayStart) as any;

    // Peak hour
    const hourCounts = db.prepare(
        "SELECT CAST(strftime('%H', timestamp / 1000, 'unixepoch') AS INTEGER) as hour, COUNT(*) as count FROM events WHERE target_id = ? AND timestamp >= ? AND timestamp < ? GROUP BY hour ORDER BY count DESC LIMIT 1"
    ).get(targetId, dayStart, dayEnd) as any;

    stmts.upsertDailySummary.run(
        targetId, dateStr,
        onlineMin, idleMin, dndMin, offlineMin,
        msgStats?.total || 0,
        msgStats?.edits || 0,
        msgStats?.deletes || 0,
        ghostStats?.total || 0,
        voiceMinutes,
        JSON.stringify(activityMinutes),
        reactionCount?.count || 0,
        firstSeen?.t || null,
        lastSeen?.t || null,
        hourCounts?.hour ?? null
    );
}
