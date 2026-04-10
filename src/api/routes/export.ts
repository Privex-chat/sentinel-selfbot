import { FastifyInstance } from "fastify";
import { getDb } from "../../database/connection";

export function registerExportRoutes(app: FastifyInstance): void {
    app.get<{ Params: { userId: string } }>("/api/export/:userId", async (req) => {
        const db = getDb();
        const { userId } = req.params;

        const events = db.prepare("SELECT * FROM events WHERE target_id = ? ORDER BY timestamp ASC").all(userId);
        const messages = db.prepare("SELECT * FROM messages WHERE target_id = ? ORDER BY created_at ASC").all(userId);
        const presenceSessions = db.prepare("SELECT * FROM presence_sessions WHERE target_id = ? ORDER BY start_time ASC").all(userId);
        const activitySessions = db.prepare("SELECT * FROM activity_sessions WHERE target_id = ? ORDER BY start_time ASC").all(userId);
        const voiceSessions = db.prepare("SELECT * FROM voice_sessions WHERE target_id = ? ORDER BY start_time ASC").all(userId);
        const profileSnapshots = db.prepare("SELECT * FROM profile_snapshots WHERE target_id = ? ORDER BY timestamp ASC").all(userId);
        const reactions = db.prepare("SELECT * FROM reactions WHERE target_id = ? ORDER BY added_at ASC").all(userId);
        const typingEvents = db.prepare("SELECT * FROM typing_events WHERE target_id = ? ORDER BY timestamp ASC").all(userId);
        const dailySummaries = db.prepare("SELECT * FROM daily_summaries WHERE target_id = ? ORDER BY date ASC").all(userId);

        return { userId, exportedAt: Date.now(), events, messages, presenceSessions, activitySessions, voiceSessions, profileSnapshots, reactions, typingEvents, dailySummaries };
    });

    app.get<{ Params: { userId: string } }>("/api/export/:userId/csv", async (req, reply) => {
        const db = getDb();
        const { userId } = req.params;

        const events = db.prepare("SELECT * FROM events WHERE target_id = ? ORDER BY timestamp ASC").all(userId) as any[];

        const escCsv = (val: string) => {
            if (!val) return '""';
            // Prevent CSV injection: prefix formula-triggering characters
            let safe = val;
            if (/^[=+\-@\t\r]/.test(safe)) safe = "'" + safe;
            return '"' + safe.replace(/"/g, '""') + '"';
        };

        let csv = "id,target_id,event_type,timestamp,data,guild_id,channel_id\n";
        for (const e of events) {
            csv += `${e.id},${escCsv(e.target_id)},${escCsv(e.event_type)},${e.timestamp},${escCsv(e.data || "")},${escCsv(e.guild_id || "")},${escCsv(e.channel_id || "")}\n`;
        }

        reply.header("Content-Type", "text/csv");
        reply.header("Content-Disposition", `attachment; filename=sentinel_${userId}_export.csv`);
        return csv;
    });
}
