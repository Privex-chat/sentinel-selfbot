/**
 * Selfbot command handler
 *
 * Listens for messages sent by the selfbot's own account that begin with the
 * configured prefix (default: "$"). The command message is deleted immediately
 * so no trace remains in the channel. Feedback is sent as a temporary message
 * that also self-deletes after a short TTL.
 *
 * Commands:
 *   $add    <@user>        — add tracking target
 *   $remove <@user>        — remove target (deletes all history)
 *   $pause  <@user>        — suspend tracking without deleting history
 *   $resume <@user>        — re-activate a paused target
 *   $label  <@user> <text> — set display label for a target
 *   $note   <@user> <text> — append a timestamped note to a target
 *   $tz     <@user> [tz]   — set or show the target's IANA timezone (default UTC)
 *   $status <@user>        — current presence & activities
 *   $seen   <@user>        — when the target was last online
 *   $uptime <@user>        — today's total active time
 *   $streak <@user>        — how long in current status uninterrupted
 *   $history <@user> [n]   — last N presence transitions (default 10)
 *   $pattern <@user>       — hourly activity heatmap (last 30 days)
 *   $list                  — all active targets with live status
 *   $ping                  — REST + gateway latency check
 *   $stats                 — system stats
 *   $reload                — reload alert rules & runtime config
 *   $help                  — command reference
 */

import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { discordFetch } from "../utils/rate-limiter";
import { isValidTimezone } from "../utils/timezone";
import { getDb } from "../database/connection";
import { getStmts } from "../database/queries";
import { startBackfillForTarget } from "../backfill/backfill-engine";
import { requestPresenceForUser } from "../pollers/status-poller";
import { getCurrentPresence } from "../collectors/presence";
import { getCurrentActivities } from "../collectors/activity";
import { reloadRules } from "../alerts/engine";
import { loadRuntimeConfig, triggerAllConfigListeners } from "../runtime-config";
import { onTargetRemoved, refreshTargetCache } from "../target-lifecycle";
import type { GatewayClient } from "../gateway/client";

const log = createLogger("Commands");

export const COMMAND_PREFIX = "$";

// Same 15-min rate limit as the API route.
const ADD_RATE_LIMIT_MS = 15 * 60 * 1_000;

// Gateway client reference — set by index.ts after the client is created.
let gatewayRef: GatewayClient | null = null;
export function setGatewayRef(client: GatewayClient): void {
    gatewayRef = client;
}

// ── Shared utilities ──────────────────────────────────────────────────────────

const STATUS_EMOJI: Record<string, string> = {
    online: "🟢", idle: "🌙", dnd: "🔴", offline: "⚫",
};

const ACTIVITY_LABELS: Record<number, string> = {
    0: "Playing", 1: "Streaming", 2: "Listening",
    3: "Watching", 4: "Custom",   5: "Competing",
};

/** Extract a bare user ID from a raw snowflake or <@123> / <@!123> mention. */
function parseUserId(raw: string): string | null {
    const m = raw.match(/^<@!?(\d{17,20})>$/);
    if (m) return m[1];
    if (/^\d{17,20}$/.test(raw)) return raw;
    return null;
}

