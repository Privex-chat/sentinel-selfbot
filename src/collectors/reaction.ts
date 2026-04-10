import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("Reaction");

export function handleReactionAdd(
    targetId: string,
    messageId: string,
    messageAuthorId: string | null,
    channelId: string,
    guildId: string | null,
    emoji: { name: string; id?: string | null },
): void {
    const stmts = getStmts();
    const now = Date.now();
    const isCustom = !!emoji.id;

    stmts.insertReaction.run(
        targetId, messageId, messageAuthorId, channelId, guildId,
        emoji.name, emoji.id || null, isCustom ? 1 : 0, now
    );

    const eventData = JSON.stringify({
        messageId, channelId, guildId, messageAuthorId,
        emoji: emoji.name, emojiId: emoji.id || null, isCustom,
    });
    stmts.insertEvent.run(targetId, "REACTION_ADD", now, eventData, guildId, channelId);

    log.debug(`${targetId}: reacted ${emoji.name} on ${messageId}`);
}

export function handleReactionRemove(
    targetId: string,
    messageId: string,
    channelId: string,
    guildId: string | null,
    emoji: { name: string; id?: string | null },
): void {
    const stmts = getStmts();
    const now = Date.now();

    stmts.removeReaction.run(now, targetId, messageId, emoji.name);

    const eventData = JSON.stringify({
        messageId, channelId, guildId,
        emoji: emoji.name, emojiId: emoji.id || null,
    });
    stmts.insertEvent.run(targetId, "REACTION_REMOVE", now, eventData, guildId, channelId);

    log.debug(`${targetId}: un-reacted ${emoji.name} on ${messageId}`);
}
