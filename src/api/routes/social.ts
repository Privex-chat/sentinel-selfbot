import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { buildSocialGraph } from "../../analyzers/social-graph";
import { runAISocialGraphAnalysis } from "../../analyzers/social-graph-ai";
import { createLogger } from "../../utils/logger";

const log = createLogger("SocialRoutes");

export function registerSocialRoutes(app: FastifyInstance): void {

    // GET all classified relationships for target (merges rule-based + AI)
    app.get<{ Params: { userId: string }; Querystring: { days?: string } }>(
        "/api/targets/:userId/social/relationships",
        async (req) => {
            const { userId } = req.params;
            const days = parseInt(req.query.days || "30");
            const stmts = getStmts();

            const graph = buildSocialGraph(userId, days);
            const aiResults = stmts.getRelationshipAnalysis.all(userId) as any[];
            const aiMap = new Map<string, any>();
            for (const r of aiResults) aiMap.set(r.other_user_id, r);

            const enriched = graph.connections.map(c => ({
                ...c,
                aiClassification: aiMap.get(c.userId)?.classification || null,
                aiConfidence: aiMap.get(c.userId)?.confidence || null,
                aiReasoning: (() => {
                    try { return JSON.parse(aiMap.get(c.userId)?.reasoning || "[]"); } catch { return []; }
                })(),
                analyzedAt: aiMap.get(c.userId)?.analyzed_at || null,
            }));

            return {
                connections: enriched,
                totalInteractions: graph.totalInteractions,
                aiAnalyzedCount: aiMap.size,
            };
        }
    );

    // GET specific pair deep-dive
    app.get<{ Params: { userId: string; otherId: string } }>(
        "/api/targets/:userId/social/relationships/:otherId",
        async (req) => {
            const { userId, otherId } = req.params;
            const stmts = getStmts();

            const analysis = stmts.getRelationshipPair.get(userId, otherId) as any;
            const history = stmts.getRelationshipHistory.all(userId, otherId, 20) as any[];

            if (analysis?.reasoning) {
                try { analysis.reasoning = JSON.parse(analysis.reasoning); } catch { analysis.reasoning = []; }
            }

            return { analysis: analysis || null, history };
        }
    );

    // POST trigger re-analysis for this target (async, returns 202)
    app.post<{ Params: { userId: string } }>(
        "/api/targets/:userId/social/analyze",
        async (req, reply) => {
            const { userId } = req.params;
            const stmts = getStmts();
            const target = stmts.getTarget.get(userId) as any;
            if (!target) return reply.code(404).send({ error: "Target not found" });

            // Fire-and-forget
            setImmediate(async () => {
                try {
                    const { runAISocialGraphAnalysis: _run } = await import("../../analyzers/social-graph-ai");
                    // Analyze just this target by temporarily narrowing scope
                    const { buildSocialGraph } = await import("../../analyzers/social-graph");
                    const { getStmts: gs } = await import("../../database/queries");
                    const { ai } = await import("../../ai/provider");
                    const { relationshipClassificationPrompt } = await import("../../ai/prompts");
                    log.info(`Triggered manual social graph analysis for ${userId}`);
                } catch (err: any) {
                    log.error(`Manual analysis error: ${err.message}`);
                }
            });

            // Simpler: just call the real function in background
            runAISocialGraphAnalysis().catch(err =>
                log.error(`Background analysis error: ${err.message}`)
            );

            reply.code(202);
            return { accepted: true, message: "Analysis started in background" };
        }
    );

    // GET relationship arc changes
    app.get<{ Params: { userId: string }; Querystring: { limit?: string } }>(
        "/api/targets/:userId/social/changes",
        async (req) => {
            const { userId } = req.params;
            const limit = parseInt(req.query.limit || "50");
            const stmts = getStmts();
            return stmts.getRelationshipChanges.all(userId, limit);
        }
    );
}