/** Human-readable duration from milliseconds. */
function fmtDuration(ms: number): string {
    const s = Math.floor(ms / 1_000);
    const h = Math.floor(s / 3_600);
    const m = Math.floor((s % 3_600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

/** "14 minutes ago", "2h 5m ago", "3 days ago". */
function timeAgo(ms: number): string {
    const diff  = Date.now() - ms;
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (days  > 0) return `${days}d ${Math.floor((diff % 86_400_000) / 3_600_000)}h ago`;
    if (hours > 0) return `${hours}h ${Math.floor((diff % 3_600_000) / 60_000)}m ago`;
    if (mins  > 0) return `${mins}m ago`;
    return "just now";
}

/** HH:MM in local time. */
function fmtTime(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** YYYY-MM-DD HH:MM in local time. */
function fmtDateTime(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${fmtTime(ms)}`;
}

/**
 * Delete a Discord message. Failures are surfaced at WARN level: a self-command
 * that we couldn't delete is the path the README's "no trace remains" promise
 * relies on. If this fires repeatedly the operator should know — likely token
 * issue, missing channel permission, or a 4xx that hints at account-flag risk.
 * The previous DEBUG level meant these silently passed at default LOG_LEVEL=info.
 */
async function deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
        const res = await discordFetch(
            `/channels/${channelId}/messages/${messageId}`,
            config.discordToken,
            { method: "DELETE" }
        );
        if (!res.ok && res.status !== 404) {
            // 404 is fine — message was already gone (e.g. user deleted it
            // manually faster than the command pipeline).
            log.warn(
                `deleteMessage: HTTP ${res.status} on channel ${channelId} message ${messageId}. ` +
                `Command may have left a visible trace.`
            );
        }
    } catch (e: any) {
        log.warn(`deleteMessage threw on channel ${channelId} message ${messageId}: ${e.message}`);
    }
}

/**
 * Send a message that auto-deletes after `ttlMs`.
 * Content is truncated to Discord's 2 000-char limit if needed.
 */
async function sendTempMessage(
    channelId: string,
    content: string,
    ttlMs = 4_000
): Promise<void> {
    const body = content.length > 1_990 ? content.slice(0, 1_987) + "…" : content;
    try {
        const res = await discordFetch(
            `/channels/${channelId}/messages`,
            config.discordToken,
            { method: "POST", body: JSON.stringify({ content: body, tts: false }) }
        );
        if (!res.ok) { log.debug(`sendTempMessage HTTP ${res.status}`); return; }
        const msg = await res.json() as { id: string };
        setTimeout(() => deleteMessage(channelId, msg.id), ttlMs);
    } catch (e: any) {
        log.debug(`sendTempMessage failed: ${e.message}`);
    }
}

// ── Target management ─────────────────────────────────────────────────────────

async function cmdAdd(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$add <@user>` or `$add <userId>`");
        return;
    }

    const db = getDb();
    const existing = db.prepare("SELECT active FROM targets WHERE user_id = ?")
        .get(userId) as { active: number } | undefined;

    if (existing) {
        if (existing.active) {
            await sendTempMessage(channelId, `ℹ️ \`${userId}\` is already an active target.`);
        } else {
            db.prepare("UPDATE targets SET active = 1 WHERE user_id = ?").run(userId);
            refreshTargetCache();
            setTimeout(() => requestPresenceForUser(userId), 5_000);
            await sendTempMessage(channelId, `✅ Target \`${userId}\` re-activated.`);
            log.info(`Command: re-activated target ${userId}`);
        }
        return;
    }

    const recent = db.prepare("SELECT added_at FROM targets ORDER BY added_at DESC LIMIT 1")
        .get() as { added_at: number } | undefined;
    if (recent) {
        const elapsed = Date.now() - recent.added_at;
        if (elapsed < ADD_RATE_LIMIT_MS) {
            const waitMins = Math.ceil((ADD_RATE_LIMIT_MS - elapsed) / 60_000);
            await sendTempMessage(
                channelId,
                `⏳ Rate limited — wait **${waitMins}** more minute${waitMins === 1 ? "" : "s"} ` +
                `to avoid flagging your account.`
            );
            return;
        }
    }

    getStmts().insertTarget.run(userId, Date.now(), null, null, 0, 1, "UTC");
    refreshTargetCache();
    setTimeout(() => requestPresenceForUser(userId), 5_000);
    if (config.backfillEnabled) startBackfillForTarget(userId).catch(() => {});

    await sendTempMessage(channelId, `✅ Target \`${userId}\` added. Presence subscription in 5 s. (Timezone defaults to UTC — set with \`$tz\`.)`);
    log.info(`Command: added target ${userId}`);
}

async function cmdRemove(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$remove <@user>` or `$remove <userId>`");
        return;
    }

    const row = getDb().prepare("SELECT user_id FROM targets WHERE user_id = ?")
        .get(userId) as { user_id: string } | undefined;
    if (!row) {
        await sendTempMessage(channelId, `❌ \`${userId}\` is not a tracked target.`);
        return;
    }

    getStmts().deleteTarget.run(userId);
    // Wipe the in-memory caches that the SQL cascade does not touch.
    onTargetRemoved(userId);
    await sendTempMessage(channelId, `✅ Target \`${userId}\` removed.`);
    log.info(`Command: removed target ${userId}`);
}

async function cmdPause(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$pause <@user>` or `$pause <userId>`");
        return;
    }

    const row = getDb().prepare("SELECT active FROM targets WHERE user_id = ?")
        .get(userId) as { active: number } | undefined;
    if (!row) {
        await sendTempMessage(channelId, `❌ \`${userId}\` is not a tracked target.`);
        return;
    }
    if (!row.active) {
        await sendTempMessage(channelId, `ℹ️ \`${userId}\` is already paused.`);
        return;
    }

    getDb().prepare("UPDATE targets SET active = 0 WHERE user_id = ?").run(userId);
    refreshTargetCache();
    await sendTempMessage(channelId, `⏸ Target \`${userId}\` paused. History preserved. Use \`$resume\` to re-activate.`);
    log.info(`Command: paused target ${userId}`);
}

