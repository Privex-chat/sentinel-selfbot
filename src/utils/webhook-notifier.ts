import { config } from "./config";
import { createLogger } from "./logger";

const log = createLogger("C2Notifier");

const DISCORD_RE = /https?:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//i;

// Discord embed color palette
const COLOR = {
    green:  0x57f287,
    red:    0xed4245,
    orange: 0xfee75c,
    blue:   0x5865f2,
    grey:   0x747f8d,
} as const;

interface EmbedField { name: string; value: string; inline?: boolean; }

interface Embed {
    title?: string;
    description?: string;
    color?: number;
    fields?: EmbedField[];
    footer?: { text: string };
    timestamp?: string;
}

async function post(embeds: Embed[], content?: string): Promise<void> {
    const url = config.alertWebhookUrl;
    if (!url) return;

    const isDiscord = DISCORD_RE.test(url);
    const body = isDiscord
        ? JSON.stringify({ username: "Sentinel", embeds, content })
        : JSON.stringify({ embeds, content, timestamp: Date.now() });

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            log.warn(`Webhook post failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
        }
    } catch (err: any) {
        log.warn(`Webhook post error: ${err.message}`);
    }
}

export async function notifyStartup(opts: {
    guildCount: number;
    targetCount: number;
    activeTargetCount: number;
    ruleCount: number;
    dbMode: string;
    version?: string;
}): Promise<void> {
    if (!config.alertWebhookUrl) return;

    await post([{
        title: "Sentinel Online",
        description: "Selfbot connected and ready.",
        color: COLOR.green,
        fields: [
            { name: "Guilds",       value: String(opts.guildCount),          inline: true },
            { name: "Targets",      value: `${opts.activeTargetCount} active / ${opts.targetCount} total`, inline: true },
            { name: "Alert Rules",  value: String(opts.ruleCount),           inline: true },
            { name: "DB Mode",      value: opts.dbMode,                      inline: true },
        ],
        footer:    { text: "Sentinel" },
        timestamp: new Date().toISOString(),
    }]);

    log.info("Startup notification sent");
}

export async function notifyShutdown(reason?: string): Promise<void> {
    if (!config.alertWebhookUrl) return;

    await post([{
        title:       "Sentinel Offline",
        description: reason ? `Shutdown reason: ${reason}` : "Process exiting.",
        color:       COLOR.grey,
        footer:      { text: "Sentinel" },
        timestamp:   new Date().toISOString(),
    }]);
}

export async function notifyCriticalError(message: string, context?: string): Promise<void> {
    if (!config.alertWebhookUrl) return;

    const fields: EmbedField[] = [];
    if (context) fields.push({ name: "Context", value: context.slice(0, 1000) });

    await post([{
        title:       "Critical Error",
        description: `\`\`\`${message.slice(0, 1500)}\`\`\``,
        color:       COLOR.red,
        fields,
        footer:      { text: "Sentinel" },
        timestamp:   new Date().toISOString(),
    }]);
}

export async function notifyDailySummary(
    targetId: string,
    label: string | null,
    date: string,
    summary: {
        onlineMinutes:  number;
        idleMinutes:    number;
        dndMinutes:     number;
        messageCount:   number;
        voiceMinutes:   number;
        deleteCount:    number;
        editCount:      number;
        peakHour:       number | null;
    }
): Promise<void> {
    if (!config.alertWebhookUrl) return;

    const displayName = label ? `${label} (${targetId})` : targetId;
    const totalActiveMins = summary.onlineMinutes + summary.idleMinutes + summary.dndMinutes;
    const fmtHours = (mins: number) => mins >= 60
        ? `${(mins / 60).toFixed(1)}h`
        : `${mins}m`;

    await post([{
        title:       `Daily Summary — ${date}`,
        description: `Target: \`${displayName}\``,
        color:       COLOR.blue,
        fields: [
            { name: "Active",    value: fmtHours(totalActiveMins),     inline: true },
            { name: "Online",    value: fmtHours(summary.onlineMinutes), inline: true },
            { name: "Voice",     value: fmtHours(summary.voiceMinutes), inline: true },
            { name: "Messages",  value: String(summary.messageCount),  inline: true },
            { name: "Deletes",   value: String(summary.deleteCount),   inline: true },
            { name: "Edits",     value: String(summary.editCount),     inline: true },
            { name: "Peak Hour", value: summary.peakHour !== null ? `${summary.peakHour}:00` : "—", inline: true },
        ],
        footer:    { text: "Sentinel" },
        timestamp: new Date().toISOString(),
    }]);
}
