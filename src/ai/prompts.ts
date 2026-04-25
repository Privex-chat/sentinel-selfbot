// All LLM prompt templates. Never put templates inline in analyzer code.

export interface RelationshipFeatures {
    targetId: string;
    otherUserId: string;
    dataWindowDays: number;
    totalInteractions: number;
    // Message patterns
    messageCount: number;
    initiationRatioTarget: number;      // 0-1, how often target starts conversations
    avgResponseLatencyMs: number | null; // how quickly target replies to this user vs baseline
    avgConversationLength: number;       // avg messages per conversation thread
    lateNightInteractionRate: number;    // fraction of interactions between 22:00-05:00
    // Voice
    voiceCoPresenceMs: number;
    voiceSessionCount: number;
    // Sentiment proxy (no content — use structural signals)
    editRate: number;                    // target edits messages to this user more than average
    deleteRate: number;                  // target deletes messages to this user more than average
    reactionCount: number;               // reactions exchanged
    mentionCount: number;
    // Social context
    channelDiversity: number;            // how many different channels they interact in
    privateChannelRatio: number;         // fraction of voice sessions in small channels (<=5 members)
}

export interface BriefStats {
    targetId: string;
    label: string | null;
    date: string;
    onlineMinutes: number;
    idleMinutes: number;
    dndMinutes: number;
    messageCount: number;
    voiceMinutes: number;
    firstSeen: string | null;
    lastSeen: string | null;
    platformUsed: string | null;
    topActivities: { name: string; minutes: number }[];
    deletedMessages: number;
    ghostTypeEvents: number;
    voiceSessions: { channelId: string; durationMinutes: number; participantCount: number }[];
    profileChanged: boolean;
    anomalies: string[];
}

export function relationshipClassificationPrompt(features: RelationshipFeatures): string {
    const f = features;
    const voiceHours = (f.voiceCoPresenceMs / 3600000).toFixed(1);
    const lateNightPct = Math.round(f.lateNightInteractionRate * 100);

    return `You are analyzing behavioral interaction data between two Discord users. Based on the structural features below, classify the relationship. Do NOT guess at content — only use the provided statistics.

Target user ID: ${f.targetId}
Other user ID: ${f.otherUserId}
Data window: ${f.dataWindowDays} days
Total interactions: ${f.totalInteractions}

Message patterns:
- Messages sent by target to/about this user: ${f.messageCount}
- Initiation ratio (target starts conversation): ${(f.initiationRatioTarget * 100).toFixed(0)}%
- Late-night interaction rate (10pm-5am): ${lateNightPct}%
- Average conversation length: ${f.avgConversationLength.toFixed(1)} messages
- Response latency: ${f.avgResponseLatencyMs !== null ? `${Math.round(f.avgResponseLatencyMs / 1000)}s` : "unknown"}

Voice:
- Co-presence time: ${voiceHours}h across ${f.voiceSessionCount} sessions

Message behavior:
- Edit rate (to this user): ${(f.editRate * 100).toFixed(1)}%
- Delete rate (to this user): ${(f.deleteRate * 100).toFixed(1)}%
- Reactions exchanged: ${f.reactionCount}
- Mentions: ${f.mentionCount}

Social context:
- Channel diversity: ${f.channelDiversity} different channels
- Private channel ratio: ${(f.privateChannelRatio * 100).toFixed(0)}%

Classification must be exactly one of:
casual_acquaintance | regular_friend | close_friend | potential_romantic_interest | group_friend | server_contact | conflict_relationship | unknown

Respond with valid JSON only, no preamble, no markdown fencing:
{"classification": "<one of the above>", "confidence": <0.0-1.0>, "reasoning": ["<short reason 1>", "<short reason 2>"]}`;
}

export function messageCategoryPrompt(messages: { id: string; content: string }[]): string {
    const list = messages
        .map(m => `{"id":"${m.id}","content":${JSON.stringify(m.content.substring(0, 200))}}`)
        .join("\n");

    return `Categorize each Discord message into exactly one category.

Categories: gaming | music | emotional | humor | planning | question | general

gaming = discussing/reacting to games
music = discussing music, artists, songs, concerts
emotional = expressing feelings, stress, excitement, personal life
humor = jokes, memes, playful banter
planning = coordinating events, times, logistics
question = asking for information or help
general = everything else

Messages:
${list}

Return a JSON array only, no markdown fencing, no explanation:
[{"id":"<message_id>","category":"<category>","confidence":<0.0-1.0>}, ...]`;
}

export function dailyBriefNarrativePrompt(stats: BriefStats): string {
    const active = stats.onlineMinutes + stats.idleMinutes + stats.dndMinutes;
    const parts: string[] = [
        `Date: ${stats.date}`,
        `Active time: ${active} minutes`,
        `Messages sent: ${stats.messageCount}`,
        `Deleted messages: ${stats.deletedMessages}`,
        `Voice minutes: ${stats.voiceMinutes}`,
        `Ghost typing events: ${stats.ghostTypeEvents}`,
    ];
    if (stats.topActivities.length) {
        parts.push(`Activities: ${stats.topActivities.map(a => `${a.name} (${a.minutes}min)`).join(", ")}`);
    }
    if (stats.anomalies.length) {
        parts.push(`Anomalies: ${stats.anomalies.join("; ")}`);
    }

    return `Write a 2-3 sentence neutral intelligence brief summarizing the following behavioral data for a tracked user. Be factual and concise. Do not speculate about reasons.

${parts.join("\n")}`;
}
