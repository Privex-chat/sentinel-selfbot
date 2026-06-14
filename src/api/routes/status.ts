import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { getDb } from "../../database/connection";
import { getCurrentPresence } from "../../collectors/presence";
import { getCurrentActivities } from "../../collectors/activity";
import { getCurrentVoiceState } from "../../collectors/voice";
import { generateBriefForTarget } from "../../briefs/brief-generator";
import { escapeLikePattern } from "../../utils/like-escape";
import { isBootstrapping } from "../../target-lifecycle";

const startTime = Date.now();

export function registerStatusRoutes(app: FastifyInstance): void {
    app.get("/api/status", async () => {
        const stmts = getStmts();
        const eventCount = (stmts.getEventCount.get() as any).count;
        const targets = stmts.getAllTargets.all() as any[];
        const dbSize = (stmts.getDbSize.get() as any)?.size || 0;

        return {
            uptime: Date.now() - startTime,
            uptimeFormatted: formatUptime(Date.now() - startTime),
            eventCount,
            targetCount: targets.length,
            activeTargets: targets.filter((t: any) => t.active).length,
            dbSizeBytes: dbSize,
            dbSizeMB: Math.round(dbSize / 1024 / 1024 * 100) / 100,
            startedAt: startTime,
        };
    });

    app.get<{ Params: { userId: string } }>("/api/targets/:userId/status", async (req) => {
        const { userId } = req.params;
        const presence = getCurrentPresence(userId);
        const activities = getCurrentActivities(userId);
        const voiceState = getCurrentVoiceState(userId);
        const stmts = getStmts();
        const target = stmts.getTarget.get(userId);
        const latestSnapshot = stmts.getLatestSnapshot.get(userId);

        return {
            target,
            presence: presence || null,
            activities,
            voiceState: voiceState || null,
            profile: latestSnapshot || null,
            // Derived from the in-memory bootstrap cache (mirrors
            // targets.bootstrap_completed_at). True while alerts and anomaly
            // surfacing for this target are suppressed during onboarding.
            isBootstrapping: isBootstrapping(userId),
        };
    });

    // Messages routes
    app.get<{ Params: { userId: string }; Querystring: { channelId?: string; guildId?: string; since?: string; until?: string; limit?: string; offset?: string; search?: string; source?: string; category?: string } }>("/api/targets/:userId/messages", async (req) => {
        const db = getDb();
        const { userId } = req.params;
        const { search, limit: limitStr, offset: offsetStr, channelId, guildId, since, until, source, category } = req.query;
        const limit  = Math.min(Math.max(1, parseInt(limitStr  || "100") || 100), 500);
        const offset = Math.max(0, parseInt(offsetStr || "0") || 0);

        if (search) {
            // Escape `%`/`_` so client input is a literal substring. Otherwise
            // a single `%` triggers a full scan of the messages content column.
            const safeSearch = escapeLikePattern(search);
            let sql = "SELECT * FROM messages WHERE target_id = ? AND content LIKE ? ESCAPE '\\'";
            const params: any[] = [userId, `%${safeSearch}%`];
            if (channelId) { sql += " AND channel_id = ?"; params.push(channelId); }
            if (guildId)   { sql += " AND guild_id = ?";   params.push(guildId); }
            if (since) {
                const sinceVal = parseInt(since);
                if (!isNaN(sinceVal)) { sql += " AND created_at >= ?"; params.push(sinceVal); }
            }
            if (until) {
                const untilVal = parseInt(until);
                if (!isNaN(untilVal)) { sql += " AND created_at <= ?"; params.push(untilVal); }
            }
            if (source)    { sql += " AND source = ?"; params.push(source); }
            sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
            params.push(limit, offset);
            return db.prepare(sql).all(...params);
        }

        if (category) {
            let sql = `SELECT m.* FROM messages m
                       INNER JOIN message_categories mc ON mc.message_id = m.message_id
                       WHERE m.target_id = ? AND mc.category = ?`;
            const params: any[] = [userId, category];
            if (channelId) { sql += " AND m.channel_id = ?";   params.push(channelId); }
            if (guildId)   { sql += " AND m.guild_id = ?";     params.push(guildId); }
            if (since) {
                const sinceVal = parseInt(since);
                if (!isNaN(sinceVal)) { sql += " AND m.created_at >= ?"; params.push(sinceVal); }
            }
            if (until) {
                const untilVal = parseInt(until);
                if (!isNaN(untilVal)) { sql += " AND m.created_at <= ?"; params.push(untilVal); }
            }
            if (source)    { sql += " AND m.source = ?";       params.push(source); }
            sql += " ORDER BY m.created_at DESC LIMIT ? OFFSET ?";
            params.push(limit, offset);
            return db.prepare(sql).all(...params);
        }

        let sql = "SELECT * FROM messages WHERE target_id = ?";
        const params: any[] = [userId];
        if (channelId) { sql += " AND channel_id = ?"; params.push(channelId); }
        if (guildId)   { sql += " AND guild_id = ?";   params.push(guildId); }
        if (since) {
            const sinceVal = parseInt(since);
            if (!isNaN(sinceVal)) { sql += " AND created_at >= ?"; params.push(sinceVal); }
        }
        if (until) {
            const untilVal = parseInt(until);
            if (!isNaN(untilVal)) { sql += " AND created_at <= ?"; params.push(untilVal); }
        }
        if (source)    { sql += " AND source = ?";      params.push(source); }
        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);
        return db.prepare(sql).all(...params);
    });

    app.get<{ Params: { userId: string }; Querystring: { limit?: string; offset?: string } }>("/api/targets/:userId/messages/deleted", async (req) => {
        const stmts = getStmts();
        const limit  = Math.min(Math.max(1, parseInt(req.query.limit  || "100") || 100), 500);
        const offset = Math.max(0, parseInt(req.query.offset || "0") || 0);
        return stmts.getDeletedMessages.all(req.params.userId, limit, offset);
    });

    app.get<{ Params: { userId: string }; Querystring: { limit?: string; offset?: string } }>("/api/targets/:userId/messages/edited", async (req) => {
        const stmts = getStmts();
        const limit  = Math.min(Math.max(1, parseInt(req.query.limit  || "100") || 100), 500);
        const offset = Math.max(0, parseInt(req.query.offset || "0") || 0);
        return stmts.getEditedMessages.all(req.params.userId, limit, offset);
    });

    // Profile history
    app.get<{ Params: { userId: string }; Querystring: { limit?: string } }>("/api/targets/:userId/profile/history", async (req) => {
        const stmts = getStmts();
        const limit = Math.min(Math.max(1, parseInt(req.query.limit || "50") || 50), 200);
        return stmts.getSnapshotHistory.all(req.params.userId, limit);
    });

    app.get<{ Params: { userId: string } }>("/api/targets/:userId/profile/current", async (req) => {
        const stmts = getStmts();
        return stmts.getLatestSnapshot.get(req.params.userId) || null;
    });

    // ── Daily briefs ───────────────────────────────────────────────────────────

    app.get<{ Params: { userId: string }; Querystring: { limit?: string } }>(
        "/api/targets/:userId/briefs",
        async (req) => {
            const stmts = getStmts();
            const limit = Math.min(Math.max(1, parseInt(req.query.limit || "30") || 30), 365);
            return stmts.getDailyBriefs.all(req.params.userId, limit);
        }
    );

    app.get<{ Params: { userId: string; date: string } }>(
        "/api/targets/:userId/briefs/:date",
        async (req, reply) => {
            const stmts = getStmts();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
                return reply.code(400).send({ error: "Invalid date format — expected YYYY-MM-DD" });
            }
            const row = stmts.getDailyBriefByDate.get(req.params.userId, req.params.date);
            if (!row) return reply.code(404).send({ error: "Brief not found" });
            return row;
        }
    );

    app.post<{ Params: { userId: string }; Querystring: { date?: string } }>(
        "/api/targets/:userId/briefs/generate",
        async (req, reply) => {
            const { userId } = req.params;
            const dateStr = req.query.date || new Date().toISOString().split("T")[0];
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                return reply.code(400).send({ error: "Invalid date format — expected YYYY-MM-DD" });
            }
            const stmts = getStmts();
            const target = stmts.getTarget.get(userId) as any;
            if (!target) return reply.code(404).send({ error: "Target not found" });

            const briefText = await generateBriefForTarget(userId, dateStr);
            return { success: true, date: dateStr, brief_text: briefText };
        }
    );
}

function formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    return `${m}m ${s % 60}s`;
}
