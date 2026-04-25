import { FastifyInstance } from "fastify";
import { getDb } from "../../database/connection";

export function registerTimelineRoutes(app: FastifyInstance): void {

    // Timeline with extended filters
    app.get<{
        Params: { userId: string };
        Querystring: {
            limit?: string;
            offset?: string;
            type?: string;
            event_types?: string;
            since?: string;
            until?: string;
            search?: string;
        };
    }>("/api/targets/:userId/timeline", async (req) => {
        const db = getDb();
        const { userId } = req.params;
        const limit = parseInt(req.query.limit || "100");
        const offset = parseInt(req.query.offset || "0");
        const { type, event_types, since, until, search } = req.query;

        let sql = "SELECT * FROM events WHERE target_id = ?";
        const params: any[] = [userId];

        // Single type (legacy)
        if (type) { sql += " AND event_type = ?"; params.push(type); }

        // Multiple types (new)
        if (event_types && !type) {
            const types = event_types.split(",").map(t => t.trim()).filter(Boolean);
            if (types.length === 1) {
                sql += " AND event_type = ?"; params.push(types[0]);
            } else if (types.length > 1) {
                sql += ` AND event_type IN (${types.map(() => "?").join(",")})`;
                params.push(...types);
            }
        }

        if (since) { sql += " AND timestamp >= ?"; params.push(parseInt(since)); }
        if (until) { sql += " AND timestamp <= ?"; params.push(parseInt(until)); }

        if (search) {
            sql += " AND (data LIKE ? OR event_type LIKE ?)";
            params.push(`%${search}%`, `%${search}%`);
        }

        sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const events = db.prepare(sql).all(...params);

        const recentPresence = db.prepare(
            "SELECT * FROM presence_sessions WHERE target_id = ? ORDER BY start_time DESC LIMIT 100"
        ).all(userId);

        const recentActivity = db.prepare(
            "SELECT * FROM activity_sessions WHERE target_id = ? ORDER BY start_time DESC LIMIT 100"
        ).all(userId);

        const recentVoice = db.prepare(
            "SELECT * FROM voice_sessions WHERE target_id = ? ORDER BY start_time DESC LIMIT 50"
        ).all(userId);

        return {
            events,
            presenceSessions: recentPresence,
            activitySessions: recentActivity,
            voiceSessions: recentVoice,
        };
    });

    // Day view
    app.get<{ Params: { userId: string; date: string } }>(
        "/api/targets/:userId/timeline/day/:date",
        async (req) => {
            const db = getDb();
            const { userId, date } = req.params;

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
        }
    );

    // Date-range Gantt endpoint (max 30 days)
    app.get<{
        Params: { userId: string };
        Querystring: { from: string; to: string };
    }>("/api/targets/:userId/timeline/range", async (req, reply) => {
        const { userId } = req.params;
        const { from, to } = req.query;

        if (!from || !to) {
            return reply.code(400).send({ error: "from and to query params required (YYYY-MM-DD)" });
        }

        const fromTs = new Date(from + "T00:00:00").getTime();
        const toTs = new Date(to + "T23:59:59").getTime();
        const days = (toTs - fromTs) / 86_400_000;

        if (days > 30) {
            return reply.code(400).send({ error: "Range cannot exceed 30 days" });
        }

        const db = getDb();

        const presenceSessions = db.prepare(
            `SELECT * FROM presence_sessions
             WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL)
             ORDER BY start_time ASC`
        ).all(userId, toTs, fromTs);

        const activitySessions = db.prepare(
            `SELECT * FROM activity_sessions
             WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL)
             ORDER BY start_time ASC`
        ).all(userId, toTs, fromTs);

        const voiceSessions = db.prepare(
            `SELECT * FROM voice_sessions
             WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL)
             ORDER BY start_time ASC`
        ).all(userId, toTs, fromTs);

        const eventCount = (db.prepare(
            "SELECT COUNT(*) as count FROM events WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?"
        ).get(userId, fromTs, toTs) as any)?.count || 0;

        return {
            presenceSessions,
            activitySessions,
            voiceSessions,
            eventCount,
            dateRange: { from, to, days: Math.round(days) },
        };
    });
}
