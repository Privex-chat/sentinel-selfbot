/**
 * Selfbot command handler
 *
 * Listens for messages sent by the selfbot's own account that begin with the
 * configured prefix (default: "$"). The command message is deleted immediately
 * so no trace remains in the channel. Feedback is sent as a temporary message
 * that also self-deletes after a short TTL.
 *
 * Available commands:
 *   $add <@user | userId>       — add a tracking target
 *   $remove <@user | userId>    — remove a target
 *   $status <@user | userId>    — show current presence & activities
 *   $list                       — list all active targets with live status
 *   $help                       — show command reference
 */

import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { discordFetch } from "../utils/rate-limiter";
import { getDb } from "../database/connection";
import { getStmts } from "../database/queries";
import { startBackfillForTarget } from "../backfill/backfill-engine";
import { requestPresenceForUser } from "../pollers/status-poller";
import { getCurrentPresence } from "../collectors/presence";
import { getCurrentActivities } from "../collectors/activity";

const log = createLogger("Commands");

export const COMMAND_PREFIX = "$";

// Rate limit mirror — same 15-min rule as the API route, to protect the account.
const ADD_RATE_LIMIT_MS = 15 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract a bare user ID from a raw snowflake or a <@123> / <@!123> mention. */
function parseUserId(raw: string): string | null {
    const mention = raw.match(/^<@!?(\d{17,20})>$/);
    if (mention) return mention[1];
    if (/^\d{17,20}$/.test(raw)) return raw;
    return null;
}

/** Delete a Discord message. Swallows errors (message may already be gone). */
async function deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
        await discordFetch(
            `/channels/${channelId}/messages/${messageId}`,
            config.discordToken,
            { method: "DELETE" }
        );
    } catch (e: any) {
        log.debug(`deleteMessage failed: ${e.message}`);
    }
}

/**
 * Send a message to a channel and schedule it for deletion after `ttlMs`.
 * Keeps no permanent trace in the channel.
 */
async function sendTempMessage(
    channelId: string,
    content: string,
    ttlMs = 4_000
): Promise<void> {
    // Discord hard-caps message content at 2 000 chars.
    const body = content.length > 1_990 ? content.slice(0, 1_987) + "…" : content;
    try {
        const res = await discordFetch(
            `/channels/${channelId}/messages`,
            config.discordToken,
            {
                method: "POST",
                body: JSON.stringify({ content: body, tts: false }),
            }
        );
        if (!res.ok) {
            log.debug(`sendTempMessage HTTP ${res.status}`);
            return;
        }
        const msg = await res.json() as { id: string };
        setTimeout(() => deleteMessage(channelId, msg.id), ttlMs);
    } catch (e: any) {
        log.debug(`sendTempMessage failed: ${e.message}`);
    }
}

// ── Command implementations ───────────────────────────────────────────────────

async function cmdAdd(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$add <@user>` or `$add <userId>`");
        return;
    }

    const db = getDb();

    // Check if already tracked
    const existing = db.prepare("SELECT active FROM targets WHERE user_id = ?").get(userId) as
        | { active: number }
        | undefined;
    if (existing) {
        if (existing.active) {
            await sendTempMessage(channelId, `ℹ️ \`${userId}\` is already an active target.`);
        } else {
            // Re-activate a previously removed target
            db.prepare("UPDATE targets SET active = 1 WHERE user_id = ?").run(userId);
            setTimeout(() => requestPresenceForUser(userId), 5_000);
            await sendTempMessage(channelId, `✅ Target \`${userId}\` re-activated.`);
            log.info(`Command: re-activated target ${userId}`);
        }
        return;
    }

    // Respect the same 15-min add rate limit as the API route
    const recent = db
        .prepare("SELECT added_at FROM targets ORDER BY added_at DESC LIMIT 1")
        .get() as { added_at: number } | undefined;
    if (recent) {
        const elapsed = Date.now() - recent.added_at;
        if (elapsed < ADD_RATE_LIMIT_MS) {
            const waitMins = Math.ceil((ADD_RATE_LIMIT_MS - elapsed) / 60_000);
            await sendTempMessage(
                channelId,
                `⏳ Rate limited — adding targets too quickly can flag your account. ` +
                `Wait **${waitMins}** more minute${waitMins === 1 ? "" : "s"}.`
            );
            return;
        }
    }

    const stmts = getStmts();
    stmts.insertTarget.run(userId, Date.now(), null, null, 0, 1);
    setTimeout(() => requestPresenceForUser(userId), 5_000);

    if (config.backfillEnabled) {
        startBackfillForTarget(userId).catch(() => {});
    }

    await sendTempMessage(channelId, `✅ Target \`${userId}\` added. Presence subscription in 5 s.`);
    log.info(`Command: added target ${userId}`);
}

