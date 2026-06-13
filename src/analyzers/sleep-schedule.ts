import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { getTargetTimezone } from "../target-lifecycle";
import { getDateStrInTz, getHourFloatInTz, getDayOfWeekInTz } from "../utils/timezone";

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
    /** IANA timezone the analysis was computed against — surface so the operator can sanity-check. */
    timezone: string;
}

export function analyzeSleepSchedule(targetId: string, days: number = 14): SleepSchedule {
    const stmts = getStmts();
    const tz = getTargetTimezone(targetId);
    const since = Date.now() - days * 86400000;

    const sessions = stmts.getPresenceSessions.all(targetId, since, Date.now()) as any[];

    // Find long offline sessions (>3 hours) as potential sleep periods.
    // start/end stored as epoch ms; all hour/day extraction routes through the
    // target's tz so the bedtime/wake-time numbers reflect their local clock,
    // not the host server's.
    const sleepSessions: {
        startEpoch: number;
        endEpoch: number;
        duration: number;
        bedHour: number;
        wakeHour: number;
        bedDow: number;
        bedDateStr: string;
    }[] = [];

    for (const session of sessions) {
        if (session.status !== "offline" || !session.end_time) continue;
        const duration = session.duration_ms || (session.end_time - session.start_time);
        if (duration < 3 * 3600000) continue; // Skip < 3 hours

        sleepSessions.push({
            startEpoch: session.start_time,
            endEpoch:   session.end_time,
            duration,
            bedHour:    getHourFloatInTz(session.start_time, tz),
            wakeHour:   getHourFloatInTz(session.end_time,   tz),
            bedDow:     getDayOfWeekInTz(session.start_time, tz),
            bedDateStr: getDateStrInTz(session.start_time,   tz),
        });
    }

    if (sleepSessions.length < 3) {
        return {
            estimatedBedtime: null, estimatedWakeTime: null,
            avgSleepDurationHours: null, weekdayBedtime: null,
            weekendBedtime: null, weekdayWakeTime: null,
            weekendWakeTime: null, irregularities: [],
            confidence: 0, dataPoints: sleepSessions.length,
            timezone: tz,
        };
    }

    const bedtimes  = sleepSessions.map(s => s.bedHour);
    const wakeTimes = sleepSessions.map(s => s.wakeHour);
    const durations = sleepSessions.map(s => s.duration / 3600000);

    // Separate weekday vs weekend in the target's local tz (DOW 0=Sun, 6=Sat).
    const weekdayBed:  number[] = [];
    const weekendBed:  number[] = [];
    const weekdayWake: number[] = [];
    const weekendWake: number[] = [];

    for (const s of sleepSessions) {
        if (s.bedDow === 0 || s.bedDow === 6) {
            weekendBed.push(s.bedHour);
            weekendWake.push(s.wakeHour);
        } else {
            weekdayBed.push(s.bedHour);
            weekdayWake.push(s.wakeHour);
        }
    }

    const irregularities: string[] = [];
    // Wrap-aware median for time-of-day values so bedtimes straddling midnight
    // (e.g. 23:30 + 01:00) don't collapse to a nonsensical noon median.
    const medianBed  = circularMedianHours(bedtimes);
    const medianWake = circularMedianHours(wakeTimes);

    // All-nighter detection: went to sleep between 5am and noon in the local tz.
    for (const s of sleepSessions) {
        if (s.bedHour >= 5 && s.bedHour < 12) {
            irregularities.push(`All-nighter on ${s.bedDateStr}`);
        }
    }

    const confidence = Math.min(sleepSessions.length / days, 1) * 100;

    return {
        estimatedBedtime:      formatHour(medianBed),
        estimatedWakeTime:     formatHour(medianWake),
        avgSleepDurationHours: Math.round(median(durations) * 10) / 10,
        weekdayBedtime:        weekdayBed.length  >= 2 ? formatHour(median(weekdayBed))  : null,
        weekendBedtime:        weekendBed.length  >= 2 ? formatHour(median(weekendBed))  : null,
        weekdayWakeTime:       weekdayWake.length >= 2 ? formatHour(median(weekdayWake)) : null,
        weekendWakeTime:       weekendWake.length >= 2 ? formatHour(median(weekendWake)) : null,
        irregularities,
        confidence: Math.round(confidence),
        dataPoints: sleepSessions.length,
        timezone:   tz,
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
