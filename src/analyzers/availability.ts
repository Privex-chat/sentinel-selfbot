import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("Availability");

export interface AvailabilityMatrix {
    online: number[][];     // 7x24 probability of being online
    messaging: number[][];  // 7x24 probability of messaging
    voice: number[][];      // 7x24 probability of being in voice
    gaming: number[][];     // 7x24 probability of gaming
}

export function predictAvailability(targetId: string, weeks: number = 4): AvailabilityMatrix {
    const stmts = getStmts();
    const since = Date.now() - weeks * 7 * 86400000;

    // Count total data points per bucket for normalization
    const totalDays = weeks * 7;
    const daysPerDow = Math.ceil(totalDays / 7);

    const online = create7x24();
    const messaging = create7x24();
    const voice = create7x24();
    const gaming = create7x24();

    const nowMs = Date.now();

    // Presence data — open sessions use nowMs as their end so live state is reflected
    const presenceSessions = stmts.getPresenceSessions.all(targetId, since, nowMs) as any[];
    for (const s of presenceSessions) {
        if (s.status === "offline") continue;
        fillTimeRange(online, s.start_time, s.end_time ?? nowMs);
    }

    // Message data
    const messages = stmts.getMessagesByTarget.all(targetId, 10000, 0) as any[];
    for (const m of messages) {
        if (m.created_at < since) continue;
        const d = new Date(m.created_at);
        messaging[d.getDay()][d.getHours()]++;
    }

    // Voice data — include open session
    const voiceSessions = stmts.getVoiceSessions.all(targetId, since, 5000) as any[];
    for (const s of voiceSessions) {
        fillTimeRange(voice, s.start_time, s.end_time ?? nowMs);
    }

    // Gaming data — include open session
    const activitySessions = stmts.getActivitySessions.all(targetId, since, 5000) as any[];
    for (const s of activitySessions) {
        if (s.activity_type !== 0) continue;
        fillTimeRange(gaming, s.start_time, s.end_time ?? nowMs);
    }

    // Normalize to probabilities (0-1)
    normalize(online, daysPerDow);
    normalize(messaging, daysPerDow);
    normalize(voice, daysPerDow);
    normalize(gaming, daysPerDow);

    return { online, messaging, voice, gaming };
}

function create7x24(): number[][] {
    return Array.from({ length: 7 }, () => new Array(24).fill(0));
}

function fillTimeRange(matrix: number[][], startMs: number, endMs: number): void {
    if (endMs <= startMs) return;

    // Snap to the top of the hour containing `startMs` so a session that begins
    // at 14:23 still credits the 14:00 bucket (and not just 15, 16, …).
    // Previously the loop began at the exact session start, missing the
    // partial-overlap hour entirely.
    const start = new Date(startMs);
    start.setMinutes(0, 0, 0);

    let current = start;
    while (current.getTime() < endMs) {
        const dow = current.getDay();
        const hour = current.getHours();
        matrix[dow][hour]++;
        current = new Date(current.getTime() + 3600000);
    }
}

function normalize(matrix: number[][], daysPerDow: number): void {
    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            matrix[d][h] = Math.min(Math.round(matrix[d][h] / Math.max(daysPerDow, 1) * 100) / 100, 1);
        }
    }
}
