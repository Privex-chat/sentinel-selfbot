import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { evaluateEvent } from "../alerts/engine";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("Presence");

interface PresenceState {
    status:       string;
    platform:     string | null;
    clientStatus: { desktop?: string; mobile?: string; web?: string } | null;
}

const currentPresence: Map<string, PresenceState> = new Map();

export function getPlatform(clientStatus: any): string | null {
    if (!clientStatus) return null;
    if (clientStatus.desktop && clientStatus.desktop !== "offline") return "desktop";
    if (clientStatus.mobile  && clientStatus.mobile  !== "offline") return "mobile";
    if (clientStatus.web     && clientStatus.web     !== "offline") return "web";
    return null;
}

export function getCurrentPresence(targetId: string): PresenceState | undefined {
    return currentPresence.get(targetId);
}

export function isActiveStatus(status: string): boolean {
    return status === "online" || status === "idle" || status === "dnd";
}

export function handlePresenceUpdate(targetId: string, data: any): void {
    const stmts     = getStmts();
    const newStatus = data.status || "offline";
    const clientStatus = data.client_status || null;
    const platform  = getPlatform(clientStatus);
    const now       = Date.now();

    const current   = currentPresence.get(targetId);
    const oldStatus = current?.status   ?? "unknown";
    const oldPlatform = current?.platform ?? null;

    // No change — skip
    if (oldStatus === newStatus && oldPlatform === platform) return;

    // Close ALL open presence sessions for this target (not just the most
    // recent one). Using the close-all statement prevents orphaned open rows
    // if duplicates were ever created by a previous bug or process restart.
    if (oldStatus !== "unknown") {
        stmts.closeAllOpenPresenceSessions.run(now, now, targetId);
    }

    // Open a new session for the new status — but skip if this is the very
    // first observation (unknown) and the user is already offline. In that
    // case there is no meaningful "start" to record; the next real transition
    // (offline → online) will open a proper session.
    if (!(oldStatus === "unknown" && newStatus === "offline")) {
        stmts.insertPresenceSession.run(targetId, newStatus, platform, now);
    }

    // Only emit a PRESENCE_UPDATE event when the status itself changed.
    // A platform-only change (e.g. desktop → mobile while staying DND) produces
    // "dnd → dnd" in the timeline which is noise — emit PLATFORM_SWITCH only.
    if (oldStatus !== newStatus) {
        const eventData = JSON.stringify({
            oldStatus,
            newStatus,
            platform,
            oldPlatform,
            clientStatus,
        });
        stmts.insertEvent.run(targetId, "PRESENCE_UPDATE", now, eventData, null, null);
        evaluateEvent("PRESENCE_UPDATE", targetId, eventData, now);
        pushSSEEvent({
            target_id:  targetId,
            event_type: "PRESENCE_UPDATE",
            timestamp:  now,
            data: { oldStatus, newStatus, platform, oldPlatform, clientStatus },
        });
        log.debug(`${targetId}: ${oldStatus} -> ${newStatus} (${platform || "unknown"})`);
    }

    // Track platform switch (independent of status change — can fire alone or together)
    if (oldPlatform !== platform && (oldPlatform || platform)) {
        const switchData = JSON.stringify({ from: oldPlatform, to: platform });
        stmts.insertEvent.run(targetId, "PLATFORM_SWITCH", now, switchData, null, null);
        pushSSEEvent({
            target_id:  targetId,
            event_type: "PLATFORM_SWITCH",
            timestamp:  now,
            data: { from: oldPlatform, to: platform },
        });
        log.debug(`${targetId}: platform ${oldPlatform ?? "none"} -> ${platform ?? "none"} (${newStatus})`);
    }

    currentPresence.set(targetId, { status: newStatus, platform, clientStatus });
}

/** Drop the in-memory presence state for a target. Called when a target is deleted. */
export function removeTargetState(targetId: string): void {
    currentPresence.delete(targetId);
}

export function initPresence(targetId: string, data: any): void {
    const status       = data.status || "offline";
    const clientStatus = data.client_status || null;
    const platform     = getPlatform(clientStatus);
    const now          = Date.now();

    currentPresence.set(targetId, { status, platform, clientStatus });

    // Only open a session for non-offline states
    if (status !== "offline") {
        const stmts = getStmts();
        stmts.insertPresenceSession.run(targetId, status, platform, now);
        const eventData = JSON.stringify({ status, platform, clientStatus, midSession: true });
        stmts.insertEvent.run(targetId, "INITIAL_PRESENCE", now, eventData, null, null);
        // Do NOT push INITIAL_PRESENCE to SSE — it fires during reconnect/chunk processing
        // and would spam the live feed with stale state. Only real changes get SSE events.
        log.debug(`${targetId}: initial presence ${status} (${platform || "unknown"})`);
    } else {
        log.debug(`${targetId}: initial presence offline (no session opened)`);
    }
}