async function cmdRemove(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$remove <@user>` or `$remove <userId>`");
        return;
    }

    const stmts = getStmts();
    const result = getDb()
        .prepare("SELECT active FROM targets WHERE user_id = ?")
        .get(userId) as { active: number } | undefined;

    if (!result) {
        await sendTempMessage(channelId, `❌ \`${userId}\` is not a tracked target.`);
        return;
    }

    stmts.deleteTarget.run(userId);
    await sendTempMessage(channelId, `✅ Target \`${userId}\` removed.`);
    log.info(`Command: removed target ${userId}`);
}

async function cmdStatus(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$status <@user>` or `$status <userId>`");
        return;
    }

    const presence   = getCurrentPresence(userId);
    const activities = getCurrentActivities(userId);

    if (!presence) {
        await sendTempMessage(
            channelId,
            `❓ No presence data for \`${userId}\` yet — may not be tracked or presence not received.`,
            6_000
        );
        return;
    }

    const statusEmoji: Record<string, string> = {
        online: "🟢", idle: "🌙", dnd: "🔴", offline: "⚫",
    };
    const emoji = statusEmoji[presence.status] ?? "❓";

    const activityLines = activities.length
        ? activities.map(a => {
            const typeLabels: Record<number, string> = {
                0: "Playing", 1: "Streaming", 2: "Listening", 3: "Watching",
                4: "Custom", 5: "Competing",
            };
            const label = typeLabels[a.type] ?? `Type ${a.type}`;
            const detail = a.details ? ` — ${a.details}` : "";
            return `  ${label}: **${a.name}**${detail}`;
        }).join("\n")
        : "  none";

    await sendTempMessage(
        channelId,
        `${emoji} \`${userId}\` — **${presence.status}** on **${presence.platform ?? "unknown"}**\n` +
        `🎮 Activities:\n${activityLines}`,
        8_000
    );
}

async function cmdList(channelId: string): Promise<void> {
    const stmts  = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];

    if (!targets.length) {
        await sendTempMessage(channelId, "📋 No active targets.", 5_000);
        return;
    }

    const statusEmoji: Record<string, string> = {
        online: "🟢", idle: "🌙", dnd: "🔴", offline: "⚫",
    };

    const lines = targets.map((t: any) => {
        const p     = getCurrentPresence(t.user_id);
        const emoji = statusEmoji[p?.status ?? ""] ?? "❓";
        const label = t.label ? ` (${t.label})` : "";
        return `${emoji} \`${t.user_id}\`${label} — ${p?.status ?? "unknown"}${p?.platform ? ` / ${p.platform}` : ""}`;
    });

    await sendTempMessage(
        channelId,
        `📋 **Active targets (${targets.length}):**\n${lines.join("\n")}`,
        10_000
    );
}

async function cmdHelp(channelId: string): Promise<void> {
    await sendTempMessage(
        channelId,
        "**Sentinel Commands** *(auto-delete in 10 s)*\n" +
        "`$add <@user>`    — add tracking target\n" +
        "`$remove <@user>` — remove target\n" +
        "`$status <@user>` — current presence & activities\n" +
        "`$list`           — list all active targets with live status\n" +
        "`$help`           — show this reference",
        10_000
    );
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Call from the MESSAGE_CREATE gateway handler.
 * Returns true if the message was a self-command (and was therefore handled +
 * deleted), false if it should fall through to normal processing.
 */
export async function handleSelfCommand(
    selfUserId: string,
    message: {
        id:         string;
        channel_id: string;
        content:    string;
        author:     { id: string } | null | undefined;
    }
): Promise<boolean> {
    if (message.author?.id !== selfUserId) return false;
    if (!message.content?.startsWith(COMMAND_PREFIX)) return false;

    const raw     = message.content.slice(COMMAND_PREFIX.length).trim();
    const parts   = raw.split(/\s+/);
    const command = parts[0]?.toLowerCase() ?? "";
    const args    = parts.slice(1);
    const { id: messageId, channel_id: channelId } = message;

    // Delete the triggering message immediately — before executing so it's gone
    // even if the command handler throws.
    await deleteMessage(channelId, messageId);

    log.info(`Self-command: $${command} ${args.join(" ")}`.trimEnd());

    try {
        switch (command) {
            case "add":    await cmdAdd(channelId, args);    break;
            case "remove": await cmdRemove(channelId, args); break;
            case "status": await cmdStatus(channelId, args); break;
            case "list":   await cmdList(channelId);          break;
            case "help":   await cmdHelp(channelId);          break;
            default:
                // Unknown prefix match — silently deleted, no response.
                log.debug(`Unknown command: ${command}`);
                break;
        }
    } catch (err: any) {
        log.error(`Command $${command} error: ${err.message}`);
        // Best-effort error message — also self-deletes.
        await sendTempMessage(channelId, `⚠️ Command failed: ${err.message}`, 6_000);
    }

    return true;
}