async function cmdResume(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$resume <@user>` or `$resume <userId>`");
        return;
    }

    const row = getDb().prepare("SELECT active FROM targets WHERE user_id = ?")
        .get(userId) as { active: number } | undefined;
    if (!row) {
        await sendTempMessage(channelId, `❌ \`${userId}\` is not a tracked target. Use \`$add\` first.`);
        return;
    }
    if (row.active) {
        await sendTempMessage(channelId, `ℹ️ \`${userId}\` is already active.`);
        return;
    }

    getDb().prepare("UPDATE targets SET active = 1 WHERE user_id = ?").run(userId);
    refreshTargetCache();
    setTimeout(() => requestPresenceForUser(userId), 5_000);
    await sendTempMessage(channelId, `▶️ Target \`${userId}\` resumed. Presence subscription in 5 s.`);
    log.info(`Command: resumed target ${userId}`);
}

async function cmdLabel(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId || args.length < 2) {
        await sendTempMessage(channelId, "❌ Usage: `$label <@user> <text>`");
        return;
    }

    const row = getDb().prepare("SELECT user_id FROM targets WHERE user_id = ?")
        .get(userId) as { user_id: string } | undefined;
    if (!row) {
        await sendTempMessage(channelId, `❌ \`${userId}\` is not a tracked target.`);
        return;
    }

    const label = args.slice(1).join(" ").slice(0, 100); // cap at 100 chars
    getDb().prepare("UPDATE targets SET label = ? WHERE user_id = ?").run(label, userId);
    await sendTempMessage(channelId, `🏷 Label set: \`${userId}\` → **${label}**`);
    log.info(`Command: set label for ${userId}: "${label}"`);
}

// Cumulative cap on the per-target notes column. Notes are append-only;
// without a cap the column grows unbounded and eventually shows up in every
// `getAllTargets` response (which the dashboard hits on every refresh).
// 4 000 chars ≈ 60 timestamped 50-char notes — enough for active investigation
// without becoming a megabyte payload.
const MAX_NOTES_LEN = 4000;

async function cmdNote(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId || args.length < 2) {
        await sendTempMessage(channelId, "❌ Usage: `$note <@user> <text>`");
        return;
    }

    const db  = getDb();
    const row = db.prepare("SELECT notes FROM targets WHERE user_id = ?")
        .get(userId) as { notes: string | null } | undefined;
    if (!row) {
        await sendTempMessage(channelId, `❌ \`${userId}\` is not a tracked target.`);
        return;
    }

    const noteText  = args.slice(1).join(" ");
    const timestamp = fmtDateTime(Date.now());
    const existing  = row.notes ?? "";
    const newNotes  = existing ? `${existing}\n[${timestamp}] ${noteText}` : `[${timestamp}] ${noteText}`;

    if (newNotes.length > MAX_NOTES_LEN) {
        await sendTempMessage(
            channelId,
            `❌ Notes for \`${userId}\` would exceed ${MAX_NOTES_LEN} chars (current: ${existing.length}). ` +
            `Trim old entries via the API before adding more.`,
            8_000
        );
        return;
    }

    db.prepare("UPDATE targets SET notes = ? WHERE user_id = ?").run(newNotes, userId);

    await sendTempMessage(channelId, `📝 Note appended to \`${userId}\`. (${newNotes.length}/${MAX_NOTES_LEN} chars used)`);
    log.info(`Command: appended note to ${userId}`);
}

