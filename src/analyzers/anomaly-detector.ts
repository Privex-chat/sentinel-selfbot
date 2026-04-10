import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { analyzeSleepSchedule } from "./sleep-schedule";

const log = createLogger("AnomalyDetector");

export interface Anomaly {
    type: string;
    severity: "low" | "medium" | "high";
    description: string;
    timestamp: number;
    data?: any;
}

export function detectAnomalies(targetId: string, days: number = 7): Anomaly[] {
    const stmts = getStmts();
    const anomalies: Anomaly[] = [];
    const now = Date.now();
    const since = now - days * 86400000;
    const baselineSince = now - 30 * 86400000;

    // Get recent events
    const recentEvents = stmts.getEventsFiltered.all(targetId, since, now, 10000, 0) as any[];
    const baselineEvents = stmts.getEventsFiltered.all(targetId, baselineSince, since, 50000, 0) as any[];

    // 1. Unusual online hours
    const sleep = analyzeSleepSchedule(targetId);
    if (sleep.estimatedBedtime && sleep.estimatedWakeTime) {
        const presenceEvents = recentEvents.filter((e: any) => e.event_type === "PRESENCE_UPDATE");
        for (const e of presenceEvents) {
            try {
                const data = JSON.parse(e.data);
                if (data.newStatus !== "offline") {
                    const hour = new Date(e.timestamp).getHours();
                    const bedHour = parseInt(sleep.estimatedBedtime!.split(":")[0]);
                    const wakeHour = parseInt(sleep.estimatedWakeTime!.split(":")[0]);
                    let isSleepHour = false;
                    if (bedHour > wakeHour) {
                        // Overnight sleep (e.g., bed 23:00, wake 08:00)
                        isSleepHour = hour >= bedHour || hour < wakeHour;
                    } else if (bedHour < wakeHour) {
                        // Daytime sleep (e.g., bed 03:00, wake 11:00)
                        isSleepHour = hour >= bedHour && hour < wakeHour;
                    }
                    if (isSleepHour) {
                        anomalies.push({
                            type: "UNUSUAL_HOUR",
                            severity: "medium",
                            description: `Online at ${hour}:00 (usual sleep: ${sleep.estimatedBedtime}-${sleep.estimatedWakeTime})`,
                            timestamp: e.timestamp,
                        });
                    }
                }
            } catch { }
        }
    }

    // 2. Message volume anomaly
    const recentMsgCount = recentEvents.filter((e: any) => e.event_type === "MESSAGE_CREATE").length;
    const baselineMsgCount = baselineEvents.filter((e: any) => e.event_type === "MESSAGE_CREATE").length;
    const baselineDays = Math.max((since - baselineSince) / 86400000, 1);
    const avgDailyMsgs = baselineMsgCount / baselineDays;
    const recentDailyMsgs = recentMsgCount / days;

    if (avgDailyMsgs > 5 && recentDailyMsgs > avgDailyMsgs * 2) {
        anomalies.push({
            type: "HIGH_MESSAGE_VOLUME",
            severity: "low",
            description: `Messaging ${Math.round(recentDailyMsgs)}x/day vs ${Math.round(avgDailyMsgs)}x/day baseline`,
            timestamp: now,
        });
    }
    if (avgDailyMsgs > 5 && recentDailyMsgs < avgDailyMsgs * 0.3) {
        anomalies.push({
            type: "LOW_MESSAGE_VOLUME",
            severity: "medium",
            description: `Messaging only ${Math.round(recentDailyMsgs)}x/day vs ${Math.round(avgDailyMsgs)}x/day baseline`,
            timestamp: now,
        });
    }

    // 3. New game detection
    const recentActivities = recentEvents.filter((e: any) => e.event_type === "ACTIVITY_START");
    for (const e of recentActivities) {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 0) {
                const baselineHas = baselineEvents.some((be: any) => {
                    if (be.event_type !== "ACTIVITY_START") return false;
                    try {
                        const bd = JSON.parse(be.data);
                        return bd.name === data.name;
                    } catch { return false; }
                });
                if (!baselineHas) {
                    anomalies.push({
                        type: "NEW_GAME",
                        severity: "low",
                        description: `Playing "${data.name}" for the first time`,
                        timestamp: e.timestamp,
                    });
                }
            }
        } catch { }
    }

    // 4. Profile changes are always flagged
    const profileChanges = recentEvents.filter((e: any) =>
        ["PROFILE_UPDATE", "AVATAR_CHANGE", "USERNAME_CHANGE"].includes(e.event_type)
    );
    for (const e of profileChanges) {
        anomalies.push({
            type: "PROFILE_CHANGE",
            severity: "medium",
            description: `Profile updated: ${e.event_type}`,
            timestamp: e.timestamp,
        });
    }

    // 5. Ghost typing spike
    const recentGhosts = recentEvents.filter((e: any) => e.event_type === "GHOST_TYPE").length;
    const baselineGhosts = baselineEvents.filter((e: any) => e.event_type === "GHOST_TYPE").length;
    const avgGhosts = baselineGhosts / baselineDays;
    const recentGhostDaily = recentGhosts / days;
    if (avgGhosts > 1 && recentGhostDaily > avgGhosts * 3) {
        anomalies.push({
            type: "GHOST_TYPE_SPIKE",
            severity: "low",
            description: `Ghost typing rate spiked: ${Math.round(recentGhostDaily)}/day vs ${Math.round(avgGhosts)}/day`,
            timestamp: now,
        });
    }

    anomalies.sort((a, b) => b.timestamp - a.timestamp);
    return anomalies;
}
