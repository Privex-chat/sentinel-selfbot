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

function typingKey(userId: string, channelId: string): string {
    return `${userId}:${channelId}`;
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