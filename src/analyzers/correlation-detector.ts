import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("CorrelationDetector");

export interface EventCorrelation {
    eventTypeA: string;
    eventTypeB: string;
    direction: "A_before_B" | "A_after_B" | "concurrent";
    windowMs: number;
    occurrences: number;
    totalEventsA: number;
    totalEventsB: number;
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

    const events = stmts.getEventsFiltered.all(targetId, since, now, 50000, 0) as any[];
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

    // Group events by type for fast lookup
    const byType = new Map<string, { timestamp: number }[]>();
    for (const e of events) {
        const arr = byType.get(e.event_type) || [];
        arr.push({ timestamp: e.timestamp });
        byType.set(e.event_type, arr);
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

            // For each A, count B occurrences within windowMs after
            for (const eA of eventsA) {
                const afterA = eA.timestamp;
                const beforeB = afterA + windowMs;
                const count = eventsB.filter(
                    eB => eB.timestamp > afterA && eB.timestamp <= beforeB
                ).length;
                if (count > 0) occurrences++;
            }

            if (occurrences < 3) continue;

            // Lift = P(A∧B) / (P(A) * P(B))
            // Approximated as: occurrences / totalA vs totalB/totalEvents
            const pAB = occurrences / totalA;
            const pB = totalB / totalEvents;
            const lift = pB > 0 ? pAB / pB : 0;
            const confidence = occurrences / totalA;

            if (lift < 1.5) continue;

            correlations.push({
                eventTypeA: typeA,
                eventTypeB: typeB,
                direction: "A_before_B",
                windowMs,
                occurrences,
                totalEventsA: totalA,
                totalEventsB: totalB,
                lift: Math.round(lift * 100) / 100,
                confidence: Math.round(confidence * 1000) / 1000,
            });
        }
    }

    // Sort by lift descending, return top 20
    correlations.sort((a, b) => b.lift - a.lift);
    return correlations.slice(0, 20);
}
