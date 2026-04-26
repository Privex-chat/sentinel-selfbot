import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("GuildMember");

interface CachedMemberData {
    nick: string | null;
    roles: string[];
}

const memberCache: Map<string, CachedMemberData> = new Map();

function cacheKey(targetId: string, guildId: string): string {
    return `${targetId}:${guildId}`;
}

export function handleGuildMemberUpdate(targetId: string, guildId: string, data: any): void {
    const stmts = getStmts();
    const now = Date.now();
    const key = cacheKey(targetId, guildId);

    const newNick = data.nick || null;
    const newRoles: string[] = data.roles || [];
    const cached = memberCache.get(key);

    if (cached) {
        // Nickname change
        if (cached.nick !== newNick) {
            stmts.insertGuildMemberEvent.run(
                targetId, guildId, "NICKNAME_CHANGE", now,
                cached.nick, newNick
            );
            const eventData = JSON.stringify({
                guildId, oldNick: cached.nick, newNick,
            });
            stmts.insertEvent.run(targetId, "NICKNAME_CHANGE", now, eventData, guildId, null);
            pushSSEEvent({
                target_id: targetId,
                event_type: "NICKNAME_CHANGE",
                timestamp: now,
                data: { guildId, oldNick: cached.nick, newNick },
            });
            log.info(`${targetId}: nickname in ${guildId}: "${cached.nick}" -> "${newNick}"`);
        }

        // Role changes
        const oldRoles = new Set(cached.roles);
        const newRolesSet = new Set(newRoles);

        for (const role of newRoles) {
            if (!oldRoles.has(role)) {
                stmts.insertGuildMemberEvent.run(
                    targetId, guildId, "ROLE_ADD", now, null, role
                );
                const eventData = JSON.stringify({ guildId, roleId: role });
                stmts.insertEvent.run(targetId, "ROLE_ADD", now, eventData, guildId, null);
                pushSSEEvent({
                    target_id: targetId,
                    event_type: "ROLE_ADD",
                    timestamp: now,
                    data: { guildId, roleId: role },
                });
                log.debug(`${targetId}: role added ${role} in ${guildId}`);
            }
        }

        for (const role of cached.roles) {
            if (!newRolesSet.has(role)) {
                stmts.insertGuildMemberEvent.run(
                    targetId, guildId, "ROLE_REMOVE", now, role, null
                );
                const eventData = JSON.stringify({ guildId, roleId: role });
                stmts.insertEvent.run(targetId, "ROLE_REMOVE", now, eventData, guildId, null);
                pushSSEEvent({
                    target_id: targetId,
                    event_type: "ROLE_REMOVE",
                    timestamp: now,
                    data: { guildId, roleId: role },
                });
                log.debug(`${targetId}: role removed ${role} in ${guildId}`);
            }
        }
    }

    memberCache.set(key, { nick: newNick, roles: newRoles });
}

export function initMemberData(targetId: string, guildId: string, data: any): void {
    const key = cacheKey(targetId, guildId);
    memberCache.set(key, {
        nick: data.nick || null,
        roles: data.roles || [],
    });
}