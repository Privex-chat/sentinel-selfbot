import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { getDb } from "../../database/connection";
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
            startBackfillForTarget(userId).catch(() => { });
        }

        return { success: true, userId };
    });

    app.delete<{ Params: { userId: string } }>("/api/targets/:userId", async (req) => {
        const stmts = getStmts();
        stmts.deleteTarget.run(req.params.userId);
        return { success: true };
    });

    app.patch<{
        Params: { userId: string };
        Body: { label?: string | null; notes?: string | null; priority?: number; active?: boolean };
    }>("/api/targets/:userId", async (req, reply) => {
        const db = getDb();
        const body = req.body;
        const userId = req.params.userId;

        const setParts: string[] = [];
        const params: any[] = [];

        // Use explicit 'in' check so null values (clearing a field) are applied correctly,
        // unlike COALESCE which treats null as "keep existing".
        if ("label" in body) {
            setParts.push("label = ?");
            params.push(body.label ?? null);
        }
        if ("notes" in body) {
            setParts.push("notes = ?");
            params.push(body.notes ?? null);
        }
        if ("priority" in body && body.priority !== undefined) {
            setParts.push("priority = ?");
            params.push(body.priority);
        }
        if ("active" in body && body.active !== undefined) {
            setParts.push("active = ?");
            params.push(body.active ? 1 : 0);
        }

        if (setParts.length > 0) {
            params.push(userId);
            db.prepare(`UPDATE targets SET ${setParts.join(", ")} WHERE user_id = ?`).run(...params);
        }

        return { success: true };
    });
}