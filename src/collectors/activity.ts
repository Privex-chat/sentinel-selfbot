import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { evaluateEvent } from "../alerts/engine";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("Activity");

interface TrackedActivity {
    name: string;
    type: number;
    applicationId?: string;
    details?: string;
    state?: string;
    dbSessionId?: number;
}

const currentActivities: Map<string, TrackedActivity[]> = new Map();

function activityKey(a: { name: string; type: number }): string {
    return `${a.type}:${a.name}`;
}

function extractMetadata(activity: any): string {
    return JSON.stringify({
        timestamps: activity.timestamps || null,
        assets: activity.assets || null,
        party: activity.party || null,
        buttons: activity.buttons || null,
        flags: activity.flags || null,
        instance: activity.instance || null,
        url: activity.url || null,
        emoji: activity.emoji || null,
    });
}

export function getCurrentActivities(targetId: string): TrackedActivity[] {
    return currentActivities.get(targetId) || [];
}

export function handleActivityUpdate(targetId: string, activities: any[]): void {
    const stmts = getStmts();
    const now = Date.now();
    const oldActivities = currentActivities.get(targetId) || [];
    const newActivities = activities || [];

    const oldKeys = new Set(oldActivities.map(a => activityKey(a)));
    const newKeys = new Set(newActivities.map((a: any) => activityKey(a)));

    // Capture the dbSessionId for every freshly-opened activity so the
    // updated-tracked rebuild below doesn't have to scan getOpenActivitySessions
    // per item. Without this every PRESENCE_UPDATE that changed activities
    // re-queried the entire open-sessions table once per activity.
    const newSessionIds = new Map<string, number>();

    // Detect new activities
    for (const activity of newActivities) {
        const key = activityKey(activity);
        if (!oldKeys.has(key)) {
            const metadata = extractMetadata(activity);
            const result = stmts.insertActivitySession.run(
                targetId,
                activity.name,
                activity.type,
                activity.application_id || null,
                activity.details || null,
                activity.state || null,
                now,
                metadata
            );
            newSessionIds.set(key, Number(result.lastInsertRowid));

            const eventData = JSON.stringify({
                name: activity.name,
                type: activity.type,
                details: activity.details || null,
                state: activity.state || null,
                applicationId: activity.application_id || null,
            });

            let eventType = "ACTIVITY_START";

            if (activity.type === 2) {
                eventType = "SPOTIFY_START";
                const spotifyData = JSON.stringify({
                    name: activity.name,
                    song: activity.details || null,
                    artist: activity.state || null,
                    album: activity.assets?.large_text || null,
                    trackStart: activity.timestamps?.start || null,
                    trackEnd: activity.timestamps?.end || null,
                });
                stmts.insertEvent.run(targetId, "SPOTIFY_START", now, spotifyData, null, null);
                pushSSEEvent({
                    target_id: targetId,
                    event_type: "SPOTIFY_START",
                    timestamp: now,
                    data: JSON.parse(spotifyData),
                });
            } else if (activity.type === 4) {
                eventType = "CUSTOM_STATUS_SET";
                const customData = JSON.stringify({
                    name: activity.name,
                    text: activity.state || null,
                    emoji: activity.emoji || null,
                });
                stmts.insertEvent.run(targetId, eventType, now, customData, null, null);
                pushSSEEvent({
                    target_id: targetId,
                    event_type: "CUSTOM_STATUS_SET",
                    timestamp: now,
                    data: JSON.parse(customData),
                });
            } else if (activity.type === 1) {
                eventType = "STREAMING_START";
                const streamData = JSON.stringify({
                    name: activity.name,
                    url: activity.url || null,
                    details: activity.details || null,
                });
                stmts.insertEvent.run(targetId, eventType, now, streamData, null, null);
                pushSSEEvent({
                    target_id: targetId,
                    event_type: "STREAMING_START",
                    timestamp: now,
                    data: JSON.parse(streamData),
                });
            } else {
                stmts.insertEvent.run(targetId, eventType, now, eventData, null, null);
                pushSSEEvent({
                    target_id: targetId,
                    event_type: "ACTIVITY_START",
                    timestamp: now,
                    data: JSON.parse(eventData),
                });
            }

            // Fire alert evaluation for ACTIVITY_START (covers STARTS_ACTIVITY, NEW_GAME)
            evaluateEvent("ACTIVITY_START", targetId, eventData, now);

            log.debug(`${targetId}: activity start - ${activity.name} (type ${activity.type})`);
        }
    }

    // Detect ended activities. Lazily load open sessions only if any old activity
    // lacks a cached dbSessionId — common case is "all cached" → zero DB scans.
    let openSessionsByKey: Map<string, number> | null = null;
    const loadOpenSessionsByKey = (): Map<string, number> => {
        if (openSessionsByKey) return openSessionsByKey;
        const rows = stmts.getOpenActivitySessions.all(targetId) as any[];
        openSessionsByKey = new Map(
            rows.map((s: any) => [`${s.activity_type}:${s.activity_name}`, s.id])
        );
        return openSessionsByKey;
    };

    for (const activity of oldActivities) {
        const key = activityKey(activity);
        if (!newKeys.has(key)) {
            const sessionId = activity.dbSessionId ?? loadOpenSessionsByKey().get(key);
            if (sessionId) {
                stmts.closeActivitySession.run(now, now, sessionId);
            }

            const eventData = JSON.stringify({
                name: activity.name,
                type: activity.type,
            });

            let eventType = "ACTIVITY_END";
            if (activity.type === 2) eventType = "SPOTIFY_END";
            else if (activity.type === 4) eventType = "CUSTOM_STATUS_CLEARED";
            else if (activity.type === 1) eventType = "STREAMING_END";

            stmts.insertEvent.run(targetId, eventType, now, eventData, null, null);

            // Push to SSE
            pushSSEEvent({
                target_id: targetId,
                event_type: eventType,
                timestamp: now,
                data: JSON.parse(eventData),
            });

            // Fire alert evaluation for ACTIVITY_END (covers STOPS_ACTIVITY)
            evaluateEvent("ACTIVITY_END", targetId, eventData, now);

            log.debug(`${targetId}: activity end - ${activity.name}`);
        }
    }

    // Update tracked state. Resolution order for dbSessionId:
    //   1. Just-inserted session id from the "Detect new activities" loop.
    //   2. Existing TrackedActivity carried over from the previous tick.
    //   3. One-shot lookup of currently-open sessions (lazy, scanned at most once).
    const oldByKey = new Map(oldActivities.map(a => [activityKey(a), a]));
    const updatedTracked: TrackedActivity[] = newActivities.map((a: any) => {
        const key = activityKey(a);
        const existing = oldByKey.get(key);
        if (existing?.dbSessionId) {
            return { ...existing, details: a.details, state: a.state };
        }
        const dbSessionId =
            newSessionIds.get(key) ??
            loadOpenSessionsByKey().get(key);
        return {
            name: a.name,
            type: a.type,
            applicationId: a.application_id,
            details: a.details,
            state: a.state,
            dbSessionId,
        };
    });

    currentActivities.set(targetId, updatedTracked);
}

export function initActivities(targetId: string, activities: any[]): void {
    const stmts = getStmts();
    const now = Date.now();

    const tracked: TrackedActivity[] = [];
    for (const activity of activities || []) {
        const metadata = extractMetadata(activity);
        const result = stmts.insertActivitySession.run(
            targetId, activity.name, activity.type,
            activity.application_id || null, activity.details || null,
            activity.state || null, now, metadata
        );

        const eventData = JSON.stringify({
            name: activity.name, type: activity.type,
            details: activity.details || null, state: activity.state || null,
            midSession: true,
        });
        stmts.insertEvent.run(targetId, "INITIAL_ACTIVITY", now, eventData, null, null);
        // Do NOT push INITIAL_ACTIVITY to SSE — fires during reconnect

        tracked.push({
            name: activity.name, type: activity.type,
            applicationId: activity.application_id,
            details: activity.details, state: activity.state,
            dbSessionId: Number(result.lastInsertRowid),
        });
    }

    currentActivities.set(targetId, tracked);
}