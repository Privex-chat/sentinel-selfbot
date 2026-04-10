import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("SocialGraph");

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
    const stmts = getStmts();
    const since = Date.now() - days * 86400000;
    const scores: Map<string, { messages: number; reactions: number; voice: number; mentions: number }> = new Map();

    function getOrCreate(userId: string) {
        if (!scores.has(userId)) {
            scores.set(userId, { messages: 0, reactions: 0, voice: 0, mentions: 0 });
        }
        return scores.get(userId)!;
    }

    // Reply interactions + mention extraction
    const MENTION_RE = /<@!?(\d{17,20})>/g;
    const messages = stmts.getMessagesByTarget.all(targetId, 5000, 0) as any[];
    for (const msg of messages) {
        if (msg.created_at < since) continue;
        if (msg.is_reply && msg.reply_to_user_id && msg.reply_to_user_id !== targetId) {
            getOrCreate(msg.reply_to_user_id).messages++;
        }
        // Extract mentions from message content
        if (msg.content) {
            let match;
            while ((match = MENTION_RE.exec(msg.content)) !== null) {
                const mentionedId = match[1];
                if (mentionedId !== targetId) {
                    getOrCreate(mentionedId).mentions++;
                }
            }
        }
    }

    // Reaction interactions
    const reactions = stmts.getReactions.all(targetId, 5000) as any[];
    for (const r of reactions) {
        if (r.added_at < since) continue;
        if (r.message_author_id && r.message_author_id !== targetId) {
            getOrCreate(r.message_author_id).reactions++;
        }
    }

    // Voice co-presence
    const voiceSessions = stmts.getVoiceSessions.all(targetId, since, 1000) as any[];
    for (const session of voiceSessions) {
        if (!session.co_participants) continue;
        try {
            const participants: string[] = JSON.parse(session.co_participants);
            const duration = session.duration_ms || 0;
            for (const p of participants) {
                if (p !== targetId) {
                    getOrCreate(p).voice += duration;
                }
            }
        } catch { }
    }

    // Build connections
    const connections: SocialConnection[] = [];
    for (const [userId, data] of scores) {
        const score = data.messages * 3 + data.reactions * 1 + (data.voice / 3600000) * 5 + data.mentions * 2;
        if (score <= 0) continue;

        let relationship = "acquaintance";
        if (data.voice > 3600000 && data.messages > 5) relationship = "close friend (voice + messages)";
        else if (data.voice > 7200000) relationship = "voice buddy";
        else if (data.messages > 20) relationship = "frequent chat partner";
        else if (data.reactions > 10) relationship = "frequent reactor";

        connections.push({
            userId,
            score: Math.round(score * 100) / 100,
            messageInteractions: data.messages,
            reactionInteractions: data.reactions,
            voiceTime: data.voice,
            mentionCount: data.mentions,
            relationship,
        });
    }

    connections.sort((a, b) => b.score - a.score);

    return {
        connections: connections.slice(0, 50),
        totalInteractions: connections.reduce((sum, c) => sum + c.messageInteractions + c.reactionInteractions, 0),
    };
}
