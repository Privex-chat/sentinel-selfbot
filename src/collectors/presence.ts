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

    // Close the current open presence session
    if (oldStatus !== "unknown") {
        const openSession = stmts.getOpenPresenceSession.get(targetId) as any;
        if (openSession) {
            stmts.closePresenceSession.run(now, now, openSession.id);
        }
    }

    // Open a new session for the new status
    stmts.insertPresenceSession.run(targetId, newStatus, platform, now);

    // Store processed event data (camelCase) for consistency with alert engine
    const eventData = JSON.stringify({
        oldStatus,
        newStatus,
        platform,
        oldPlatform,
        clientStatus,
    });
    stmts.insertEvent.run(targetId, "PRESENCE_UPDATE", now, eventData, null, null);

    // Fire alert evaluation with processed data
    evaluateEvent("PRESENCE_UPDATE", targetId, eventData, now);

    // Push processed event to SSE clients (not raw Discord payload)
    pushSSEEvent({
        target_id:  targetId,
        event_type: "PRESENCE_UPDATE",
        timestamp:  now,
        data: { oldStatus, newStatus, platform, oldPlatform, clientStatus },
    });

    // Track platform switch
    if (oldPlatform && platform && oldPlatform !== platform) {
        const switchData = JSON.stringify({ from: oldPlatform, to: platform });
        stmts.insertEvent.run(targetId, "PLATFORM_SWITCH", now, switchData, null, null);
        pushSSEEvent({
            target_id:  targetId,
            event_type: "PLATFORM_SWITCH",
            timestamp:  now,
            data: { from: oldPlatform, to: platform },
        });
        log.debug(`${targetId} switched platform: ${oldPlatform} -> ${platform}`);
    }

    currentPresence.set(targetId, { status: newStatus, platform, clientStatus });

    log.debug(`${targetId}: ${oldStatus} -> ${newStatus} (${platform || "unknown"})`);
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