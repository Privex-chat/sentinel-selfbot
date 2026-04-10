import { FastifyInstance } from "fastify";
import { getDb } from "../../database/connection";

export function registerTimelineRoutes(app: FastifyInstance): void {
    app.get<{ Params: { userId: string }; Querystring: { limit?: string; offset?: string; type?: string } }>("/api/targets/:userId/timeline", async (req) => {
        const db = getDb();
        const { userId } = req.params;
        const limit = parseInt(req.query.limit || "100");
        const offset = parseInt(req.query.offset || "0");
        const type = req.query.type;

        let sql = "SELECT * FROM events WHERE target_id = ?";
        const params: any[] = [userId];

        if (type) { sql += " AND event_type = ?"; params.push(type); }
        sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const events = db.prepare(sql).all(...params);

        // Also get presence, activity, and voice sessions for the gantt view
        const recentPresence = db.prepare(
            "SELECT * FROM presence_sessions WHERE target_id = ? ORDER BY start_time DESC LIMIT 100"
        ).all(userId);

        const recentActivity = db.prepare(
            "SELECT * FROM activity_sessions WHERE target_id = ? ORDER BY start_time DESC LIMIT 100"
        ).all(userId);

        const recentVoice = db.prepare(
            "SELECT * FROM voice_sessions WHERE target_id = ? ORDER BY start_time DESC LIMIT 50"
        ).all(userId);

        return { events, presenceSessions: recentPresence, activitySessions: recentActivity, voiceSessions: recentVoice };
    });

    app.get<{ Params: { userId: string; date: string } }>("/api/targets/:userId/timeline/day/:date", async (req) => {
        const db = getDb();
        const { userId, date } = req.params;

        // Parse date to get start/end timestamps
        const dayStart = new Date(date + "T00:00:00").getTime();
        const dayEnd = dayStart + 86400000;

        const events = db.prepare(
            "SELECT * FROM events WHERE target_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC"
        ).all(userId, dayStart, dayEnd);

        const presence = db.prepare(
            "SELECT * FROM presence_sessions WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL) ORDER BY start_time ASC"
        ).all(userId, dayEnd, dayStart);

        const activities = db.prepare(
            "SELECT * FROM activity_sessions WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL) ORDER BY start_time ASC"
        ).all(userId, dayEnd, dayStart);

        const voice = db.prepare(
            "SELECT * FROM voice_sessions WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL) ORDER BY start_time ASC"
        ).all(userId, dayEnd, dayStart);

        return { date, events, presenceSessions: presence, activitySessions: activities, voiceSessions: voice };
    });
}
