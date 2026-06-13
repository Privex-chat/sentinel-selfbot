import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { evaluateEvent } from "../alerts/engine";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("Typing");

interface PendingTyping {
    rowId: number;
    timeout: NodeJS.Timeout;
    timestamp: number;
    channelId: string;
    guildId: string | null;
}

const pendingTyping: Map<string, PendingTyping> = new Map();
const typingCooldowns: Map<string, number> = new Map();
const GHOST_TIMEOUT_MS = 15000;
const COOLDOWN_MS = 5000;
const COOLDOWN_EVICT_INTERVAL_MS = 60_000;
// Cooldown entries are dead once `2 × COOLDOWN_MS` has passed without a new
// TYPING_START in that channel. Prune them so the Map doesn't grow forever as
// the bot observes new (target, channel) pairs over multi-week uptimes.
const cooldownEvictTimer = setInterval(() => {
    const cutoff = Date.now() - COOLDOWN_MS * 2;
    for (const [key, ts] of typingCooldowns) {
        if (ts < cutoff) typingCooldowns.delete(key);
    }
}, COOLDOWN_EVICT_INTERVAL_MS);
cooldownEvictTimer.unref?.();

function typingKey(userId: string, channelId: string): string {
    return `${userId}:${channelId}`;
}

/**
 * Cancel every armed ghost-typing timer.
 *
 * Called from the gateway "close" listener so that pending GHOST_TYPE events
 * don't fire while the connection is down. Without this, a 15s timeout armed
 * just before a disconnect would still trip its setTimeout while we're
 * offline, recording a "ghost type" that may not have actually happened (the
 * user may have sent the message but we never saw the MESSAGE_CREATE).
 *
 * Does NOT clear the cooldown map — those are TTL'd separately and re-arming
 * them on reconnect is correct.
 */
export function cancelAllPendingTyping(): void {
    if (pendingTyping.size === 0) return;
    let cleared = 0;
    for (const pending of pendingTyping.values()) {
        clearTimeout(pending.timeout);
        cleared++;
    }
    pendingTyping.clear();
    log.debug(`Cleared ${cleared} pending ghost-type timer(s) on gateway disconnect`);
}

/** Drop every pending-typing timeout and cooldown entry for this target. */
export function removeTargetState(targetId: string): void {
    const prefix = `${targetId}:`;
    for (const [key, pending] of pendingTyping) {
        if (key.startsWith(prefix)) {
            clearTimeout(pending.timeout);
            pendingTyping.delete(key);
        }
    }
    for (const key of typingCooldowns.keys()) {
        if (key.startsWith(prefix)) typingCooldowns.delete(key);
    }
}

export function handleTypingStart(targetId: string, channelId: string, guildId: string | null): void {
    const stmts = getStmts();
    const now = Date.now();
    const key = typingKey(targetId, channelId);

    // Cooldown check
    const lastTyping = typingCooldowns.get(key) || 0;
    if (now - lastTyping < COOLDOWN_MS) return;
    typingCooldowns.set(key, now);

    // Clear existing pending for this key
    const existing = pendingTyping.get(key);
    if (existing) {
        clearTimeout(existing.timeout);
    }

    // Insert typing event
    const result = stmts.insertTypingEvent.run(targetId, channelId, guildId, now);
    const rowId = Number(result.lastInsertRowid);

    // Set ghost detection timeout
    const timeout = setTimeout(() => {
        pendingTyping.delete(key);
        log.debug(`${targetId}: ghost typed in ${channelId}`);

        const ghostNow = Date.now();
        const eventData = JSON.stringify({ channelId, guildId, ghost: true });
        stmts.insertEvent.run(targetId, "GHOST_TYPE", ghostNow, eventData, guildId, channelId);
        evaluateEvent("GHOST_TYPE", targetId, eventData, ghostNow);

        // Push ghost type to live SSE feed
        pushSSEEvent({
            target_id: targetId,
            event_type: "GHOST_TYPE",
            timestamp: ghostNow,
            data: { channelId, guildId, ghost: true },
        });
    }, GHOST_TIMEOUT_MS);

    pendingTyping.set(key, { rowId, timeout, timestamp: now, channelId, guildId });
    log.debug(`${targetId}: typing in ${channelId}`);
}

export function resolveTypingWithMessage(targetId: string, channelId: string): void {
    const stmts = getStmts();
    const key = typingKey(targetId, channelId);
    const pending = pendingTyping.get(key);

    if (pending) {
        clearTimeout(pending.timeout);
        const delayMs = Date.now() - pending.timestamp;
        stmts.updateTypingResult.run(delayMs, pending.rowId);
        pendingTyping.delete(key);
        log.debug(`${targetId}: typing resolved with message (${delayMs}ms)`);
    }
}

export function getGhostTypingRate(targetId: string, limit: number = 100): number {
    const stmts = getStmts();
    const events = stmts.getTypingEvents.all(targetId, limit) as any[];
    if (events.length === 0) return 0;
    const ghosts = events.filter((e: any) => !e.resulted_in_message).length;
    return ghosts / events.length;
}