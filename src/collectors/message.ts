import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { resolveTypingWithMessage } from "./typing";

const log = createLogger("Message");

const UNICODE_EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
const CUSTOM_EMOJI_REGEX = /<a?:\w+:\d+>/g;
const MENTION_REGEX = /<@!?\d+>/g;
const URL_REGEX = /https?:\/\/[^\s<]+/g;

function analyzeContent(content: string) {
    const words = content.trim().split(/\s+/).filter(w => w.length > 0);
    const unicodeEmoji = content.match(UNICODE_EMOJI_REGEX) || [];
    const customEmoji = content.match(CUSTOM_EMOJI_REGEX) || [];
    const mentions = content.match(MENTION_REGEX) || [];
    const links = content.match(URL_REGEX) || [];

    return {
        wordCount: words.length,
        emojiCount: unicodeEmoji.length + customEmoji.length,
        mentionCount: mentions.length,
        linkCount: links.length,
    };
}

export interface MessageCreateResult {
    /** Processed event payload (JSON string). Empty when inserted === false. */
    eventData: string;
    /** True only when the row was actually inserted (not a duplicate). */
    inserted: boolean;
}

export function handleMessageCreate(
    targetId: string,
    message: any,
    guildId: string | null,
    source: "live" | "backfilled" = "live"
): MessageCreateResult {
    const stmts = getStmts();
    const now = Date.now();
    const content = (message.content || "").substring(0, 2000);
    const analysis = analyzeContent(content);

    const isReply = !!(message.message_reference?.message_id);
    const replyToUserId = message.referenced_message?.author?.id || null;
    const replyToMessageId = message.message_reference?.message_id || null;
    const attachmentCount = message.attachments?.length || 0;
    const embedCount = message.embeds?.length || 0;
    const hasSticker = message.sticker_items?.length > 0 ? 1 : 0;
    const createdAt = message.timestamp ? new Date(message.timestamp).getTime() : now;

    const result = stmts.insertMessage.run(
        message.id,
        targetId,
        message.channel_id,
        guildId,
        content,
        content.length,
        attachmentCount,
        embedCount,
        hasSticker,
        isReply ? 1 : 0,
        replyToUserId,
        replyToMessageId,
        createdAt,
        analysis.wordCount,
        analysis.emojiCount,
        analysis.mentionCount,
        analysis.linkCount,
        source
    );

    // INSERT OR IGNORE: duplicate (e.g. backfill re-seen a message already saved
    // by a live event). Skip the side effects so we don't double-count, double-
    // fire MESSAGE_CREATE event rows, double-evaluate alerts, or wrongly resolve
    // a pending typing event from an old message.
    if (result.changes === 0) {
        log.debug(`${targetId}: skipping duplicate message ${message.id} (${source})`);
        return { eventData: "", inserted: false };
    }

    const eventData = JSON.stringify({
        messageId: message.id,
        channelId: message.channel_id,
        guildId,
        contentLength: content.length,
        wordCount: analysis.wordCount,
        attachmentCount,
        embedCount,
        isReply,
        replyToUserId,
    });
    stmts.insertEvent.run(targetId, "MESSAGE_CREATE", createdAt, eventData, guildId, message.channel_id);

    // Resolve typing ghost detection
    resolveTypingWithMessage(targetId, message.channel_id);

    log.debug(`${targetId}: ${source} message in ${message.channel_id} (${analysis.wordCount} words)`);
    return { eventData, inserted: true };
}

export function handleMessageUpdate(targetId: string, message: any, guildId: string | null): void {
    const stmts = getStmts();
    const now = Date.now();
    // Prefer Discord's authoritative edited_timestamp when present; fall back to
    // now only when the payload omits it (rare — usually only synthetic updates).
    const editedAt = message.edited_timestamp
        ? new Date(message.edited_timestamp).getTime()
        : now;

    const existing = stmts.getMessage.get(message.id) as any;
    if (!existing) return;

    const newContent = (message.content || "").substring(0, 2000);
    let editHistory: string[] = [];

    try {
        editHistory = existing.edit_history ? JSON.parse(existing.edit_history) : [];
    } catch { }

    if (existing.content && existing.content !== newContent) {
        editHistory.push(existing.content);
    }

    stmts.updateMessageEdited.run(
        newContent,
        newContent.length,
        editedAt,
        JSON.stringify(editHistory),
        message.id
    );

    const eventData = JSON.stringify({
        messageId: message.id,
        channelId: message.channel_id || existing.channel_id,
        oldContentLength: existing.content_length,
        newContentLength: newContent.length,
        editCount: editHistory.length,
    });
    stmts.insertEvent.run(targetId, "MESSAGE_UPDATE", editedAt, eventData, guildId, message.channel_id || existing.channel_id);

    log.debug(`${targetId}: edited message ${message.id} (edit #${editHistory.length})`);
}

/** Returns processed event payload + targetId for the deleted message, or null if not tracked. */
export function handleMessageDelete(
    messageId: string, channelId: string, guildId: string | null
): { targetId: string; eventData: string } | null {
    const stmts = getStmts();
    const now = Date.now();

    const existing = stmts.getMessage.get(messageId) as any;
    if (!existing) return null;

    stmts.markMessageDeleted.run(now, messageId);

    const eventData = JSON.stringify({
        messageId,
        channelId,
        guildId,
        contentLength: existing.content_length,
        wordCount:     existing.word_count,
        hadContent:    !!existing.content,
    });
    stmts.insertEvent.run(existing.target_id, "MESSAGE_DELETE", now, eventData, guildId, channelId);

    log.debug(`${existing.target_id}: deleted message ${messageId}`);
    return { targetId: existing.target_id, eventData };
}
