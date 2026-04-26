import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { ai } from "../ai/provider";
import { messageCategoryPrompt } from "../ai/prompts";
import { extractJsonArray } from "../ai/json-extract";
import { config } from "../utils/config";

const log = createLogger("Categorizer");

const VALID_CATEGORIES = new Set([
    "gaming", "music", "emotional", "humor", "planning", "question", "general",
]);

const SYSTEM_PROMPT =
    "You are a message classification system. Classify each message into exactly one category. " +
    "Respond with a JSON array only. No markdown, no explanation.";

// ── Batch categorization ──────────────────────────────────────────────────────

export async function categorizeUncategorizedBatch(targetId: string): Promise<number> {
    if (!ai.isAvailable()) return 0;

    const stmts = getStmts();
    const rows = stmts.getUncategorizedMessages.all(
        targetId,
        config.aiCategorizationBatchSize
    ) as { message_id: string; content: string }[];

    if (!rows.length) return 0;

    const messages = rows.map(r => ({ id: r.message_id, content: r.content || "" }));

    let results: { id: string; category: string; confidence: number }[] = [];

    try {
        const prompt = messageCategoryPrompt(messages);
        const raw = await ai.complete(SYSTEM_PROMPT, prompt, 1024);
        const parsed = extractJsonArray(raw);
        results = parsed as { id: string; category: string; confidence: number }[];
    } catch (err: any) {
        log.warn(`Categorization parse error for ${targetId}: ${err.message}`);
        // Fallback: mark all as "general"
        results = messages.map(m => ({ id: m.id, category: "general", confidence: 0.0 }));
    }

    const now = Date.now();
    let inserted = 0;

    for (const r of results) {
        const category = VALID_CATEGORIES.has(r.category) ? r.category : "general";
        const confidence = typeof r.confidence === "number"
            ? Math.max(0, Math.min(1, r.confidence))
            : 1.0;

        // Find target_id for this message
        const msgRow = rows.find(m => m.message_id === r.id);
        if (!msgRow) continue;

        try {
            stmts.insertMessageCategory.run(r.id, targetId, category, confidence, now);
            inserted++;
        } catch (err: any) {
            log.debug(`Category insert error for ${r.id}: ${err.message}`);
        }
    }

    log.debug(`Categorized ${inserted} messages for ${targetId}`);
    return inserted;
}

// ── Per-target job ────────────────────────────────────────────────────────────

export async function runCategorizationForTarget(targetId: string): Promise<void> {
    if (config.aiProvider === "none") return;

    let total = 0;
    while (true) {
        const count = await categorizeUncategorizedBatch(targetId);
        total += count;
        if (count === 0) break;
    }

    if (total > 0) {
        log.info(`Categorization complete for ${targetId}: ${total} messages`);
    }
}

// ── All-targets job ───────────────────────────────────────────────────────────

export async function runAllCategorization(): Promise<void> {
    if (config.aiProvider === "none") return;

    const stmts = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    log.info(`Running message categorization for ${targets.length} targets`);

    for (const target of targets) {
        try {
            await runCategorizationForTarget(target.user_id);
        } catch (err: any) {
            log.error(`Categorization error for ${target.user_id}: ${err.message}`);
        }
    }

    log.info("Message categorization complete");
}
