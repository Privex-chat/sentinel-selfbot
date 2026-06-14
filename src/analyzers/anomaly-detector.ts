import { createLogger } from "../utils/logger";
import { getDb } from "../database/connection";
import { getStmts } from "../database/queries";
import { analyzeSleepSchedule } from "./sleep-schedule";
import { computeZScore, isAnomaly } from "./baseline";
import { getTargetTimezone, isBootstrapping, getBootstrapCompletedAt } from "../target-lifecycle";
import { getHourInTz } from "../utils/timezone";

const log = createLogger("AnomalyDetector");

export interface Anomaly {
    type: string;
    severity: "low" | "medium" | "high";
    description: string;
    timestamp: number;
    data?: any;
}

/**
 * Detect anomalies for a target across the last `days` window.
 *
 * Previous implementation bulk-loaded up to 60 000 events (10 000 recent +
 * 50 000 baseline) and then JS-filtered them N times — including an O(N×M)
 * scan for the NEW_GAME check. On a busy target that was multiple seconds of
 * synchronous work per `/insights/anomalies` request.
 *
 * Now each anomaly type runs a targeted SQL aggregate or filtered SELECT, so
 * we only pull the rows we actually need. The new-game check uses
 * `json_extract` to compare names directly inside SQLite instead of materialising
 * thousands of activity events on the JS heap.
 */
