import { config } from "./config";
import { createLogger } from "./logger";
import { enqueueWebhook } from "./webhook-queue";

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

function post(embeds: Embed[], content?: string, label = "notifier"): void {
    const url = config.alertWebhookUrl;
    if (!url) return;

    const isDiscord = DISCORD_RE.test(url);
    const body = isDiscord
        ? JSON.stringify({ username: "Sentinel", embeds, content })
        : JSON.stringify({ embeds, content, timestamp: Date.now() });

    enqueueWebhook(url, body, label);
}

export function notifyStartup(opts: {
    guildCount: number;
    targetCount: number;
    activeTargetCount: number;
    ruleCount: number;
    dbMode: string;
    version?: string;
}): void {
    if (!config.alertWebhookUrl) return;

    post([{
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
    }], undefined, "startup");

    log.info("Startup notification queued");
}

export function notifyShutdown(reason?: string): void {
    if (!config.alertWebhookUrl) return;

    post([{
        title:       "Sentinel Offline",
        description: reason ? `Shutdown reason: ${reason}` : "Process exiting.",
        color:       COLOR.grey,
        footer:      { text: "Sentinel" },
        timestamp:   new Date().toISOString(),
    }], undefined, "shutdown");
}

export function notifyCriticalError(message: string, context?: string): void {
    if (!config.alertWebhookUrl) return;

    const fields: EmbedField[] = [];
    if (context) fields.push({ name: "Context", value: context.slice(0, 1000) });

    post([{
        title:       "Critical Error",
        description: `\`\`\`${message.slice(0, 1500)}\`\`\``,
        color:       COLOR.red,
        fields,
        footer:      { text: "Sentinel" },
        timestamp:   new Date().toISOString(),
    }], undefined, "critical-error");
}

export function notifyDailySummary(
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
): void {
    if (!config.alertWebhookUrl) return;

    const displayName = label ? `${label} (${targetId})` : targetId;
    const totalActiveMins = summary.onlineMinutes + summary.idleMinutes + summary.dndMinutes;
    const fmtHours = (mins: number) => mins >= 60
        ? `${(mins / 60).toFixed(1)}h`
        : `${mins}m`;

    post([{
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
    }], undefined, `daily-summary:${targetId}`);
}
