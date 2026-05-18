import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { getDb } from "../database/connection";
import { getHourInTimezone, getDayInTimezone, getTimezoneOffsetMinutes, fmtDateInTz } from "../utils/timezone";

const log = createLogger("SleepAnalyzer");

export interface SleepSchedule {
    estimatedBedtime: string | null;
    estimatedWakeTime: string | null;
    avgSleepDurationHours: number | null;
    weekdayBedtime: string | null;
    weekendBedtime: string | null;
    weekdayWakeTime: string | null;
    weekendWakeTime: string | null;
    irregularities: string[];
    confidence: number;
    dataPoints: number;
}

export function analyzeSleepSchedule(targetId: string, days: number = 14): SleepSchedule {
    const stmts = getStmts();
    const since = Date.now() - days * 86400000;

    const target = getDb().prepare("SELECT timezone FROM targets WHERE user_id = ?")
        .get(targetId) as { timezone: string | null } | undefined;
    const tz = target?.timezone ?? null;

    const sessions = stmts.getPresenceSessions.all(targetId, since, Date.now()) as any[];

    // Find long offline sessions (>3 hours) as potential sleep periods
    const sleepSessions: { startMs: number; endMs: number; duration: number }[] = [];

    for (const session of sessions) {
        if (session.status !== "offline" || !session.end_time) continue;
        const duration = session.duration_ms || (session.end_time - session.start_time);
        if (duration < 3 * 3600000) continue;

        sleepSessions.push({
            startMs: session.start_time,
            endMs: session.end_time,
            duration,
        });
    }

    if (sleepSessions.length < 3) {
        return {
            estimatedBedtime: null, estimatedWakeTime: null,
            avgSleepDurationHours: null, weekdayBedtime: null,
            weekendBedtime: null, weekdayWakeTime: null,
            weekendWakeTime: null, irregularities: [],
            confidence: 0, dataPoints: sleepSessions.length,
        };
    }

    const toFractionalHour = (ms: number) => {
        const offsetMin = getTimezoneOffsetMinutes(tz, ms);
        const shifted = new Date(ms + offsetMin * 60_000);
        return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
    };

    const bedtimes = sleepSessions.map(s => toFractionalHour(s.startMs));
    const wakeTimes = sleepSessions.map(s => toFractionalHour(s.endMs));
    const durations = sleepSessions.map(s => s.duration / 3600000);

    const weekdayBed: number[] = [];
    const weekendBed: number[] = [];
    const weekdayWake: number[] = [];
    const weekendWake: number[] = [];

    for (const s of sleepSessions) {
        const day = getDayInTimezone(s.startMs, tz);
        const bedHour = toFractionalHour(s.startMs);
        const wakeHour = toFractionalHour(s.endMs);

        if (day === 0 || day === 6) {
            weekendBed.push(bedHour);
            weekendWake.push(wakeHour);
        } else {
            weekdayBed.push(bedHour);
            weekdayWake.push(wakeHour);
        }
    }

    const irregularities: string[] = [];
    const medianBed = median(bedtimes);
    const medianWake = median(wakeTimes);

    for (const s of sleepSessions) {
        const h = getHourInTimezone(s.startMs, tz);
        if (h >= 5 && h < 12) {
            const dateStr = fmtDateInTz(s.startMs, tz);
            irregularities.push(`All-nighter on ${dateStr}`);
        }
    }

    const confidence = Math.min(sleepSessions.length / days, 1) * 100;

    return {
        estimatedBedtime: formatHour(medianBed),
        estimatedWakeTime: formatHour(medianWake),
        avgSleepDurationHours: Math.round(median(durations) * 10) / 10,
        weekdayBedtime: weekdayBed.length >= 2 ? formatHour(median(weekdayBed)) : null,
        weekendBedtime: weekendBed.length >= 2 ? formatHour(median(weekendBed)) : null,
        weekdayWakeTime: weekdayWake.length >= 2 ? formatHour(median(weekdayWake)) : null,
        weekendWakeTime: weekendWake.length >= 2 ? formatHour(median(weekendWake)) : null,
        irregularities,
        confidence: Math.round(confidence),
        dataPoints: sleepSessions.length,
    };
}

function median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatHour(h: number): string {
    const hours = Math.floor(h) % 24;
    const minutes = Math.round((h % 1) * 60);
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}