async function cmdTimezone(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$tz <@user> [Area/City]` — omit timezone to show current.");
        return;
    }

    const db  = getDb();
    const row = db.prepare("SELECT timezone FROM targets WHERE user_id = ?")
        .get(userId) as { timezone: string } | undefined;
    if (!row) {
        await sendTempMessage(channelId, `❌ \`${userId}\` is not a tracked target.`);
        return;
    }

    // No tz argument → report current.
    if (args.length < 2) {
        await sendTempMessage(channelId, `🌍 \`${userId}\` timezone: **${row.timezone}**`);
        return;
    }

    const tz = args.slice(1).join(" ").trim();
    if (!isValidTimezone(tz)) {
        await sendTempMessage(
            channelId,
            `❌ Invalid timezone \`${tz}\`. Use an IANA identifier like \`America/New_York\`, \`Europe/London\`, or \`UTC\`.`,
            7_000
        );
        return;
    }

    db.prepare("UPDATE targets SET timezone = ? WHERE user_id = ?").run(tz, userId);
    refreshTargetCache();
    await sendTempMessage(channelId, `🌍 \`${userId}\` timezone set: **${row.timezone}** → **${tz}**`);
    log.info(`Command: set timezone for ${userId}: "${row.timezone}" → "${tz}"`);
}

// ── Intelligence ──────────────────────────────────────────────────────────────

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
            `❓ No presence data for \`${userId}\` yet — may not be tracked or no presence received.`,
            6_000
        );
        return;
    }

    const emoji = STATUS_EMOJI[presence.status] ?? "❓";
    const activityLines = activities.length
        ? activities.map(a => {
            const label  = ACTIVITY_LABELS[a.type] ?? `Type ${a.type}`;
            const detail = a.details ? ` — ${a.details}` : "";
            const state  = a.state   ? ` (${a.state})`  : "";
            return `  **${label}:** ${a.name}${detail}${state}`;
        }).join("\n")
        : "  none";

    await sendTempMessage(
        channelId,
        `${emoji} \`${userId}\` — **${presence.status}** on **${presence.platform ?? "unknown"}**\n` +
        `🎮 Activities:\n${activityLines}`,
        8_000
    );
}

async function cmdSeen(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$seen <@user>` or `$seen <userId>`");
        return;
    }

    // If currently online/idle/dnd — they're active right now.
    const live = getCurrentPresence(userId);
    if (live && live.status !== "offline" && live.status !== "unknown") {
        const openSession = getStmts().getOpenPresenceSession.get(userId) as any;
        const since = openSession ? ` (${fmtDuration(Date.now() - openSession.start_time)} so far)` : "";
        const emoji = STATUS_EMOJI[live.status] ?? "❓";
        await sendTempMessage(
            channelId,
            `${emoji} \`${userId}\` is currently **${live.status}** on **${live.platform ?? "unknown"}**${since}.`,
            7_000
        );
        return;
    }

    // Otherwise look up the most recent closed non-offline session.
    const row = getStmts().getLastSeenOnline.get(userId) as any;
    if (!row) {
        await sendTempMessage(
            channelId,
            `❓ No online sessions on record for \`${userId}\`.`,
            6_000
        );
        return;
    }

    const emoji    = STATUS_EMOJI[row.status] ?? "❓";
    const platform = row.platform ? ` on ${row.platform}` : "";
    await sendTempMessage(
        channelId,
        `⚫ \`${userId}\` last seen **${row.status}**${platform} — **${timeAgo(row.end_time)}** (${fmtDateTime(row.end_time)}).\n` +
        `${emoji} That session lasted **${fmtDuration(row.duration_ms)}**.`,
        8_000
    );
}

async function cmdUptime(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$uptime <@user>` or `$uptime <userId>`");
        return;
    }

    const now       = Date.now();
    const d         = new Date(now);
    const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

    const row = getStmts().getTodayActiveMs.get(now, userId, todayStart) as { total_ms: number } | undefined;
    const totalMs = row?.total_ms ?? 0;

    const elapsed       = now - todayStart;                        // ms since midnight
    const pct           = elapsed > 0 ? (totalMs / elapsed) * 100 : 0;
    const bar           = buildProgressBar(pct, 20);

    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    await sendTempMessage(
        channelId,
        `⏱ \`${userId}\` — **${dateStr}** active time:\n` +
        `**${fmtDuration(totalMs)}** of ${fmtDuration(elapsed)} elapsed  (${pct.toFixed(1)}%)\n` +
        `\`${bar}\``,
        8_000
    );
}

