import { createLogger } from "../utils/logger";
import { getDb } from "../database/connection";
import { getStmts } from "../database/queries";
import { config } from "../utils/config";
import { ai } from "../ai/provider";
import { BriefStats, dailyBriefNarrativePrompt } from "../ai/prompts";

export type { BriefStats };

const log = createLogger("BriefGenerator");

// ── Time formatting ───────────────────────────────────────────────────────────

function formatTime(epochMs: number | null): string | null {
    if (!epochMs) return null;
    const d = new Date(epochMs);
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, "0");
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12 || 12;
    return `${h}:${m}${ampm}`;
}

function dayName(dateStr: string): string {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return days[new Date(dateStr + "T12:00:00").getDay()];
}

function monthName(dateStr: string): string {
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    return months[new Date(dateStr + "T12:00:00").getMonth()];
}

function dayNum(dateStr: string): number {
    return new Date(dateStr + "T12:00:00").getDate();
}

// ── Stats builder ─────────────────────────────────────────────────────────────

function buildBriefStats(targetId: string, dateStr: string): BriefStats {
    const db = getDb();
    const stmts = getStmts();
    // dateStr is a UTC date (YYYY-MM-DD derived from toISOString()). Compute day
    // boundaries in UTC so day-edge events are counted under the matching date.
    const dayStart = new Date(dateStr + "T00:00:00Z").getTime();
    const dayEnd = dayStart + 86_400_000;

    // Daily summary row
    const summary = stmts.getDailySummaryByDate.get(targetId, dateStr) as any;
    const target = stmts.getTarget.get(targetId) as any;

    // Platform used
    const platforms = db.prepare(
        `SELECT platform, SUM(duration_ms) as total FROM presence_sessions
         WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL) AND platform IS NOT NULL
         GROUP BY platform ORDER BY total DESC`
    ).all(targetId, dayEnd, dayStart) as any[];

    let platformUsed: string | null = null;
    if (platforms.length === 1) {
        platformUsed = platforms[0].platform;
    } else if (platforms.length > 1) {
        platformUsed = "mixed";
    }

    // Top activities from summary
    let topActivities: { name: string; minutes: number }[] = [];
    if (summary?.activity_minutes) {
        try {
            const actMap: Record<string, number> = JSON.parse(summary.activity_minutes);
            topActivities = Object.entries(actMap)
                .map(([name, minutes]) => ({ name, minutes: minutes as number }))
                .filter(a => a.minutes > 0)
                .sort((a, b) => b.minutes - a.minutes)
                .slice(0, 5);
        } catch { }
    }

    // Deleted messages today
    const deleted = db.prepare(
        `SELECT COUNT(*) as count FROM messages WHERE target_id = ? AND deleted_at >= ? AND deleted_at < ?`
    ).get(targetId, dayStart, dayEnd) as any;

    // Ghost typing today
    const ghosts = db.prepare(
        `SELECT COUNT(*) as count FROM typing_events WHERE target_id = ? AND timestamp >= ? AND timestamp < ? AND resulted_in_message = 0`
    ).get(targetId, dayStart, dayEnd) as any;

    // Voice sessions today
    const voiceRows = db.prepare(
        `SELECT channel_id, duration_ms, co_participants FROM voice_sessions
         WHERE target_id = ? AND start_time < ? AND (end_time > ? OR end_time IS NULL)`
    ).all(targetId, dayEnd, dayStart) as any[];

    const voiceSessions = voiceRows.map(v => {
        let participantCount = 0;
        try { participantCount = JSON.parse(v.co_participants || "[]").length; } catch { }
        return {
            channelId: v.channel_id,
            durationMinutes: Math.round((v.duration_ms || 0) / 60000),
            participantCount,
        };
    });

    // Profile changed today
    const profileEvents = db.prepare(
        `SELECT COUNT(*) as count FROM events WHERE target_id = ? AND timestamp >= ? AND timestamp < ? AND event_type IN ('PROFILE_UPDATE','AVATAR_CHANGE','USERNAME_CHANGE')`
    ).get(targetId, dayStart, dayEnd) as any;

    // Anomalies (simple inline detection for brief)
    const anomalies: string[] = [];
    if (summary) {
        const totalActive = (summary.online_minutes || 0) + (summary.idle_minutes || 0) + (summary.dnd_minutes || 0);
        if (totalActive === 0 && (summary.first_seen || summary.last_seen)) {
            anomalies.push("Active time missing but presence events exist");
        }
    }

    return {
        targetId,
        label: target?.label || null,
        date: dateStr,
        onlineMinutes: summary?.online_minutes || 0,
        idleMinutes: summary?.idle_minutes || 0,
        dndMinutes: summary?.dnd_minutes || 0,
        messageCount: summary?.message_count || 0,
        voiceMinutes: summary?.voice_minutes || 0,
        firstSeen: formatTime(summary?.first_seen),
        lastSeen: formatTime(summary?.last_seen),
        platformUsed,
        topActivities,
        deletedMessages: deleted?.count || 0,
        ghostTypeEvents: ghosts?.count || 0,
        voiceSessions,
        profileChanged: (profileEvents?.count || 0) > 0,
        anomalies,
    };
}

