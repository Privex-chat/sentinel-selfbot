import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { getDb } from "../../database/connection";
import { getCurrentPresence } from "../../collectors/presence";
import { getCurrentActivities } from "../../collectors/activity";
import { getCurrentVoiceState } from "../../collectors/voice";
import { generateBriefForTarget } from "../../briefs/brief-generator";

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

        return { target, presence: presence || null, activities, voiceState: voiceState || null, profile: latestSnapshot || null };
    });

    // Messages routes
    app.get<{ Params: { userId: string }; Querystring: { channelId?: string; since?: string; until?: string; limit?: string; offset?: string; search?: string } }>("/api/targets/:userId/messages", async (req) => {
        const stmts = getStmts();
        const { userId } = req.params;
        const { search, limit, offset } = req.query;

        if (search) {
            return stmts.searchMessages.all(userId, `%${search}%`, parseInt(limit || "100"));
        }
        return stmts.getMessagesByTarget.all(userId, parseInt(limit || "100"), parseInt(offset || "0"));
    });

    app.get<{ Params: { userId: string }; Querystring: { limit?: string; offset?: string } }>("/api/targets/:userId/messages/deleted", async (req) => {
        const stmts = getStmts();
        return stmts.getDeletedMessages.all(req.params.userId, parseInt(req.query.limit || "100"), parseInt(req.query.offset || "0"));
    });

    app.get<{ Params: { userId: string }; Querystring: { limit?: string; offset?: string } }>("/api/targets/:userId/messages/edited", async (req) => {
        const stmts = getStmts();
        return stmts.getEditedMessages.all(req.params.userId, parseInt(req.query.limit || "100"), parseInt(req.query.offset || "0"));
    });

    // Profile history
    app.get<{ Params: { userId: string }; Querystring: { limit?: string } }>("/api/targets/:userId/profile/history", async (req) => {
        const stmts = getStmts();
        return stmts.getSnapshotHistory.all(req.params.userId, parseInt(req.query.limit || "50"));
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
            const limit = parseInt(req.query.limit || "30");
            return stmts.getDailyBriefs.all(req.params.userId, limit);
        }
    );

    app.get<{ Params: { userId: string; date: string } }>(
        "/api/targets/:userId/briefs/:date",
        async (req, reply) => {
            const stmts = getStmts();
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
