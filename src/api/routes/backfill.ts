import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import {
    startBackfillForTarget,
    pauseBackfill,
    resumeBackfill,
} from "../../backfill/backfill-engine";

export function registerBackfillRoutes(app: FastifyInstance): void {

    app.get<{ Params: { userId: string } }>(
        "/api/targets/:userId/backfill/progress",
        async (req, reply) => {
            const { userId } = req.params;
            const stmts = getStmts();
            const target = stmts.getTarget.get(userId) as any;
            if (!target) return reply.code(404).send({ error: "Target not found" });

            const rows = stmts.getBackfillProgress.all(userId) as any[];
            const summary = {
                total: rows.length,
                pending: rows.filter(r => r.status === "pending").length,
                in_progress: rows.filter(r => r.status === "in_progress").length,
                completed: rows.filter(r => r.status === "completed").length,
                failed: rows.filter(r => r.status === "failed").length,
                skipped: rows.filter(r => r.status === "skipped").length,
                paused: rows.filter(r => r.status === "paused").length,
                totalMessagesFound: rows.reduce((s, r) => s + (r.messages_found || 0), 0),
            };

            return { summary, channels: rows };
        }
    );

    app.post<{ Params: { userId: string } }>(
        "/api/targets/:userId/backfill/start",
        async (req, reply) => {
            const { userId } = req.params;
            const stmts = getStmts();
            const target = stmts.getTarget.get(userId) as any;
            if (!target) return reply.code(404).send({ error: "Target not found" });

            resumeBackfill(userId);
            startBackfillForTarget(userId).catch(() => { });

            reply.code(202);
            return { accepted: true, message: "Backfill started" };
        }
    );

    app.post<{ Params: { userId: string } }>(
        "/api/targets/:userId/backfill/pause",
        async (req, reply) => {
            const { userId } = req.params;
            const stmts = getStmts();
            const target = stmts.getTarget.get(userId) as any;
            if (!target) return reply.code(404).send({ error: "Target not found" });

            pauseBackfill(userId);
            return { success: true, message: "Backfill paused" };
        }
    );
}