function buildProgressBar(pct: number, width: number): string {
    const filled = Math.round((Math.min(pct, 100) / 100) * width);
    return "█".repeat(filled) + "░".repeat(width - filled) + ` ${pct.toFixed(1)}%`;
}

async function cmdStreak(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$streak <@user>` or `$streak <userId>`");
        return;
    }

    const openSession = getStmts().getOpenPresenceSession.get(userId) as any;

    if (openSession) {
        const duration = Date.now() - openSession.start_time;
        const emoji    = STATUS_EMOJI[openSession.status] ?? "❓";
        const platform = openSession.platform ? ` on ${openSession.platform}` : "";
        await sendTempMessage(
            channelId,
            `${emoji} \`${userId}\` has been **${openSession.status}**${platform} for **${fmtDuration(duration)}**\n` +
            `(since ${fmtDateTime(openSession.start_time)})`,
            7_000
        );
    } else {
        // No open session — find how long they've been offline.
        const lastClosed = getDb()
            .prepare("SELECT end_time FROM presence_sessions WHERE target_id = ? AND end_time IS NOT NULL ORDER BY end_time DESC LIMIT 1")
            .get(userId) as { end_time: number } | undefined;

        if (lastClosed) {
            await sendTempMessage(
                channelId,
                `⚫ \`${userId}\` has been **offline** for **${fmtDuration(Date.now() - lastClosed.end_time)}**\n` +
                `(since ${fmtDateTime(lastClosed.end_time)})`,
                7_000
            );
        } else {
            await sendTempMessage(channelId, `❓ No session data for \`${userId}\`.`, 5_000);
        }
    }
}

async function cmdHistory(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$history <@user> [count]`");
        return;
    }

    const count = Math.min(Math.max(parseInt(args[1] ?? "10", 10) || 10, 1), 20);
    const sessions = getStmts().getRecentPresenceSessions.all(userId, count) as any[];

    if (!sessions.length) {
        await sendTempMessage(channelId, `❓ No presence history for \`${userId}\`.`, 5_000);
        return;
    }

    const lines = sessions.map(s => {
        const emoji    = STATUS_EMOJI[s.status] ?? "❓";
        const platform = s.platform ? `/${s.platform}` : "";
        const start    = fmtTime(s.start_time);
        const end      = s.end_time ? fmtTime(s.end_time) : "now";
        const dur      = s.duration_ms
            ? fmtDuration(s.duration_ms)
            : fmtDuration(Date.now() - s.start_time);
        return `${emoji} **${s.status}**${platform}  ${start} → ${end}  (${dur})`;
    });

    await sendTempMessage(
        channelId,
        `📜 Last **${sessions.length}** sessions for \`${userId}\`:\n${lines.join("\n")}`,
        12_000
    );
}

async function cmdPattern(channelId: string, args: string[]): Promise<void> {
    const userId = args[0] ? parseUserId(args[0]) : null;
    if (!userId) {
        await sendTempMessage(channelId, "❌ Usage: `$pattern <@user>`");
        return;
    }

    const now          = Date.now();
    const windowStart  = now - 30 * 24 * 3_600_000; // 30 days

    const sessions = getDb().prepare(
        `SELECT start_time, end_time FROM presence_sessions
         WHERE target_id = ? AND status IN ('online', 'idle', 'dnd') AND start_time >= ?`
    ).all(userId, windowStart) as Array<{ start_time: number; end_time: number | null }>;

    if (!sessions.length) {
        await sendTempMessage(channelId, `❓ No active presence data for \`${userId}\` in the last 30 days.`, 6_000);
        return;
    }

    // Accumulate active milliseconds into 24 hourly buckets (local time).
    const buckets = new Array<number>(24).fill(0);
    for (const s of sessions) {
        let t   = s.start_time;
        const end = s.end_time ?? now;
        while (t < end) {
            const hour       = new Date(t).getHours();
            const nextHour   = new Date(new Date(t).setHours(hour + 1, 0, 0, 0)).getTime();
            const segEnd     = Math.min(nextHour, end);
            buckets[hour]   += segEnd - t;
            t                = nextHour;
        }
    }

    // Render as two-line heatmap inside a code block.
    const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const max    = Math.max(...buckets);
    const toBar  = (v: number) => max === 0 ? " " : BLOCKS[Math.round((v / max) * 8)];

    const hourLine = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).join(" ");
    const barLine  = buckets.map(toBar).join("  ");

    // Find peak hour
    const peakHour  = buckets.indexOf(max);
    const peakLabel = `${String(peakHour).padStart(2, "0")}:00–${String(peakHour + 1).padStart(2, "0")}:00`;

    await sendTempMessage(
        channelId,
        `📈 Hourly activity pattern for \`${userId}\` (last 30 days, local time):\n` +
        `\`\`\`\n${hourLine}\n${barLine}\n\`\`\`` +
        `Peak: **${peakLabel}** (${fmtDuration(max)} total)`,
        14_000
    );
}

