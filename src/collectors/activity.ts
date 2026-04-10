import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

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

    // Detect new activities
    for (const activity of newActivities) {
        const key = activityKey(activity);
        if (!oldKeys.has(key)) {
            // Start new activity session
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

            const eventData = JSON.stringify({
                name: activity.name,
                type: activity.type,
                details: activity.details || null,
                state: activity.state || null,
                applicationId: activity.application_id || null,
            });

            // Special event types
            let eventType = "ACTIVITY_START";
            if (activity.type === 2) {
                eventType = "SPOTIFY_START";
                const spotifyData = JSON.stringify({
                    song: activity.details || null,
                    artist: activity.state || null,
                    album: activity.assets?.large_text || null,
                    trackStart: activity.timestamps?.start || null,
                    trackEnd: activity.timestamps?.end || null,
                });
                stmts.insertEvent.run(targetId, "SPOTIFY_START", now, spotifyData, null, null);
            } else if (activity.type === 4) {
                eventType = "CUSTOM_STATUS_SET";
                const customData = JSON.stringify({
                    text: activity.state || null,
                    emoji: activity.emoji || null,
                });
                stmts.insertEvent.run(targetId, eventType, now, customData, null, null);
            } else if (activity.type === 1) {
                eventType = "STREAMING_START";
                const streamData = JSON.stringify({
                    name: activity.name,
                    url: activity.url || null,
                    details: activity.details || null,
                });
                stmts.insertEvent.run(targetId, eventType, now, streamData, null, null);
            } else {
                stmts.insertEvent.run(targetId, eventType, now, eventData, null, null);
            }

            log.debug(`${targetId}: activity start - ${activity.name} (type ${activity.type})`);
        }
    }

    // Detect ended activities
    for (const activity of oldActivities) {
        const key = activityKey(activity);
        if (!newKeys.has(key)) {
            // Close activity session
            if (activity.dbSessionId) {
                stmts.closeActivitySession.run(now, now, activity.dbSessionId);
            } else {
                // Find and close by matching
                const openSessions = stmts.getOpenActivitySessions.all(targetId) as any[];
                const match = openSessions.find((s: any) => s.activity_name === activity.name && s.activity_type === activity.type);
                if (match) {
                    stmts.closeActivitySession.run(now, now, match.id);
                }
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
            log.debug(`${targetId}: activity end - ${activity.name}`);
        }
    }

    // Update tracked state — reuse known session IDs from old state, new ones from insert results
    const oldByKey = new Map(oldActivities.map(a => [activityKey(a), a]));
    const updatedTracked: TrackedActivity[] = newActivities.map((a: any) => {
        const key = activityKey(a);
        const existing = oldByKey.get(key);
        if (existing?.dbSessionId) {
            // Carry forward existing session ID
            return { ...existing, details: a.details, state: a.state };
        }
        // New activity — look up the session we just inserted
        const openSessions = stmts.getOpenActivitySessions.all(targetId) as any[];
        const match = openSessions.find((s: any) => s.activity_name === a.name && s.activity_type === a.type);
        return {
            name: a.name,
            type: a.type,
            applicationId: a.application_id,
            details: a.details,
            state: a.state,
            dbSessionId: match?.id,
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

        tracked.push({
            name: activity.name, type: activity.type,
            applicationId: activity.application_id,
            details: activity.details, state: activity.state,
            dbSessionId: Number(result.lastInsertRowid),
        });
    }

    currentActivities.set(targetId, tracked);
}