// ── Plain-text brief format ───────────────────────────────────────────────────

function formatBriefText(stats: BriefStats, aiNarrative?: string): string {
    const label = stats.label || stats.targetId;
    const day = dayName(stats.date);
    const month = monthName(stats.date);
    const dayN = dayNum(stats.date);
    const totalActive = stats.onlineMinutes + stats.idleMinutes + stats.dndMinutes;
    const activeH = Math.floor(totalActive / 60);
    const activeM = totalActive % 60;

    const lines: string[] = [
        `DAILY BRIEF — ${label} — ${day} ${month} ${dayN}`,
        "",
    ];

    // PRESENCE
    let presenceLine = "";
    if (totalActive > 0) {
        presenceLine = `Online ${activeH}h ${activeM}m.`;
        if (stats.firstSeen) presenceLine += ` First seen ${stats.firstSeen}`;
        if (stats.lastSeen) presenceLine += `, last seen ${stats.lastSeen}.`;
        if (stats.platformUsed) presenceLine += ` Platform: ${stats.platformUsed}.`;
    } else {
        presenceLine = "No online activity recorded.";
    }
    lines.push(`PRESENCE: ${presenceLine}`);

    // ACTIVITY
    if (stats.topActivities.length > 0) {
        const acts = stats.topActivities.map(a => {
            const h = Math.floor(a.minutes / 60);
            const m = a.minutes % 60;
            return `${a.name} ${h > 0 ? h + "h " : ""}${m}m`;
        }).join(". ");
        lines.push(`ACTIVITY: ${acts}.`);
    } else {
        lines.push("ACTIVITY: No activity recorded.");
    }

    // MESSAGES
    if (stats.messageCount > 0) {
        let msgLine = `${stats.messageCount} messages.`;
        if (stats.deletedMessages > 0) msgLine += ` ${stats.deletedMessages} deleted.`;
        if (stats.ghostTypeEvents > 0) msgLine += ` ${stats.ghostTypeEvents} ghost typing events.`;
        lines.push(`MESSAGES: ${msgLine}`);
    } else {
        lines.push("MESSAGES: No messages recorded.");
    }

    // VOICE
    if (stats.voiceSessions.length > 0) {
        const totalVoiceH = Math.floor(stats.voiceMinutes / 60);
        const totalVoiceM = stats.voiceMinutes % 60;
        let voiceLine = `${totalVoiceH}h ${totalVoiceM}m total.`;
        const first = stats.voiceSessions[0];
        if (first.participantCount > 0) {
            voiceLine += ` In channel ${first.channelId} with ${first.participantCount} others.`;
        }
        lines.push(`VOICE: ${voiceLine}`);
    } else {
        lines.push("VOICE: No voice activity.");
    }

    // PROFILE
    if (stats.profileChanged) {
        lines.push("PROFILE: Changed.");
    } else {
        lines.push("PROFILE: No changes.");
    }

    // ANOMALIES
    if (stats.anomalies.length > 0) {
        lines.push(`ANOMALIES: ${stats.anomalies.join(" ")}`);
    } else {
        lines.push("ANOMALIES: None.");
    }

    if (aiNarrative) {
        lines.push("");
        lines.push(`SUMMARY: ${aiNarrative}`);
    }

    return lines.join("\n");
}

// ── Brief generation for one target/date ─────────────────────────────────────

async function generateBrief(targetId: string, dateStr: string): Promise<void> {
    const stmts = getStmts();

    try {
        const stats = buildBriefStats(targetId, dateStr);

        let aiNarrative: string | undefined;
        if (config.aiProvider !== "none" && ai.isAvailable()) {
            try {
                const prompt = dailyBriefNarrativePrompt(stats);
                aiNarrative = await ai.complete(
                    "You are a neutral intelligence analyst writing brief daily summaries.",
                    prompt,
                    256
                );
                // Clamp to 3 sentences
                const sentences = aiNarrative.split(/(?<=[.!?])\s+/);
                if (sentences.length > 3) aiNarrative = sentences.slice(0, 3).join(" ");
            } catch (err: any) {
                log.warn(`AI narrative failed for ${targetId}/${dateStr}: ${err.message}`);
            }
        }

        const briefText = formatBriefText(stats, aiNarrative);
        stmts.insertDailyBrief.run(targetId, dateStr, briefText, Date.now());
        log.debug(`Generated brief for ${targetId} on ${dateStr}`);
    } catch (err: any) {
        log.error(`Brief generation error ${targetId}/${dateStr}: ${err.message}`);
    }
}

