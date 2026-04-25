import { createLogger } from "../utils/logger";
import { getDb } from "../database/connection";
import { getStmts } from "../database/queries";
import { ai } from "../ai/provider";
import { RelationshipFeatures, relationshipClassificationPrompt } from "../ai/prompts";
import { buildSocialGraph } from "./social-graph";
import { config } from "../utils/config";

export type { RelationshipFeatures };

const log = createLogger("SocialGraphAI");

const SYSTEM_PROMPT =
    "You are a behavioral intelligence analyst. You classify relationships between Discord users based " +
    "on structural interaction data only. You never guess at message content. Respond with valid JSON only.";

const CONVERSATION_GAP_MS = 30 * 60 * 1000; // 30 minutes

// ── Conversation boundary detection ──────────────────────────────────────────

interface Conversation {
    messages: any[];
    startTime: number;
    endTime: number;
    channelId: string;
}

function detectConversations(
    messages: any[],
    targetId: string,
    otherUserId: string
): Conversation[] {
    // Group messages by channel, find windows involving both users
    const byChannel = new Map<string, any[]>();
    for (const m of messages) {
        const arr = byChannel.get(m.channel_id) || [];
        arr.push(m);
        byChannel.set(m.channel_id, arr);
    }

    const conversations: Conversation[] = [];

    for (const [channelId, msgs] of byChannel) {
        // Filter messages that involve the target's interactions with otherUser
        const relevant = msgs.filter(
            m => m.target_id === targetId && m.reply_to_user_id === otherUserId
        );
        if (!relevant.length) continue;

        msgs.sort((a, b) => a.created_at - b.created_at);

        let current: any[] = [];
        let lastTime = 0;

        for (const msg of msgs) {
            if (msg.created_at - lastTime > CONVERSATION_GAP_MS && current.length > 0) {
                const hasInteraction = current.some(
                    m => m.reply_to_user_id === otherUserId
                );
                if (hasInteraction) {
                    conversations.push({
                        messages: current,
                        startTime: current[0].created_at,
                        endTime: current[current.length - 1].created_at,
                        channelId,
                    });
                }
                current = [];
            }
            current.push(msg);
            lastTime = msg.created_at;
        }

        if (current.length > 0 && current.some(m => m.reply_to_user_id === otherUserId)) {
            conversations.push({
                messages: current,
                startTime: current[0].created_at,
                endTime: current[current.length - 1].created_at,
                channelId,
            });
        }
    }

    return conversations;
}

// ── Confidence scoring ────────────────────────────────────────────────────────

function computeConfidence(dataWindowDays: number, totalInteractions: number): number {
    const ageFactor = Math.min(dataWindowDays / 30, 1.0);
    const volumeFactor = Math.min(totalInteractions / 50, 1.0);
    return Math.round((ageFactor * 0.5 + volumeFactor * 0.5) * 100) / 100;
}

// ── Feature computation ───────────────────────────────────────────────────────

