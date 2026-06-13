import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { evaluateEvent } from "../alerts/engine";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("Voice");

interface VoiceState {
    guildId: string;
    channelId: string;
    channelName?: string;
    selfMute: boolean;
    selfDeaf: boolean;
    serverMute: boolean;
    serverDeaf: boolean;
    streaming: boolean;
    dbSessionId?: number;
}

const currentVoiceState: Map<string, VoiceState> = new Map();
const coParticipantCache: Map<string, Set<string>> = new Map();

export function getCurrentVoiceState(targetId: string): VoiceState | undefined {
    return currentVoiceState.get(targetId);
}

export function handleVoiceStateUpdate(targetId: string, data: any): void {
    const stmts = getStmts();
    const now = Date.now();
    const current = currentVoiceState.get(targetId);

    const newChannelId = data.channel_id || null;
    const guildId: string | null = data.guild_id || null;
    const selfMute = !!data.self_mute;
    const selfDeaf = !!data.self_deaf;
    const serverMute = !!data.mute;
    const serverDeaf = !!data.deaf;
    const streaming = !!data.self_stream;

    // Skip DM voice (no guild_id). voice_sessions.guild_id is NOT NULL; the
    // previous behaviour stored "" which produced ghost guildless rows that
    // never matched any per-guild filter. DMs and group-DM voice are routed
    // through a separate Discord subsystem we don't track here.
    if (newChannelId && !guildId) {
        log.debug(`${targetId}: skipping DM voice update (no guild_id)`);
        return;
    }

    // User left voice
    if (!newChannelId) {
        if (current) {
            closeVoiceSession(targetId, current, now);
            currentVoiceState.delete(targetId);

            const leaveData = JSON.stringify({
                guildId: current.guildId,
                channelId: current.channelId,
            });
            stmts.insertEvent.run(targetId, "VOICE_LEAVE", now, leaveData, current.guildId, current.channelId);
            evaluateEvent("VOICE_LEAVE", targetId, leaveData, now);
            pushSSEEvent({
                target_id: targetId,
                event_type: "VOICE_LEAVE",
                timestamp: now,
                data: { guildId: current.guildId, channelId: current.channelId },
            });
            log.debug(`${targetId}: left voice ${current.channelId}`);
        }
        return;
    }

    // User moved channels
    if (current && current.channelId !== newChannelId) {
        closeVoiceSession(targetId, current, now);

        const moveData = JSON.stringify({
            fromChannel: current.channelId,
            toChannel: newChannelId,
            guildId,
        });
        stmts.insertEvent.run(targetId, "VOICE_MOVE", now, moveData, guildId, newChannelId);
        pushSSEEvent({
            target_id: targetId,
            event_type: "VOICE_MOVE",
            timestamp: now,
            data: { fromChannel: current.channelId, toChannel: newChannelId, guildId },
        });
        log.debug(`${targetId}: moved voice ${current.channelId} -> ${newChannelId}`);

        // guildId is non-null in this branch: we returned earlier when
        // newChannelId is truthy but guildId is null (DM voice guard).
        openVoiceSession(targetId, guildId!, newChannelId, null, now, selfMute, selfDeaf, serverMute, serverDeaf, streaming);
        const joinData = JSON.stringify({ guildId, channelId: newChannelId });
        stmts.insertEvent.run(targetId, "VOICE_JOIN", now, joinData, guildId, newChannelId);
        evaluateEvent("VOICE_JOIN", targetId, joinData, now);
        pushSSEEvent({
            target_id: targetId,
            event_type: "VOICE_JOIN",
            timestamp: now,
            data: { guildId, channelId: newChannelId },
        });
        return;
    }

    // User joined voice (no previous state)
    if (!current) {
        // guildId is non-null: same DM-voice guard above.
        openVoiceSession(targetId, guildId!, newChannelId, null, now, selfMute, selfDeaf, serverMute, serverDeaf, streaming);

        const joinData = JSON.stringify({ guildId, channelId: newChannelId });
        stmts.insertEvent.run(targetId, "VOICE_JOIN", now, joinData, guildId, newChannelId);
        evaluateEvent("VOICE_JOIN", targetId, joinData, now);
        pushSSEEvent({
            target_id: targetId,
            event_type: "VOICE_JOIN",
            timestamp: now,
            data: { guildId, channelId: newChannelId },
        });
        log.debug(`${targetId}: joined voice ${newChannelId}`);
        return;
    }

    // State changes (mute/deafen/stream) within same channel
    if (current.channelId === newChannelId) {
        const changes: string[] = [];

        if (current.selfMute !== selfMute) changes.push(`selfMute: ${selfMute}`);
        if (current.selfDeaf !== selfDeaf) changes.push(`selfDeaf: ${selfDeaf}`);
        if (current.serverMute !== serverMute) changes.push(`serverMute: ${serverMute}`);
        if (current.serverDeaf !== serverDeaf) changes.push(`serverDeaf: ${serverDeaf}`);
        if (current.streaming !== streaming) changes.push(`streaming: ${streaming}`);

        if (changes.length > 0 && current.dbSessionId) {
            stmts.updateVoiceSessionState.run(
                selfMute ? 1 : 0, selfDeaf ? 1 : 0,
                serverMute ? 1 : 0, serverDeaf ? 1 : 0,
                streaming ? 1 : 0, current.dbSessionId
            );

            const stateData = JSON.stringify({
                channelId: newChannelId, guildId, changes,
                selfMute, selfDeaf, serverMute, serverDeaf, streaming,
            });
            stmts.insertEvent.run(targetId, "VOICE_STATE_CHANGE", now, stateData, guildId, newChannelId);
            pushSSEEvent({
                target_id: targetId,
                event_type: "VOICE_STATE_CHANGE",
                timestamp: now,
                data: { channelId: newChannelId, guildId, changes, selfMute, selfDeaf, serverMute, serverDeaf, streaming },
            });
            log.debug(`${targetId}: voice state change - ${changes.join(", ")}`);
        }

        current.selfMute = selfMute;
        current.selfDeaf = selfDeaf;
        current.serverMute = serverMute;
        current.serverDeaf = serverDeaf;
        current.streaming = streaming;
    }
}