async function generateBriefsForDate(dateStr: string): Promise<void> {
    const stmts = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    log.info(`Generating daily briefs for ${dateStr} (${targets.length} targets)`);

    for (const t of targets) {
        await generateBrief(t.user_id, dateStr);
    }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

// Tracked so the entire timeout chain — not just the first arm — can be cancelled
// when BRIEF_GENERATION_TIME changes at runtime. Previously only the first tick
// was tracked; the inner re-arm fired regardless of cancellation, doubling the
// daily AI cost when the operator rescheduled.
let scheduledTickHandle: NodeJS.Timeout | null = null;
let backfillStartupHandle: NodeJS.Timeout | null = null;
let scheduleCancelled = false;

export function scheduleBriefGeneration(): NodeJS.Timeout {
    // Reset cancellation flag for the new schedule.
    scheduleCancelled = false;

    const [hStr, mStr] = config.briefGenerationTime.split(":");
    const targetHour = parseInt(hStr, 10);
    const targetMinute = parseInt(mStr, 10);

    function msUntilNext(): number {
        const now = new Date();
        const next = new Date();
        // BRIEF_GENERATION_TIME is documented as UTC; use setUTCHours so the
        // schedule fires at the documented wall-clock time regardless of the
        // host's local TZ (relevant for self-hosted, not for Railway/Fly which
        // already run in UTC).
        next.setUTCHours(targetHour, targetMinute, 0, 0);
        if (next.getTime() <= now.getTime()) {
            next.setUTCDate(next.getUTCDate() + 1);
        }
        return next.getTime() - now.getTime();
    }

    function prevDateStr(): string {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().split("T")[0];
    }

    // Backfill missing briefs for past 7 days, 5 min after (re)schedule.
    backfillStartupHandle = setTimeout(async () => {
        backfillStartupHandle = null;
        if (scheduleCancelled) return;
        const stmts = getStmts();
        const targets = stmts.getActiveTargets.all() as any[];
        for (let i = 1; i <= 7; i++) {
            if (scheduleCancelled) return;
            const d = new Date();
            d.setUTCDate(d.getUTCDate() - i);
            const dateStr = d.toISOString().split("T")[0];
            for (const t of targets) {
                if (scheduleCancelled) return;
                const existing = stmts.getDailyBriefByDate.get(t.user_id, dateStr);
                if (!existing) {
                    await generateBrief(t.user_id, dateStr);
                }
            }
        }
    }, 5 * 60 * 1000);

    // Scheduled daily generation. Track every arm of the chain so the outer
    // caller can cancel a still-running schedule cleanly.
    function arm(delayMs: number): void {
        scheduledTickHandle = setTimeout(() => {
            scheduledTickHandle = null;
            if (scheduleCancelled) return;
            const yesterday = prevDateStr();
            generateBriefsForDate(yesterday).catch(err =>
                log.error(`Scheduled brief generation error: ${err.message}`)
            );
            arm(24 * 60 * 60 * 1000);
        }, delayMs);
    }
    arm(msUntilNext());

    log.info(`Brief generation scheduled for ${config.briefGenerationTime} UTC daily`);
    // Returned handle is for compatibility with the previous signature; callers
    // should prefer cancelBriefGeneration() which cancels the entire chain.
    return scheduledTickHandle!;
}

/** Cancel the entire scheduled-tick chain plus the startup backfill. Safe to call before schedule. */
export function cancelBriefGeneration(): void {
    scheduleCancelled = true;
    if (scheduledTickHandle) {
        clearTimeout(scheduledTickHandle);
        scheduledTickHandle = null;
    }
    if (backfillStartupHandle) {
        clearTimeout(backfillStartupHandle);
        backfillStartupHandle = null;
    }
}

// ── Manual generation (for API) ───────────────────────────────────────────────

export async function generateBriefForTarget(targetId: string, dateStr: string): Promise<string> {
    await generateBrief(targetId, dateStr);
    const stmts = getStmts();
    const row = stmts.getDailyBriefByDate.get(targetId, dateStr) as any;
    return row?.brief_text || "";
}
