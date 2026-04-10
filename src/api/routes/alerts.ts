import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { reloadRules } from "../../alerts/engine";

export function registerAlertRoutes(app: FastifyInstance): void {
    app.get("/api/alerts/rules", async () => {
        const stmts = getStmts();
        return stmts.getAllAlertRules.all();
    });

    app.post<{ Body: { targetId?: string; ruleType: string; condition?: any } }>("/api/alerts/rules", async (req) => {
        const { targetId, ruleType, condition } = req.body;
        const stmts = getStmts();
        const result = stmts.insertAlertRule.run(
            targetId || null, ruleType,
            JSON.stringify(condition || {}), 1, Date.now()
        );
        reloadRules();
        return { success: true, id: Number(result.lastInsertRowid) };
    });

    app.delete<{ Params: { id: string } }>("/api/alerts/rules/:id", async (req) => {
        const stmts = getStmts();
        stmts.deleteAlertRule.run(parseInt(req.params.id));
        reloadRules();
        return { success: true };
    });

    app.get<{ Querystring: { targetId?: string; since?: string; acknowledged?: string; limit?: string; offset?: string } }>("/api/alerts/history", async (req) => {
        const stmts = getStmts();
        const { targetId, limit, offset } = req.query;
        if (targetId) {
            return stmts.getAlertHistoryByTarget.all(targetId, parseInt(limit || "50"));
        }
        return stmts.getAlertHistory.all(parseInt(limit || "50"), parseInt(offset || "0"));
    });

    app.patch<{ Params: { id: string } }>("/api/alerts/history/:id/ack", async (req) => {
        const stmts = getStmts();
        stmts.acknowledgeAlert.run(parseInt(req.params.id));
        return { success: true };
    });
}
