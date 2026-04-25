import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { config } from "../../utils/config";
import { startBackfillForTarget } from "../../backfill/backfill-engine";

export function registerTargetRoutes(app: FastifyInstance): void {
    app.get("/api/targets", async () => {
        const stmts = getStmts();
        return stmts.getAllTargets.all();
    });

    app.post<{ Body: { userId: string; label?: string; notes?: string; priority?: number } }>("/api/targets", async (req, reply) => {
        const { userId, label, notes, priority } = req.body;
        if (!userId || !/^\d{17,20}$/.test(userId)) {
            return reply.code(400).send({ error: "Invalid userId" });
        }
        const stmts = getStmts();
        stmts.insertTarget.run(userId, Date.now(), label || null, notes || null, priority ?? 0, 1);

        if (config.backfillEnabled) {
            // Fire-and-forget — don't block the response
            startBackfillForTarget(userId).catch(() => { });
        }

        return { success: true, userId };
    });

    app.delete<{ Params: { userId: string } }>("/api/targets/:userId", async (req) => {
        const stmts = getStmts();
        stmts.deleteTarget.run(req.params.userId);
        return { success: true };
    });

    app.patch<{ Params: { userId: string }; Body: { label?: string; notes?: string; priority?: number; active?: boolean } }>("/api/targets/:userId", async (req) => {
        const { label, notes, priority, active } = req.body;
        const stmts = getStmts();
        stmts.updateTarget.run(
            label ?? null, notes ?? null, priority ?? null,
            active !== undefined ? (active ? 1 : 0) : null,
            req.params.userId
        );
        return { success: true };
    });
}