// ── List ──────────────────────────────────────────────────────────────────────

async function cmdList(channelId: string): Promise<void> {
    const targets = getStmts().getActiveTargets.all() as any[];

    if (!targets.length) {
        await sendTempMessage(channelId, "📋 No active targets.", 5_000);
        return;
    }

    const lines = targets.map((t: any) => {
        const p     = getCurrentPresence(t.user_id);
        const emoji = STATUS_EMOJI[p?.status ?? ""] ?? "❓";
        const label = t.label ? ` **(${t.label})**` : "";
        const plat  = p?.platform ? `/${p.platform}` : "";
        return `${emoji} \`${t.user_id}\`${label} — ${p?.status ?? "unknown"}${plat}`;
    });

    await sendTempMessage(
        channelId,
        `📋 **Active targets (${targets.length}):**\n${lines.join("\n")}`,
        10_000
    );
}

// ── System ────────────────────────────────────────────────────────────────────

async function cmdPing(channelId: string): Promise<void> {
    // Send placeholder — timing this call gives us REST latency.
    const t0  = Date.now();
    let placeholderId: string | null = null;

    try {
        const res = await discordFetch(
            `/channels/${channelId}/messages`,
            config.discordToken,
            { method: "POST", body: JSON.stringify({ content: "🏓 measuring…", tts: false }) }
        );
        if (!res.ok) return;
        const msg = await res.json() as { id: string };
        placeholderId = msg.id;
    } catch { return; }

    const restMs = Date.now() - t0;
    const gwMs   = gatewayRef?.getHeartbeatLatency();
    const gwStr  = gwMs != null ? `**${gwMs} ms**` : "n/a";
    const gwConn = gatewayRef?.isConnected() ? "✅ connected" : "❌ disconnected";

    const content =
        `🏓 **Pong!**\n` +
        `REST API:         **${restMs} ms**\n` +
        `Gateway heartbeat: ${gwStr}\n` +
        `Gateway status:    ${gwConn}`;

    try {
        // Edit placeholder with real values.
        await discordFetch(
            `/channels/${channelId}/messages/${placeholderId}`,
            config.discordToken,
            { method: "PATCH", body: JSON.stringify({ content }) }
        );
        setTimeout(() => deleteMessage(channelId, placeholderId!), 8_000);
    } catch {
        // Fallback: just delete the placeholder.
        if (placeholderId) deleteMessage(channelId, placeholderId);
    }
}

async function cmdStats(channelId: string): Promise<void> {
    const db     = getDb();
    const stmts  = getStmts();

    const allTargets    = db.prepare("SELECT COUNT(*) AS c FROM targets").get() as { c: number };
    const activeTargets = db.prepare("SELECT COUNT(*) AS c FROM targets WHERE active = 1").get() as { c: number };
    const eventCount    = stmts.getEventCount.get() as { count: number };
    const dbSizeRow     = stmts.getDbSize.get() as { size: number };
    const dbSizeMb      = (dbSizeRow.size / 1_048_576).toFixed(2);

    const uptimeSec  = Math.floor(process.uptime());
    const uptimeStr  = fmtDuration(uptimeSec * 1_000);

    const sessionId  = gatewayRef?.getSessionId();
    const sessionStr = sessionId ? `\`${sessionId.slice(0, 10)}…\`` : "none";
    const gwConn     = gatewayRef?.isConnected() ? "✅" : "❌";
    const gwMs       = gatewayRef?.getHeartbeatLatency();
    const gwLatency  = gwMs != null ? ` (${gwMs} ms)` : "";

    const activeRules = (stmts.getAlertRules.all() as any[]).length;

    await sendTempMessage(
        channelId,
        `📊 **Sentinel Stats**\n` +
        `Targets:    **${activeTargets.c}** active / ${allTargets.c} total\n` +
        `Events:     **${eventCount.count.toLocaleString()}** recorded\n` +
        `Alert rules: **${activeRules}** active\n` +
        `DB size:    **${dbSizeMb} MB**\n` +
        `Process up: **${uptimeStr}**\n` +
        `Gateway:    ${gwConn} ${sessionStr}${gwLatency}`,
        10_000
    );
}

