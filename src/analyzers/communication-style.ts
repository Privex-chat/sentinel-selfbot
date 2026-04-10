import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("CommStyle");

export interface CommunicationProfile {
    avgMessageLength: number;
    avgWordCount: number;
    vocabularyRichness: number;
    emojiRate: number;
    topEmoji: string[];
    editRate: number;
    deleteRate: number;
    ghostTypeRate: number;
    avgResponseTimeMs: number | null;
    messagesByHour: number[];
    linkShareRate: number;
    attachmentRate: number;
    replyRate: number;
    totalMessages: number;
}

export function analyzeCommunicationStyle(targetId: string, days: number = 30): CommunicationProfile {
    const stmts = getStmts();
    const since = Date.now() - days * 86400000;

    const messages = stmts.getMessagesByTarget.all(targetId, 10000, 0) as any[];
    const recentMessages = messages.filter((m: any) => m.created_at >= since);
    const total = recentMessages.length;

    if (total === 0) {
        return {
            avgMessageLength: 0, avgWordCount: 0, vocabularyRichness: 0,
            emojiRate: 0, topEmoji: [], editRate: 0, deleteRate: 0,
            ghostTypeRate: 0, avgResponseTimeMs: null,
            messagesByHour: new Array(24).fill(0), linkShareRate: 0,
            attachmentRate: 0, replyRate: 0, totalMessages: 0,
        };
    }

    let totalLength = 0;
    let totalWords = 0;
    let totalEmoji = 0;
    let editCount = 0;
    let deleteCount = 0;
    let replyCount = 0;
    let linkCount = 0;
    let attachmentCount = 0;
    const allWords: Set<string> = new Set();
    const byHour = new Array(24).fill(0);
    const emojiCounts: Map<string, number> = new Map();
    const responseTimes: number[] = [];

    const UNICODE_EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;
    const CUSTOM_EMOJI_RE = /<a?:(\w+):\d+>/g;

    for (const msg of recentMessages) {
        totalLength += msg.content_length || 0;
        totalWords += msg.word_count || 0;
        totalEmoji += msg.emoji_count || 0;
        linkCount += msg.link_count || 0;
        if (msg.edited_at) editCount++;
        if (msg.deleted_at) deleteCount++;
        if (msg.is_reply) replyCount++;
        if (msg.attachment_count > 0) attachmentCount++;

        const hour = new Date(msg.created_at).getHours();
        byHour[hour]++;

        if (msg.content) {
            const words = msg.content.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
            words.forEach((w: string) => allWords.add(w));

            // Extract emoji for top emoji tracking
            const unicodeMatches = msg.content.match(UNICODE_EMOJI_RE) || [];
            for (const e of unicodeMatches) {
                emojiCounts.set(e, (emojiCounts.get(e) || 0) + 1);
            }
            let customMatch;
            while ((customMatch = CUSTOM_EMOJI_RE.exec(msg.content)) !== null) {
                const name = `:${customMatch[1]}:`;
                emojiCounts.set(name, (emojiCounts.get(name) || 0) + 1);
            }
        }
    }

    // Compute average response time from typing events that resulted in messages
    const typingEvents = stmts.getTypingEvents.all(targetId, 1000) as any[];
    const recentTyping = typingEvents.filter((t: any) => t.timestamp >= since);
    const ghosts = recentTyping.filter((t: any) => !t.resulted_in_message);
    const ghostRate = recentTyping.length > 0 ? ghosts.length / recentTyping.length : 0;

    for (const t of recentTyping) {
        if (t.resulted_in_message && t.message_delay_ms > 0) {
            responseTimes.push(t.message_delay_ms);
        }
    }
    const avgResponseTimeMs = responseTimes.length > 0
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
        : null;

    // Top emoji by frequency
    const topEmoji = [...emojiCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([emoji]) => emoji);

    return {
        avgMessageLength: Math.round(totalLength / total),
        avgWordCount: Math.round(totalWords / total * 10) / 10,
        vocabularyRichness: totalWords > 0 ? Math.round(allWords.size / totalWords * 1000) / 1000 : 0,
        emojiRate: Math.round(totalEmoji / total * 100) / 100,
        topEmoji,
        editRate: Math.round(editCount / total * 1000) / 1000,
        deleteRate: Math.round(deleteCount / total * 1000) / 1000,
        ghostTypeRate: Math.round(ghostRate * 1000) / 1000,
        avgResponseTimeMs,
        messagesByHour: byHour,
        linkShareRate: Math.round(linkCount / total * 1000) / 1000,
        attachmentRate: Math.round(attachmentCount / total * 1000) / 1000,
        replyRate: Math.round(replyCount / total * 1000) / 1000,
        totalMessages: total,
    };
}