export function detectAnomalies(targetId: string, days: number = 7): Anomaly[] {
    // Suppress everything while the target is still onboarding. The first
    // wave of profile + presence events during bootstrap is mostly artefacts
    // (incomplete first observations + initial status discovery) and surfacing
    // those as anomalies is exactly the noise we're trying to eliminate.
    if (isBootstrapping(targetId)) {
        return [];
    }

    const db = getDb();
    const tz = getTargetTimezone(targetId);
    const anomalies: Anomaly[] = [];
    const now = Date.now();
    // Clamp the window's `since` to bootstrap_completed_at so historical events
    // that landed during onboarding can never resurface as "recent anomalies"
    // once the target moves into operational mode. Cap baselineSince the same
    // way for the same reason — pre-bootstrap data isn't a valid baseline.
    const bootstrapAt = getBootstrapCompletedAt(targetId) ?? 0;
    const since = Math.max(now - days * 86400000, bootstrapAt);
    const baselineSince = Math.max(now - 30 * 86400000, bootstrapAt);
    const baselineDayCount = Math.max((since - baselineSince) / 86400000, 1);

    // ── 1. Unusual online hours (sleep window) ─────────────────────────────
    // Only fetch PRESENCE_UPDATE rows in the recent window — much smaller than
    // the full event set. data is JSON and we need newStatus + timestamp.
    const sleep = analyzeSleepSchedule(targetId);
    if (sleep.estimatedBedtime && sleep.estimatedWakeTime) {
        const presenceEvents = db.prepare(
            `SELECT timestamp, data FROM events
             WHERE target_id = ? AND event_type = 'PRESENCE_UPDATE' AND timestamp >= ?`
        ).all(targetId, since) as Array<{ timestamp: number; data: string }>;

        const bedHour  = parseInt(sleep.estimatedBedtime!.split(":")[0], 10);
        const wakeHour = parseInt(sleep.estimatedWakeTime!.split(":")[0], 10);

        for (const e of presenceEvents) {
            try {
                const data = JSON.parse(e.data);
                if (data.newStatus === "offline") continue;

                const hour = getHourInTz(e.timestamp, tz);
                let isSleepHour = false;
                if (bedHour > wakeHour) {
                    isSleepHour = hour >= bedHour || hour < wakeHour;
                } else if (bedHour < wakeHour) {
                    isSleepHour = hour >= bedHour && hour < wakeHour;
                }
                if (isSleepHour) {
                    anomalies.push({
                        type: "UNUSUAL_HOUR",
                        severity: "medium",
                        description: `Online at ${hour}:00 (usual sleep: ${sleep.estimatedBedtime}-${sleep.estimatedWakeTime})`,
                        timestamp: e.timestamp,
                    });
                }
            } catch { /* malformed JSON — skip */ }
        }
    }

    // ── 2. Message-volume anomaly ──────────────────────────────────────────
    // Pure aggregates — let SQLite count, never touch the rows in JS.
    const recentMsgCount = (db.prepare(
        `SELECT COUNT(*) AS c FROM events
         WHERE target_id = ? AND event_type = 'MESSAGE_CREATE' AND timestamp >= ?`
    ).get(targetId, since) as { c: number }).c;
    const recentDailyMsgs = recentMsgCount / days;

    if (isAnomaly(targetId, "daily_message_count", recentDailyMsgs)) {
        const z = computeZScore(targetId, "daily_message_count", recentDailyMsgs);
        const baselineMsgCount = (db.prepare(
            `SELECT COUNT(*) AS c FROM events
             WHERE target_id = ? AND event_type = 'MESSAGE_CREATE'
               AND timestamp >= ? AND timestamp < ?`
        ).get(targetId, baselineSince, since) as { c: number }).c;
        const avgDailyMsgs = baselineMsgCount / baselineDayCount;

        if (z > 0) {
            anomalies.push({
                type: "HIGH_MESSAGE_VOLUME",
                severity: "low",
                description: `Messaging ${Math.round(recentDailyMsgs)}x/day vs ${Math.round(avgDailyMsgs)}x/day baseline (z=${z.toFixed(1)})`,
                timestamp: now,
            });
        } else {
            anomalies.push({
                type: "LOW_MESSAGE_VOLUME",
                severity: "medium",
                description: `Messaging only ${Math.round(recentDailyMsgs)}x/day vs ${Math.round(avgDailyMsgs)}x/day baseline (z=${z.toFixed(1)})`,
                timestamp: now,
            });
        }
    }

    // ── 3. New-game detection ──────────────────────────────────────────────
    // Pull just the activity-start events in the recent window. For each one,
    // ask SQLite (via json_extract + EXISTS) whether the same game name appears
    // in the baseline window. The previous O(N×M) JS join is now a tiny SQL
    // lookup per recent row, indexed by (target_id, timestamp).
    const recentActivities = db.prepare(
        `SELECT timestamp, data FROM events
         WHERE target_id = ? AND event_type = 'ACTIVITY_START' AND timestamp >= ?`
    ).all(targetId, since) as Array<{ timestamp: number; data: string }>;

    const baselineActivityExists = db.prepare(
        `SELECT 1 FROM events
         WHERE target_id = ? AND event_type = 'ACTIVITY_START'
           AND timestamp >= ? AND timestamp < ?
           AND json_extract(data, '$.name') = ?
         LIMIT 1`
    );

    for (const e of recentActivities) {
        try {
            const data = JSON.parse(e.data);
            if (data.type !== 0 || !data.name) continue;
            const hit = baselineActivityExists.get(targetId, baselineSince, since, data.name);
            if (!hit) {
                anomalies.push({
                    type: "NEW_GAME",
                    severity: "low",
                    description: `Playing "${data.name}" for the first time`,
                    timestamp: e.timestamp,
                });
            }
        } catch { /* malformed JSON — skip */ }
    }

    // ── 4. Profile changes ─────────────────────────────────────────────────
    const profileChanges = db.prepare(
        `SELECT event_type, timestamp FROM events
         WHERE target_id = ? AND timestamp >= ?
           AND event_type IN ('PROFILE_UPDATE', 'AVATAR_CHANGE', 'USERNAME_CHANGE')`
    ).all(targetId, since) as Array<{ event_type: string; timestamp: number }>;

    for (const e of profileChanges) {
        anomalies.push({
            type: "PROFILE_CHANGE",
            severity: "medium",
            description: `Profile updated: ${e.event_type}`,
            timestamp: e.timestamp,
        });
    }

    // ── 5. Ghost-typing spike ──────────────────────────────────────────────
    const recentGhosts = (db.prepare(
        `SELECT COUNT(*) AS c FROM events
         WHERE target_id = ? AND event_type = 'GHOST_TYPE' AND timestamp >= ?`
    ).get(targetId, since) as { c: number }).c;
    const recentGhostDaily = recentGhosts / days;

    if (isAnomaly(targetId, "daily_ghost_type_count", recentGhostDaily)) {
        const z = computeZScore(targetId, "daily_ghost_type_count", recentGhostDaily);
        if (z > 0) {
            const baselineGhosts = (db.prepare(
                `SELECT COUNT(*) AS c FROM events
                 WHERE target_id = ? AND event_type = 'GHOST_TYPE'
                   AND timestamp >= ? AND timestamp < ?`
            ).get(targetId, baselineSince, since) as { c: number }).c;
            const avgGhosts = baselineGhosts / baselineDayCount;
            anomalies.push({
                type: "GHOST_TYPE_SPIKE",
                severity: "low",
                description: `Ghost typing rate spiked: ${Math.round(recentGhostDaily)}/day vs ${Math.round(avgGhosts)}/day (z=${z.toFixed(1)})`,
                timestamp: now,
            });
        }
    }

    // ── 6. Low active time anomaly ─────────────────────────────────────────
    // Uses daily_summaries rather than event counts so it reflects real minutes.
    const sinceDate = new Date(since).toISOString().split("T")[0];
    const nowDate   = new Date(now).toISOString().split("T")[0];
    const activeRow = db.prepare(
        `SELECT SUM(online_minutes + idle_minutes + dnd_minutes) AS total_minutes,
                COUNT(*) AS day_count
         FROM daily_summaries
         WHERE target_id = ? AND date >= ? AND date < ?`
    ).get(targetId, sinceDate, nowDate) as { total_minutes: number | null; day_count: number };

    const recentDailyMins = activeRow?.day_count
        ? (activeRow.total_minutes || 0) / activeRow.day_count
        : 0;

    if (isAnomaly(targetId, "daily_active_minutes", recentDailyMins)) {
        const z = computeZScore(targetId, "daily_active_minutes", recentDailyMins);
        if (z < -2) {
            anomalies.push({
                type: "LOW_ACTIVE_TIME",
                severity: "medium",
                description: `Active time unusually low: ~${Math.round(recentDailyMins)}min/day (z=${z.toFixed(1)}) — target may have gone quiet`,
                timestamp: now,
            });
        }
    }

    anomalies.sort((a, b) => b.timestamp - a.timestamp);
    return anomalies;
}