function openVoiceSession(
    targetId: string, guildId: string, channelId: string, channelName: string | null,
    now: number, selfMute: boolean, selfDeaf: boolean, serverMute: boolean, serverDeaf: boolean, streaming: boolean
): void {
    const stmts = getStmts();
    const result = stmts.insertVoiceSession.run(
        targetId, guildId, channelId, channelName, now,
        selfMute ? 1 : 0, selfDeaf ? 1 : 0,
        serverMute ? 1 : 0, serverDeaf ? 1 : 0,
        streaming ? 1 : 0
    );

    currentVoiceState.set(targetId, {
        guildId, channelId, channelName: channelName || undefined,
        selfMute, selfDeaf, serverMute, serverDeaf, streaming,
        dbSessionId: Number(result.lastInsertRowid),
    });
}

function closeVoiceSession(targetId: string, state: VoiceState, now: number): void {
    if (state.dbSessionId) {
        const stmts = getStmts();
        const participants = coParticipantCache.get(targetId);
        const coParticipantsJson = participants ? JSON.stringify([...participants]) : null;
        stmts.closeVoiceSession.run(now, now, coParticipantsJson, state.dbSessionId);
        coParticipantCache.delete(targetId);
    }
}

/** Drop the in-memory voice + co-participant state for a target. */
export function removeTargetState(targetId: string): void {
    currentVoiceState.delete(targetId);
    coParticipantCache.delete(targetId);
}

/**
 * Force-close any open voice session for a target.
 *
 * Used by the presence collector when a target transitions to offline (Discord
 * disconnects offline users from voice, but a VOICE_STATE_UPDATE with null
 * channel_id isn't always delivered during a gateway disconnect), and by the
 * RESUMED handler to clean up sessions whose closing events were missed.
 *
 * No-op when no open session exists. Clears the in-memory state map alongside
 * the DB row so subsequent VOICE_STATE_UPDATEs see a clean slate.
 */
export function closeOpenVoiceForTarget(targetId: string, reason: string): void {
    const state = currentVoiceState.get(targetId);
    const stmts = getStmts();
    const now = Date.now();

    // Always run the DB-side close even if our in-memory state is empty — there
    // may be a row left over from before a restart that the in-memory map never
    // tracked. Returns the row count so we can decide whether to emit an event.
    const result = stmts.closeOpenVoiceSessionsForTarget.run(now, now, targetId);

    if (result.changes > 0) {
        // Emit a synthetic VOICE_LEAVE event so analytics + alerts see the close.
        const guildId = state?.guildId ?? null;
        const channelId = state?.channelId ?? null;
        const leaveData = JSON.stringify({ guildId, channelId, reason });
        stmts.insertEvent.run(targetId, "VOICE_LEAVE", now, leaveData, guildId, channelId);
        log.info(`${targetId}: force-closed ${result.changes} open voice session(s) — ${reason}`);
    }

    currentVoiceState.delete(targetId);
    coParticipantCache.delete(targetId);
}

/**
 * On RESUMED, scan every open voice_session and close any whose target is
 * cached as offline. The Discord client never sees those mid-session leaves
 * because the gateway was disconnected when they happened; without this,
 * sessions can stay "open" indefinitely until the next manual VOICE_STATE_UPDATE
 * (which may never come if the user stays offline).
 *
 * Targets we cached as online/idle/dnd are left alone — they're likely still in
 * voice and we'd lose minutes of valid co-presence time by closing them.
 *
 * Takes a `getPresence` callback rather than importing presence directly so
 * voice → presence stays a one-way dep (presence is already the importer).
 */
export function reconcileOpenVoiceSessions(
    getPresence: (targetId: string) => { status: string } | undefined
): void {
    const stmts = getStmts();
    const rows = stmts.getAllOpenVoiceSessions.all() as Array<{ target_id: string }>;

    const offlineTargets = new Set<string>();
    for (const row of rows) {
        const presence = getPresence(row.target_id);
        // Treat "missing presence cache entry" as offline too — if we don't even
        // have a presence record, the target very likely isn't in voice either.
        if (!presence || presence.status === "offline") {
            offlineTargets.add(row.target_id);
        }
    }

    for (const targetId of offlineTargets) {
        try { closeOpenVoiceForTarget(targetId, "RESUMED reconcile (cached offline)"); }
        catch (err: any) { log.warn(`voice RESUMED close failed for ${targetId}: ${err.message}`); }
    }

    if (offlineTargets.size > 0) {
        log.info(`Voice reconcile: closed ${offlineTargets.size} stale session(s) after RESUMED`);
    }
}

export function updateCoParticipants(targetId: string, participants: string[]): void {
    const existing = coParticipantCache.get(targetId) || new Set();
    for (const p of participants) {
        existing.add(p);
    }
    coParticipantCache.set(targetId, existing);

    const state = currentVoiceState.get(targetId);
    if (state?.dbSessionId) {
        const stmts = getStmts();
        stmts.updateVoiceCoParticipants.run(JSON.stringify([...existing]), state.dbSessionId);
    }
}