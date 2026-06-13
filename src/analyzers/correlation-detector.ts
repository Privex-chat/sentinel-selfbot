import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("CorrelationDetector");

export interface EventCorrelation {
    triggerType: string;
    followType: string;
    occurrences: number;
    avgDelayMs: number;
    lift: number;
    confidence: number;
}

export function detectCorrelations(
    targetId: string,
    days: number = 30,
    windowMs: number = 1_800_000
): EventCorrelation[] {
    const stmts = getStmts();
    const now = Date.now();
    const since = now - days * 86_400_000;

    // Slim projection (event_type + timestamp). Correlation analysis never
    // touches the data column; loading it was ~10× the memory cost per row.
    const events = stmts.getEventTypeTimestamps.all(targetId, since, now, 50000) as Array<{ event_type: string; timestamp: number }>;
    if (events.length < 10) return [];

    // Count per event type
    const typeCounts = new Map<string, number>();
    for (const e of events) {
        typeCounts.set(e.event_type, (typeCounts.get(e.event_type) || 0) + 1);
    }

    // Only consider types with >5 occurrences
    const commonTypes = [...typeCounts.entries()]
        .filter(([, count]) => count > 5)
        .map(([type]) => type);

    if (commonTypes.length < 2) return [];

    const totalEvents = events.length;
    const correlations: EventCorrelation[] = [];

    // Group events by type, then sort each bucket ascending by timestamp so we
    // can binary-search the window boundary instead of linearly scanning every
    // pair. Previous implementation was O(|A| × |B|) per pair × |types|² pairs.
    // On a 50 000-event window with 20 distinct types that's billions of
    // comparisons; binary search collapses it to O((|A| log |B|) per pair).
    const byType = new Map<string, number[]>();
    for (const e of events) {
        const arr = byType.get(e.event_type) || [];
        arr.push(e.timestamp);
        byType.set(e.event_type, arr);
    }
    for (const arr of byType.values()) arr.sort((a, b) => a - b);

    // Lower bound: index of the first element with timestamp > `from`.
    function firstAfter(sorted: number[], from: number): number {
        let lo = 0, hi = sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (sorted[mid] <= from) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Check all pairs (A, B) where A ≠ B
    for (let i = 0; i < commonTypes.length; i++) {
        for (let j = 0; j < commonTypes.length; j++) {
            if (i === j) continue;
            const typeA = commonTypes[i];
            const typeB = commonTypes[j];

            const eventsA = byType.get(typeA)!;
            const eventsB = byType.get(typeB)!;
            const totalA = eventsA.length;
            const totalB = eventsB.length;

            let occurrences = 0;
            const delays: number[] = [];

            // For each A, find the first B strictly after A via binary search,
            // then walk forward only while the timestamp is within the window.
            for (const afterA of eventsA) {
                const beforeB = afterA + windowMs;
                const startIdx = firstAfter(eventsB, afterA);
                if (startIdx < eventsB.length && eventsB[startIdx] <= beforeB) {
                    occurrences++;
                    delays.push(eventsB[startIdx] - afterA);
                }
            }

            if (occurrences < 3) continue;

            const avgDelayMs = delays.length > 0
                ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
                : 0;

            // Lift = P(A→B) / P(B)
            const pAB = occurrences / totalA;
            const pB = totalB / totalEvents;
            const lift = pB > 0 ? pAB / pB : 0;
            const confidence = occurrences / totalA;

            if (lift < 1.5) continue;

            correlations.push({
                triggerType: typeA,
                followType: typeB,
                occurrences,
                avgDelayMs,
                lift: Math.round(lift * 100) / 100,
                confidence: Math.round(confidence * 1000) / 1000,
            });
        }
    }

    // Sort by lift descending, return top 20
    correlations.sort((a, b) => b.lift - a.lift);
    return correlations.slice(0, 20);
}