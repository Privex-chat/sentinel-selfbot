import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { reloadRules } from "../../alerts/engine";
import { ALERT_TYPES } from "../../alerts/conditions";
import { config } from "../../utils/config";

const VALID_RULE_TYPES = new Set<string>(Object.values(ALERT_TYPES));

export function registerAlertRoutes(app: FastifyInstance): void {

    app.get("/api/alerts/rules", async () => {
        const stmts = getStmts();
        return stmts.getAllAlertRules.all();
    });

    app.post<{
        Body: {
            targetId?: string;
            ruleType: string;
            condition?: any;
            digestMode?: boolean;
            fatigueThreshold?: number;
            compositeCondition?: any;
        };
    }>("/api/alerts/rules", async (req, reply) => {
        const { targetId, ruleType, condition, digestMode, fatigueThreshold, compositeCondition } = req.body;

        // Validate ruleType against the canonical enum so unknown values (typos,
        // deleted rule types) don't get inserted as dead rules that never fire.
        if (typeof ruleType !== "string" || !VALID_RULE_TYPES.has(ruleType)) {
            return reply.code(400).send({
                error: `Invalid ruleType. Must be one of: ${[...VALID_RULE_TYPES].join(", ")}`,
            });
        }

        // Validate composite shape if provided. The hot path assumes
        // composite_condition is either null or has an array of sub-rules with
        // valid rule_type fields; rejecting bad input here keeps reloadRules'
        // parse step from silently dropping the rule.
        if (compositeCondition !== undefined && compositeCondition !== null) {
            if (typeof compositeCondition !== "object" || Array.isArray(compositeCondition)) {
                return reply.code(400).send({ error: "compositeCondition must be an object" });
            }
            if (!Array.isArray(compositeCondition.conditions) || compositeCondition.conditions.length === 0) {
                return reply.code(400).send({ error: "compositeCondition.conditions must be a non-empty array" });
            }
            for (const sub of compositeCondition.conditions) {
                if (!sub || typeof sub !== "object" || typeof sub.rule_type !== "string") {
                    return reply.code(400).send({ error: "Every composite sub-condition needs a string rule_type" });
                }
                if (!VALID_RULE_TYPES.has(sub.rule_type)) {
                    return reply.code(400).send({ error: `Invalid composite sub rule_type: ${sub.rule_type}` });
                }
            }
            if (compositeCondition.window_ms !== undefined && typeof compositeCondition.window_ms !== "number") {
                return reply.code(400).send({ error: "compositeCondition.window_ms must be a number when provided" });
            }
        }

        if (fatigueThreshold !== undefined && (typeof fatigueThreshold !== "number" || fatigueThreshold < 1)) {
            return reply.code(400).send({ error: "fatigueThreshold must be a positive integer" });
        }

        const stmts = getStmts();
        const result = stmts.insertAlertRule.run(
            targetId || null,
            ruleType,
            JSON.stringify(condition || {}),
            1,
            Date.now(),
            digestMode ? 1 : 0,
            fatigueThreshold ?? 20,
            compositeCondition ? JSON.stringify(compositeCondition) : null
        );

        reloadRules();
        return { success: true, id: Number(result.lastInsertRowid) };
    });

    app.delete<{ Params: { id: string } }>("/api/alerts/rules/:id", async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return reply.code(400).send({ error: "Invalid rule id" });
        const stmts = getStmts();
        stmts.deleteAlertRule.run(id);
        reloadRules();
        return { success: true };
    });

    app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>(
        "/api/alerts/rules/:id",
        async (req, reply) => {
            const id = parseInt(req.params.id, 10);
            if (isNaN(id)) return reply.code(400).send({ error: "Invalid rule id" });
            const stmts = getStmts();
            if (req.body.enabled !== undefined) {
                stmts.toggleAlertRule.run(req.body.enabled ? 1 : 0, id);
                reloadRules();
            }
            return { success: true };
        }
    );

    app.get<{
        Querystring: {
            targetId?: string;
            since?: string;
            acknowledged?: string;
            limit?: string;
            offset?: string;
        };
    }>("/api/alerts/history", async (req) => {
        const stmts = getStmts();
        const { targetId, limit, offset } = req.query;
        const limitVal  = Math.min(Math.max(1, parseInt(limit  || "50")  || 50),  500);
        const offsetVal = Math.max(0, parseInt(offset || "0") || 0);
        if (targetId) {
            return stmts.getAlertHistoryByTarget.all(targetId, limitVal);
        }
        return stmts.getAlertHistory.all(limitVal, offsetVal);
    });

    app.patch<{ Params: { id: string } }>("/api/alerts/history/:id/ack", async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return reply.code(400).send({ error: "Invalid alert id" });
        const stmts = getStmts();
        stmts.acknowledgeAlert.run(id);
        return { success: true };
    });

    // ── Fatigue / suppression ──────────────────────────────────────────────────

    app.get("/api/alerts/rules/suppressed", async () => {
        const stmts = getStmts();
        return stmts.getSuppressedRules.all();
    });

    app.post<{ Params: { id: string } }>("/api/alerts/rules/:id/unsuppress", async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return reply.code(400).send({ error: "Invalid rule id" });
        const stmts = getStmts();
        stmts.unsuppressAlertRule.run(id);
        reloadRules();
        return { success: true };
    });

    // ── Webhook test ──────────────────────────────────────────────────────────
    // POST /api/alerts/test  — sends a test payload to ALERT_WEBHOOK_URL.
    // Use this to verify the URL is reachable before waiting for a real event.
    app.post("/api/alerts/test", async (_req, reply) => {
        if (!config.alertWebhookUrl) {
            return reply.code(400).send({
                success: false,
                error: "ALERT_WEBHOOK_URL is not set in environment variables",
            });
        }

        const isDiscord =
            /https?:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//i.test(
                config.alertWebhookUrl
            );

        const body = isDiscord
            ? JSON.stringify({ content: "**[SENTINEL TEST]** Webhook delivery test — alert system is working.", username: "Sentinel" })
            : JSON.stringify({ event: "test", message: "Webhook delivery test — alert system is working.", timestamp: Date.now() });

        try {
            const res = await fetch(config.alertWebhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            });

            const text = await res.text().catch(() => "");
            if (!res.ok) {
                return reply.code(502).send({
                    success: false,
                    error: `Webhook returned HTTP ${res.status}`,
                    body: text.slice(0, 500),
                    webhookType: isDiscord ? "discord" : "generic",
                });
            }

            return {
                success: true,
                webhookType: isDiscord ? "discord" : "generic",
                httpStatus: res.status,
            };
        } catch (err: any) {
            return reply.code(502).send({
                success: false,
                error: err.message,
                webhookType: isDiscord ? "discord" : "generic",
            });
        }
    });
}