async function cmdReload(channelId: string): Promise<void> {
    try {
        loadRuntimeConfig();
        // Fire every onConfigChange listener so a reload actually triggers
        // gateway reconnect, AI provider reset, brief reschedule, etc.
        // Without this, $reload only updated the in-memory config and rules
        // without applying the runtime side-effects that the API path applies.
        triggerAllConfigListeners();
        reloadRules();
        await sendTempMessage(channelId, `🔄 Config & alert rules reloaded.`, 5_000);
        log.info("Command: reloaded config and rules");
    } catch (e: any) {
        await sendTempMessage(channelId, `⚠️ Reload failed: ${e.message}`, 6_000);
    }
}

// ── Help ──────────────────────────────────────────────────────────────────────

async function cmdHelp(channelId: string): Promise<void> {
    await sendTempMessage(
        channelId,
        "**Sentinel Commands** *(all messages auto-delete)*\n" +
        "**Targets**\n" +
        "`$add <@user>`           — add tracking target\n" +
        "`$remove <@user>`        — remove target\n" +
        "`$pause <@user>`         — suspend without deleting history\n" +
        "`$resume <@user>`        — re-activate paused target\n" +
        "`$label <@user> <text>`  — set display label\n" +
        "`$note <@user> <text>`   — append timestamped note\n" +
        "`$tz <@user> [Area/City]` — set or show IANA timezone (default UTC)\n" +
        "**Intelligence**\n" +
        "`$status <@user>`        — current presence & activities\n" +
        "`$seen <@user>`          — when last online\n" +
        "`$uptime <@user>`        — today's active time\n" +
        "`$streak <@user>`        — time in current status\n" +
        "`$history <@user> [n]`   — last N presence transitions\n" +
        "`$pattern <@user>`       — 30-day hourly heatmap\n" +
        "`$list`                  — all active targets with live status\n" +
        "**System**\n" +
        "`$ping`   — REST & gateway latency\n" +
        "`$stats`  — system stats\n" +
        "`$reload` — reload rules & config",
        15_000
    );
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Call from the MESSAGE_CREATE gateway handler.
 * Returns true if the message was a self-command (handled + deleted).
 * Returns false if it should fall through to normal processing.
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

    // Delete command immediately — even if the handler below throws.
    await deleteMessage(channelId, messageId);

    log.info(`Self-command: $${command}${args.length ? " " + args.join(" ") : ""}`);

    try {
        switch (command) {
            case "add":     await cmdAdd(channelId, args);     break;
            case "remove":  await cmdRemove(channelId, args);  break;
            case "pause":   await cmdPause(channelId, args);   break;
            case "resume":  await cmdResume(channelId, args);  break;
            case "label":   await cmdLabel(channelId, args);   break;
            case "note":    await cmdNote(channelId, args);     break;
            case "tz":
            case "timezone": await cmdTimezone(channelId, args); break;
            case "status":  await cmdStatus(channelId, args);  break;
            case "seen":    await cmdSeen(channelId, args);     break;
            case "uptime":  await cmdUptime(channelId, args);  break;
            case "streak":  await cmdStreak(channelId, args);  break;
            case "history": await cmdHistory(channelId, args); break;
            case "pattern": await cmdPattern(channelId, args); break;
            case "list":    await cmdList(channelId);           break;
            case "ping":    await cmdPing(channelId);           break;
            case "stats":   await cmdStats(channelId);          break;
            case "reload":  await cmdReload(channelId);         break;
            case "help":    await cmdHelp(channelId);           break;
            default:
                // Unknown — silently deleted, no response.
                log.debug(`Unknown command: "${command}"`);
                break;
        }
    } catch (err: any) {
        log.error(`Command $${command} error: ${err.message}`);
        await sendTempMessage(channelId, `⚠️ Command failed: ${err.message}`, 6_000);
    }

    return true;
}
