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
    const guildId = data.guild_id || "";
    const selfMute = !!data.self_mute;
    const selfDeaf = !!data.self_deaf;
    const serverMute = !!data.mute;
    const serverDeaf = !!data.deaf;
    const streaming = !!data.self_stream;

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

        openVoiceSession(targetId, guildId, newChannelId, null, now, selfMute, selfDeaf, serverMute, serverDeaf, streaming);
        const joinData = JSON.stringify({ guildId, channelId: newChannelId });
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
        openVoiceSession(targetId, guildId, newChannelId, null, now, selfMute, selfDeaf, serverMute, serverDeaf, streaming);

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