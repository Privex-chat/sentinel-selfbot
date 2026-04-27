import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { getDb } from "../../database/connection";
import { analyzeSleepSchedule } from "../../analyzers/sleep-schedule";
import { detectRoutine } from "../../analyzers/routine-detector";
import { buildSocialGraph } from "../../analyzers/social-graph";
import { analyzeCommunicationStyle } from "../../analyzers/communication-style";
import { analyzeGamingProfile } from "../../analyzers/gaming-profile";
import { analyzeMusicProfile } from "../../analyzers/music-profile";
import { analyzeVoiceHabits } from "../../analyzers/voice-habits";
import { predictAvailability } from "../../analyzers/availability";
import { detectAnomalies } from "../../analyzers/anomaly-detector";

export function registerAnalyticsRoutes(app: FastifyInstance): void {

    // ── Presence ──────────────────────────────────────────────────────────────
    // NOTE: "total_active_ms" sums online + idle + dnd — all three statuses
    // mean the user is reachable.  Only "offline" means truly away.
    app.get<{
        Params: { userId: string };
        Querystring: { days?: string };
    }>("/api/targets/:userId/analytics/presence", async (req) => {
        const db      = getDb();
        const { userId } = req.params;
        const days    = parseInt(req.query.days || "30");
        const since   = Date.now() - days * 86_400_000;

        const now = Date.now();

        // COALESCE handles open sessions (duration_ms IS NULL): substitute elapsed time so far
        const sessions = db.prepare(
            `SELECT status,
                    SUM(COALESCE(duration_ms, ? - start_time)) AS total_ms,
                    COUNT(*)                                    AS count
             FROM   presence_sessions
             WHERE  target_id = ? AND start_time >= ?
             GROUP  BY status`
        ).all(now, userId, since) as any[];

        const platformBreakdown = db.prepare(
            `SELECT platform,
                    SUM(COALESCE(duration_ms, ? - start_time)) AS total_ms,
                    COUNT(*)                                    AS count
             FROM   presence_sessions
             WHERE  target_id = ? AND start_time >= ? AND platform IS NOT NULL
             GROUP  BY platform`
        ).all(now, userId, since) as any[];

        // Compute total active (online + idle + dnd) for convenience
        const totalActiveMs = sessions
            .filter(s => s.status !== "offline")
            .reduce((sum: number, s: any) => sum + (s.total_ms || 0), 0);

        return { sessions, platformBreakdown, totalActiveMs, days };
    });

    // ── Activities / gaming ────────────────────────────────────────────────────
    app.get<{
        Params: { userId: string };
        Querystring: { days?: string };
    }>("/api/targets/:userId/analytics/activities", async (req) => {
        const days = parseInt(req.query.days || "90");
        return analyzeGamingProfile(req.params.userId, days);
    });

    // ── Messages ───────────────────────────────────────────────────────────────
    app.get<{
        Params: { userId: string };
        Querystring: { days?: string };
    }>("/api/targets/:userId/analytics/messages", async (req) => {
        const days = parseInt(req.query.days || "30");
        return analyzeCommunicationStyle(req.params.userId, days);
    });

    // ── Voice ──────────────────────────────────────────────────────────────────
    app.get<{
        Params: { userId: string };
        Querystring: { days?: string };
    }>("/api/targets/:userId/analytics/voice", async (req) => {
        const days = parseInt(req.query.days || "30");
        return analyzeVoiceHabits(req.params.userId, days);
    });

    // ── Social graph ───────────────────────────────────────────────────────────
    app.get<{
        Params: { userId: string };
        Querystring: { days?: string };
    }>("/api/targets/:userId/analytics/social", async (req) => {
        const days = parseInt(req.query.days || "30");
        return buildSocialGraph(req.params.userId, days);
    });

    // ── Routine heatmap ────────────────────────────────────────────────────────
    app.get<{
        Params: { userId: string };
        Querystring: { weeks?: string };
    }>("/api/targets/:userId/analytics/heatmap", async (req) => {
        const weeks = parseInt(req.query.weeks || "4");
        return detectRoutine(req.params.userId, weeks);
    });

    // ── Daily summaries ────────────────────────────────────────────────────────
    // Each row includes `total_active_minutes` = online + idle + dnd.
    app.get<{
        Params: { userId: string };
        Querystring: { days?: string };
    }>("/api/targets/:userId/analytics/daily", async (req) => {
        const stmts   = getStmts();
        const { userId } = req.params;
        const days    = parseInt(req.query.days || "30");
        return stmts.getDailySummaries.all(userId, days);
    });

    // ── Music / Spotify ────────────────────────────────────────────────────────
    app.get<{
        Params: { userId: string };
        Querystring: { days?: string };
    }>("/api/targets/:userId/analytics/music", async (req) => {
        const days = parseInt(req.query.days || "30");
        return analyzeMusicProfile(req.params.userId, days);
    });

    // ── Message categories ─────────────────────────────────────────────────────
    app.get<{ Params: { userId: string } }>(
        "/api/targets/:userId/analytics/categories",
        async (req) => {
            const stmts = getStmts();
            return stmts.getCategoryBreakdown.all(req.params.userId);
        }
    );

    // ── Baselines ──────────────────────────────────────────────────────────────
    app.get<{ Params: { userId: string } }>(
        "/api/targets/:userId/analytics/baselines",
        async (req) => {
            const stmts = getStmts();
            return stmts.getAllBaselines.all(req.params.userId);
        }
    );

    app.post<{ Params: { userId: string } }>(
        "/api/targets/:userId/analytics/baselines/recompute",
        async (req, reply) => {
            const { userId } = req.params;
            const stmts = getStmts();
            const target = stmts.getTarget.get(userId) as any;
            if (!target) return reply.code(404).send({ error: "Target not found" });

            const { computeBaselinesForTarget } = await import("../../analyzers/baseline");
            computeBaselinesForTarget(userId);
            return { success: true };
        }
    );

    // ── Target config ──────────────────────────────────────────────────────────
    app.get<{ Params: { userId: string } }>(
        "/api/targets/:userId/config",
        async (req) => {
            const stmts = getStmts();
            const row = stmts.getTargetConfig.get(req.params.userId) as any;
            if (row) return row;
            // Return defaults
            return {
                target_id: req.params.userId,
                social_weight_messages: 3.0,
                social_weight_reactions: 1.0,
                social_weight_voice_hours: 5.0,
                social_weight_mentions: 2.0,
                anomaly_z_threshold: 2.0,
            };
        }
    );

    app.patch<{
        Params: { userId: string };
        Body: {
            social_weight_messages?: number;
            social_weight_reactions?: number;
            social_weight_voice_hours?: number;
            social_weight_mentions?: number;
            anomaly_z_threshold?: number;
        };
    }>(
        "/api/targets/:userId/config",
        async (req, reply) => {
            const { userId } = req.params;
            const stmts = getStmts();
            const target = stmts.getTarget.get(userId) as any;
            if (!target) return reply.code(404).send({ error: "Target not found" });

            const existing = (stmts.getTargetConfig.get(userId) as any) || {
                social_weight_messages: 3.0,
                social_weight_reactions: 1.0,
                social_weight_voice_hours: 5.0,
                social_weight_mentions: 2.0,
                anomaly_z_threshold: 2.0,
            };

            const body = req.body;
            stmts.upsertTargetConfig.run(
                userId,
                body.social_weight_messages ?? existing.social_weight_messages,
                body.social_weight_reactions ?? existing.social_weight_reactions,
                body.social_weight_voice_hours ?? existing.social_weight_voice_hours,
                body.social_weight_mentions ?? existing.social_weight_mentions,
                body.anomaly_z_threshold ?? existing.anomaly_z_threshold,
                Date.now()
            );
            return { success: true };
        }
    );

    // ── Typing / ghost-type stats ──────────────────────────────────────────────
    app.get<{
        Params: { userId: string };
    }>("/api/targets/:userId/analytics/typing", async (req) => {
        const stmts  = getStmts();
        const { userId } = req.params;
        const events = stmts.getTypingEvents.all(userId, 500) as any[];
        const total  = events.length;
        const ghosts = events.filter((e: any) => !e.resulted_in_message).length;
        const withDelay = events.filter((e: any) => e.message_delay_ms);
        const avgDelay  = withDelay.length > 0
            ? Math.round(withDelay.reduce((s: number, e: any) => s + e.message_delay_ms, 0) / withDelay.length)
            : 0;

        return {
            total,
            ghosts,
            ghostRate:  total > 0 ? ghosts / total : 0,
            avgDelayMs: avgDelay,
        };
    });
}