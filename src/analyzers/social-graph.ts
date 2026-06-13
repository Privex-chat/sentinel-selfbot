import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { getDb } from "../database/connection";
import { getTargetConfig } from "./baseline";

const log = createLogger("SocialGraph");

// ── Result cache ─────────────────────────────────────────────────────────────
//
// buildSocialGraph runs three multi-thousand-row scans (messages, reactions,
// voice). It's hit synchronously by the analytics API, the relationships API,
// AND the AI social-graph analyzer. Three back-to-back invocations with the
// same args are common from the dashboard. Cache for a short window so the
// rebuild isn't paid per-request.
const CACHE_TTL_MS = 5 * 60_000;
const graphCache: Map<string, { computedAt: number; data: SocialGraphData }> = new Map();

function cacheKey(targetId: string, days: number): string {
    return `${targetId}:${days}`;
}

/** Drop every cached graph for this target (used when target data changes meaningfully). */
export function invalidateSocialGraphCache(targetId?: string): void {
    if (!targetId) { graphCache.clear(); return; }
    const prefix = `${targetId}:`;
    for (const key of graphCache.keys()) {
        if (key.startsWith(prefix)) graphCache.delete(key);
    }
}

export interface SocialConnection {
    userId: string;
    score: number;
    messageInteractions: number;
    reactionInteractions: number;
    voiceTime: number;
    mentionCount: number;
    relationship: string;
}

export interface SocialGraphData {
    connections: SocialConnection[];
    totalInteractions: number;
}

export function buildSocialGraph(targetId: string, days: number = 30): SocialGraphData {
    // Serve from cache when warm. The cache is 5 minutes so dashboard
    // hits land on the cached result; AI analysis (single run per 24h)
    // pays the full cost on first invocation.
    const ck = cacheKey(targetId, days);
    const cached = graphCache.get(ck);
    if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
        return cached.data;
    }

    const stmts = getStmts();
    const cfg = getTargetConfig(targetId);
    const since = Date.now() - days * 86400000;
    const scores: Map<string, { messages: number; reactions: number; voice: number; mentions: number }> = new Map();

    function getOrCreate(userId: string) {
        if (!scores.has(userId)) {
            scores.set(userId, { messages: 0, reactions: 0, voice: 0, mentions: 0 });
        }
        return scores.get(userId)!;
    }

    // Reply interactions + mention extraction
    const db = getDb();
    const MENTION_RE = /<@!?(\d{17,20})>/g;
    const messages = db.prepare(
        "SELECT * FROM messages WHERE target_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 5000"
    ).all(targetId, since) as any[];
    for (const msg of messages) {
        if (msg.is_reply && msg.reply_to_user_id && msg.reply_to_user_id !== targetId) {
            getOrCreate(msg.reply_to_user_id).messages++;
        }
        if (msg.content) {
            let match;
            MENTION_RE.lastIndex = 0;
            while ((match = MENTION_RE.exec(msg.content)) !== null) {
                const mentionedId = match[1];
                if (mentionedId !== targetId) {
                    getOrCreate(mentionedId).mentions++;
                }
            }
        }
    }

    // Reaction interactions
    const reactions = db.prepare(
        "SELECT * FROM reactions WHERE target_id = ? AND added_at >= ? ORDER BY added_at DESC LIMIT 5000"
    ).all(targetId, since) as any[];
    for (const r of reactions) {
        if (r.message_author_id && r.message_author_id !== targetId) {
            getOrCreate(r.message_author_id).reactions++;
        }
    }

    // Voice co-presence
    const nowMs = Date.now();
    const voiceSessions = stmts.getVoiceSessions.all(targetId, since, 1000) as any[];
    for (const session of voiceSessions) {
        if (!session.co_participants) continue;
        try {
            const participants: string[] = JSON.parse(session.co_participants);
            const duration = session.duration_ms ?? (nowMs - session.start_time);
            for (const p of participants) {
                if (p !== targetId) {
                    getOrCreate(p).voice += duration;
                }
            }
        } catch { }
    }

    // Build connections with config-driven weights
    const connections: SocialConnection[] = [];
    for (const [userId, data] of scores) {
        const score =
            data.messages * cfg.social_weight_messages +
            data.reactions * cfg.social_weight_reactions +
            (data.voice / 3600000) * cfg.social_weight_voice_hours +
            data.mentions * cfg.social_weight_mentions;
        if (score <= 0) continue;

        connections.push({
            userId,
            score: Math.round(score * 100) / 100,
            messageInteractions: data.messages,
            reactionInteractions: data.reactions,
            voiceTime: data.voice,
            mentionCount: data.mentions,
            relationship: "", // filled below after sorting
        });
    }

    connections.sort((a, b) => b.score - a.score);

    // Classify by percentile rank within this target's network
    const n = connections.length;
    for (let i = 0; i < n; i++) {
        const percentile = n > 1 ? (n - 1 - i) / (n - 1) : 1;
        const c = connections[i];

        if (percentile >= 0.90 || (c.voiceTime > 3600000 && c.messageInteractions > 5)) {
            c.relationship = "close friend";
        } else if (percentile >= 0.70 || c.voiceTime > 7200000) {
            c.relationship = "frequent partner";
        } else if (percentile >= 0.50 || c.messageInteractions > 10) {
            c.relationship = "regular contact";
        } else if (c.reactionInteractions > 5) {
            c.relationship = "reactor";
        } else {
            c.relationship = "acquaintance";
        }
    }

    const result: SocialGraphData = {
        connections: connections.slice(0, 50),
        totalInteractions: connections.reduce((sum, c) => sum + c.messageInteractions + c.reactionInteractions, 0),
    };
    graphCache.set(ck, { computedAt: Date.now(), data: result });
    return result;
}
