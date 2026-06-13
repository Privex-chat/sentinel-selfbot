import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

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

    const sessions = stmts.getPresenceSessions.all(targetId, since, Date.now()) as any[];

    // Find long offline sessions (>3 hours) as potential sleep periods
    const sleepSessions: { start: Date; end: Date; duration: number }[] = [];

    for (const session of sessions) {
        if (session.status !== "offline" || !session.end_time) continue;
        const duration = session.duration_ms || (session.end_time - session.start_time);
        if (duration < 3 * 3600000) continue; // Skip < 3 hours

        sleepSessions.push({
            start: new Date(session.start_time),
            end: new Date(session.end_time),
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

    // Extract bedtimes and wake times
    const bedtimes = sleepSessions.map(s => s.start.getHours() + s.start.getMinutes() / 60);
    const wakeTimes = sleepSessions.map(s => s.end.getHours() + s.end.getMinutes() / 60);
    const durations = sleepSessions.map(s => s.duration / 3600000);

    // Separate weekday vs weekend
    const weekdayBed: number[] = [];
    const weekendBed: number[] = [];
    const weekdayWake: number[] = [];
    const weekendWake: number[] = [];

    for (const s of sleepSessions) {
        const day = s.start.getDay();
        const bedHour = s.start.getHours() + s.start.getMinutes() / 60;
        const wakeHour = s.end.getHours() + s.end.getMinutes() / 60;

        if (day === 0 || day === 6) { // Sunday=0, Saturday=6
            weekendBed.push(bedHour);
            weekendWake.push(wakeHour);
        } else {
            weekdayBed.push(bedHour);
            weekdayWake.push(wakeHour);
        }
    }

    const irregularities: string[] = [];
    // Use a wrap-aware median for time-of-day values. The naive median collapses
    // for users whose bedtimes straddle midnight (e.g. 23:30 + 01:00 → median ≈
    // 12:15, which is nonsense). circularMedianHours detects the wrap and shifts
    // the pre-noon values into a continuous post-midnight range before sorting.
    const medianBed = circularMedianHours(bedtimes);
    const medianWake = circularMedianHours(wakeTimes);

    // Detect all-nighters (went to sleep after 5am)
    for (const s of sleepSessions) {
        const h = s.start.getHours();
        if (h >= 5 && h < 12) {
            irregularities.push(`All-nighter on ${s.start.toISOString().split("T")[0]}`);
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

/**
 * Median of hour-of-day values that may wrap across midnight.
 *
 * If the min/max span is ≤12 hours the values don't cross midnight and the
 * plain median is correct. Otherwise the cluster spans midnight: shift values
 * < 12 to their post-midnight twin (h + 24), take the median in the unwrapped
 * space, then wrap back into [0, 24).
 */
function circularMedianHours(hours: number[]): number {
    if (hours.length === 0) return 0;
    const sorted = [...hours].sort((a, b) => a - b);
    if (sorted[sorted.length - 1] - sorted[0] <= 12) {
        return median(sorted);
    }
    const shifted = sorted.map(h => h < 12 ? h + 24 : h).sort((a, b) => a - b);
    const m = median(shifted);
    return m >= 24 ? m - 24 : m;
}

function formatHour(h: number): string {
    const hours = Math.floor(h) % 24;
    const minutes = Math.round((h % 1) * 60);
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}
