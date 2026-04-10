import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("VoiceHabits");

export interface VoiceHabitsData {
    totalVoiceMs: number;
    sessionCount: number;
    avgSessionMs: number;
    byHour: number[];
    byDay: number[];
    preferredChannels: { channelId: string; guildId: string; totalMs: number; sessions: number }[];
    muteRatio: number;
    deafRatio: number;
    streamingMs: number;
    topPartners: { userId: string; sharedMs: number }[];
}

export function analyzeVoiceHabits(targetId: string, days: number = 30): VoiceHabitsData {
    const stmts = getStmts();
    const since = Date.now() - days * 86400000;
    const sessions = stmts.getVoiceSessions.all(targetId, since, 5000) as any[];

    let totalMs = 0;
    let muteMs = 0;
    let deafMs = 0;
    let streamMs = 0;
    const byHour = new Array(24).fill(0);
    const byDay = new Array(7).fill(0);
    const channels: Map<string, { guildId: string; totalMs: number; sessions: number }> = new Map();
    const partners: Map<string, number> = new Map();

    for (const s of sessions) {
        const duration = s.duration_ms || 0;
        totalMs += duration;

        if (s.self_mute) muteMs += duration;
        if (s.self_deaf) deafMs += duration;
        if (s.streaming) streamMs += duration;

        const hour = new Date(s.start_time).getHours();
        const day = new Date(s.start_time).getDay();
        byHour[hour]++;
        byDay[day]++;

        const ch = channels.get(s.channel_id) || { guildId: s.guild_id, totalMs: 0, sessions: 0 };
        ch.totalMs += duration;
        ch.sessions++;
        channels.set(s.channel_id, ch);

        if (s.co_participants) {
            try {
                const participants: string[] = JSON.parse(s.co_participants);
                for (const p of participants) {
                    partners.set(p, (partners.get(p) || 0) + duration);
                }
            } catch { }
        }
    }

    const preferredChannels = [...channels.entries()]
        .map(([channelId, data]) => ({ channelId, ...data }))
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 10);

    const topPartners = [...partners.entries()]
        .map(([userId, sharedMs]) => ({ userId, sharedMs }))
        .sort((a, b) => b.sharedMs - a.sharedMs)
        .slice(0, 20);

    return {
        totalVoiceMs: totalMs,
        sessionCount: sessions.length,
        avgSessionMs: sessions.length > 0 ? Math.round(totalMs / sessions.length) : 0,
        byHour,
        byDay,
        preferredChannels,
        muteRatio: totalMs > 0 ? Math.round(muteMs / totalMs * 1000) / 1000 : 0,
        deafRatio: totalMs > 0 ? Math.round(deafMs / totalMs * 1000) / 1000 : 0,
        streamingMs: streamMs,
        topPartners,
    };
}