function computeRelationshipFeatures(
    targetId: string,
    otherUserId: string,
    dataWindowDays: number
): RelationshipFeatures {
    const db = getDb();
    const since = Date.now() - dataWindowDays * 86_400_000;
    const MENTION_RE = /<@!?(\d{17,20})>/g;

    // Target messages to/about this user
    const messages = db.prepare(
        `SELECT * FROM messages WHERE target_id = ? AND created_at >= ? ORDER BY created_at ASC`
    ).all(targetId, since) as any[];

    // Filter to messages involving otherUser (replies + mentions)
    let messageCount = 0;
    let mentionCount = 0;
    let editCount = 0;
    let deleteCount = 0;
    let lateNightCount = 0;
    const channelSet = new Set<string>();

    for (const m of messages) {
        let involves = false;
        if (m.reply_to_user_id === otherUserId) {
            involves = true;
        }
        if (m.content) {
            MENTION_RE.lastIndex = 0;
            let match;
            while ((match = MENTION_RE.exec(m.content)) !== null) {
                if (match[1] === otherUserId) {
                    involves = true;
                    mentionCount++;
                }
            }
        }
        if (involves) {
            messageCount++;
            channelSet.add(m.channel_id);
            if (m.edited_at) editCount++;
            if (m.deleted_at) deleteCount++;
            const hour = new Date(m.created_at).getHours();
            if (hour >= 22 || hour < 5) lateNightCount++;
        }
    }

    const editRate = messageCount > 0 ? editCount / messageCount : 0;
    const deleteRate = messageCount > 0 ? deleteCount / messageCount : 0;
    const lateNightInteractionRate = messageCount > 0 ? lateNightCount / messageCount : 0;

    // Initiation ratio: messages to this user that are NOT replies
    // (target may be starting the topic)
    const replyCount = messages.filter(m => m.reply_to_user_id === otherUserId).length;
    const initiationRatioTarget = messageCount > 0
        ? Math.max(0, messageCount - replyCount) / messageCount
        : 0;

    // Conversation length
    const conversations = detectConversations(messages, targetId, otherUserId);
    const avgConversationLength = conversations.length > 0
        ? conversations.reduce((s, c) => s + c.messages.length, 0) / conversations.length
        : 0;

    // Voice co-presence
    const stmts = getStmts();
    const voiceSessions = stmts.getVoiceSessions.all(targetId, since, 1000) as any[];
    let voiceCoPresenceMs = 0;
    let voiceSessionCount = 0;
    for (const vs of voiceSessions) {
        if (!vs.co_participants) continue;
        try {
            const participants: string[] = JSON.parse(vs.co_participants);
            if (participants.includes(otherUserId)) {
                voiceCoPresenceMs += vs.duration_ms || 0;
                voiceSessionCount++;
            }
        } catch { }
    }

    // Reactions: target reacted to messages by otherUser
    const reactions = db.prepare(
        `SELECT COUNT(*) as count FROM reactions WHERE target_id = ? AND message_author_id = ? AND added_at >= ?`
    ).get(targetId, otherUserId, since) as any;
    const reactionCount = reactions?.count || 0;

    const totalInteractions = messageCount + reactionCount + voiceSessionCount;

    return {
        targetId,
        otherUserId,
        dataWindowDays,
        totalInteractions,
        messageCount,
        initiationRatioTarget,
        avgResponseLatencyMs: null, // can't compute without other user's messages
        avgConversationLength,
        lateNightInteractionRate,
        voiceCoPresenceMs,
        voiceSessionCount,
        editRate,
        deleteRate,
        reactionCount,
        mentionCount,
        channelDiversity: channelSet.size,
        privateChannelRatio: 0, // no channel member counts available
    };
}

// ── Per-target analysis ───────────────────────────────────────────────────────

async function analyzeAllRelationships(targetId: string): Promise<void> {
    const stmts = getStmts();
    const graph = buildSocialGraph(targetId, 30);
    const top50 = graph.connections.slice(0, 50).filter(c => c.score > 0);
    const dataWindowDays = 30;
    const now = Date.now();
    const windowStart = now - dataWindowDays * 86_400_000;

    log.info(`Analyzing ${top50.length} relationships for ${targetId}`);

    for (const connection of top50) {
        const otherUserId = connection.userId;
        try {
            const features = computeRelationshipFeatures(targetId, otherUserId, dataWindowDays);
            const confidence = computeConfidence(dataWindowDays, features.totalInteractions);

            // Get existing classification to detect changes
            const existing = stmts.getRelationshipPair.get(targetId, otherUserId) as any;

            let classification = "unknown";
            let reasoning: string[] = [];

            if (confidence >= 0.2 && ai.isAvailable()) {
                try {
                    const prompt = relationshipClassificationPrompt(features);
                    const raw = await ai.complete(SYSTEM_PROMPT, prompt, 256);
                    const result = JSON.parse(raw);
                    classification = result.classification || "unknown";
                    reasoning = Array.isArray(result.reasoning) ? result.reasoning : [];
                } catch (err: any) {
                    log.warn(`LLM classification failed for ${targetId}↔${otherUserId}: ${err.message}`);
                    classification = "unknown";
                }
            }

            // Track classification changes
            if (existing && existing.classification !== classification) {
                stmts.insertRelationshipHistory.run(
                    targetId, otherUserId,
                    existing.classification, existing.confidence,
                    now
                );
                log.debug(`${targetId}↔${otherUserId}: ${existing.classification} → ${classification}`);
            }

            stmts.upsertRelationshipAnalysis.run(
                targetId, otherUserId,
                classification, confidence,
                JSON.stringify(reasoning),
                now, windowStart, now
            );

            // 2-second delay between LLM calls
            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (err: any) {
            log.error(`Relationship analysis error ${targetId}↔${otherUserId}: ${err.message}`);
        }
    }
}

// ── Public exports ────────────────────────────────────────────────────────────

export async function runAISocialGraphAnalysis(): Promise<void> {
    const stmts = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    log.info(`Running AI social graph analysis for ${targets.length} targets`);

    for (const target of targets) {
        try {
            await analyzeAllRelationships(target.user_id);
        } catch (err: any) {
            log.error(`Social graph analysis failed for ${target.user_id}: ${err.message}`);
        }
    }

    log.info("AI social graph analysis complete");
}
