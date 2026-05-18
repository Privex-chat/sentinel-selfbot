import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { getDb } from "../database/connection";
import { getHourInTimezone, getDayInTimezone } from "../utils/timezone";

const log = createLogger("RoutineDetector");

export interface HourBucket {
    dayOfWeek: number;
    hour: number;
    eventCount: number;
    dominantType: string | null;
    isTypical: boolean;
}

export interface RoutinePattern {
    weeklyGrid: HourBucket[][];
    summary: string[];
    anomalies: string[];
}

export function detectRoutine(targetId: string, weeks: number = 4): RoutinePattern {
    const stmts = getStmts();
    const since = Date.now() - weeks * 7 * 86400000;

    const target = getDb().prepare("SELECT timezone FROM targets WHERE user_id = ?")
        .get(targetId) as { timezone: string | null } | undefined;
    const tz = target?.timezone ?? null;

    const events = stmts.getEventsFiltered.all(targetId, since, Date.now(), 50000, 0) as any[];

    // Build 7x24 grid
    const grid: { count: number; types: Record<string, number> }[][] =
        Array.from({ length: 7 }, () =>
            Array.from({ length: 24 }, () => ({ count: 0, types: {} }))
        );

    for (const event of events) {
        const dow = getDayInTimezone(event.timestamp, tz);
        const hour = getHourInTimezone(event.timestamp, tz);
        grid[dow][hour].count++;
        grid[dow][hour].types[event.event_type] = (grid[dow][hour].types[event.event_type] || 0) + 1;
    }

    // Compute stats
    const allCounts = grid.flat().map(b => b.count);
    const mean = allCounts.reduce((a, b) => a + b, 0) / allCounts.length;
    const stdDev = Math.sqrt(allCounts.reduce((s, c) => s + (c - mean) ** 2, 0) / allCounts.length);

    const weeklyGrid: HourBucket[][] = grid.map((day, dow) =>
        day.map((bucket, hour) => {
            const dominant = Object.entries(bucket.types).sort((a, b) => b[1] - a[1])[0];
            return {
                dayOfWeek: dow,
                hour,
                eventCount: bucket.count,
                dominantType: dominant ? dominant[0] : null,
                isTypical: stdDev > 0 ? Math.abs(bucket.count - mean) <= 2 * stdDev : true,
            };
        })
    );

    // Generate summary
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const summary: string[] = [];
    const anomalies: string[] = [];

    for (let dow = 0; dow < 7; dow++) {
        const activeBuckets = weeklyGrid[dow].filter(b => b.eventCount > mean);
        if (activeBuckets.length > 0) {
            const hours = activeBuckets.map(b => b.hour).sort((a, b) => a - b);
            const ranges = compressRanges(hours);
            summary.push(`${dayNames[dow]}: active during ${ranges}`);
        }
    }

    // Find today's anomalies
    const now = Date.now();
    const todayDow = getDayInTimezone(now, tz);
    const currentHour = getHourInTimezone(now, tz);
    const todayBucket = weeklyGrid[todayDow][currentHour];
    if (!todayBucket.isTypical && todayBucket.eventCount === 0 && mean > 2) {
        anomalies.push(`Unusually quiet for ${dayNames[todayDow]} at ${currentHour}:00`);
    }

    return { weeklyGrid, summary, anomalies };
}

function compressRanges(hours: number[]): string {
    if (hours.length === 0) return "none";
    const ranges: string[] = [];
    let start = hours[0];
    let end = hours[0];

    for (let i = 1; i < hours.length; i++) {
        if (hours[i] === end + 1) {
            end = hours[i];
        } else {
            ranges.push(start === end ? `${start}:00` : `${start}:00-${end}:00`);
            start = end = hours[i];
        }
    }
    ranges.push(start === end ? `${start}:00` : `${start}:00-${end}:00`);
    return ranges.join(", ");
}
