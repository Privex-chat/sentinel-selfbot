import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { AlertCondition, AlertRule, EVENT_TO_ALERT_MAP } from "./conditions";

const log = createLogger("AlertEngine");

type AlertCallback = (alert: { ruleId: number; targetId: string; alertType: string; message: string }) => void;

let alertCallback: AlertCallback | null = null;
let cachedRules: AlertRule[] = [];

export function setAlertCallback(cb: AlertCallback): void {
    alertCallback = cb;
}

export function reloadRules(): void {
    const stmts = getStmts();
    const rows = stmts.getAlertRules.all() as any[];
    cachedRules = rows.map(r => ({
        ...r,
        condition: parseCondition(r.condition),
    }));
    log.info(`Loaded ${cachedRules.length} active alert rules`);
}

function parseCondition(raw: string): AlertCondition {
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

export function evaluateEvent(eventType: string, targetId: string, eventData: any, eventTimestamp?: number): void {
    const alertTypes = EVENT_TO_ALERT_MAP[eventType];
    if (!alertTypes) return;

    const ts = eventTimestamp || Date.now();

    for (const rule of cachedRules) {
        // Rule must match target or be global (null target_id)
        if (rule.target_id && rule.target_id !== targetId) continue;
        if (!alertTypes.includes(rule.rule_type)) continue;

        if (matchesCondition(rule, eventType, eventData, ts)) {
            fireAlert(rule, targetId, eventType, eventData);
        }
    }
}

function matchesCondition(rule: AlertRule, eventType: string, data: any, eventTimestamp: number): boolean {
    const cond = rule.condition;
    const eventTime = new Date(eventTimestamp);

    switch (rule.rule_type) {
        case "COMES_ONLINE": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            if (parsed.newStatus !== "online") return false;
            if (cond.after_hour !== undefined) {
                const hour = eventTime.getHours();
                if (hour < cond.after_hour) return false;
            }
            return true;
        }

        case "GOES_OFFLINE": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            return parsed.newStatus === "offline";
        }

        case "STATUS_CHANGE": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            if (cond.field === "transition") {
                const expected = cond.value as string; // e.g. "idle->dnd"
                const actual = `${parsed.oldStatus}->${parsed.newStatus}`;
                return actual === expected;
            }
            return true;
        }

        case "STARTS_ACTIVITY": {
            if (eventType !== "ACTIVITY_START") return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            if (cond.value) {
                return parsed.name?.toLowerCase().includes(cond.value.toLowerCase());
            }
            return true;
        }

        case "STOPS_ACTIVITY": {
            if (eventType !== "ACTIVITY_END") return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            if (cond.value) {
                return parsed.name?.toLowerCase().includes(cond.value.toLowerCase());
            }
            return true;
        }

        case "JOINS_VOICE": {
            if (eventType !== "VOICE_JOIN") return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            if (cond.field === "guildId" && cond.value) return parsed.guildId === cond.value;
            if (cond.field === "channelId" && cond.value) return parsed.channelId === cond.value;
            return true;
        }

        case "LEAVES_VOICE":
            return eventType === "VOICE_LEAVE";

        case "SENDS_MESSAGE": {
            if (eventType !== "MESSAGE_CREATE") return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            if (cond.field === "channelId" && cond.value) return parsed.channelId === cond.value;
            if (cond.field === "guildId" && cond.value) return parsed.guildId === cond.value;
            return true;
        }

        case "DELETES_MESSAGE":
            return eventType === "MESSAGE_DELETE";

        case "GHOST_TYPES":
            return eventType === "GHOST_TYPE";

        case "PROFILE_CHANGE":
            return ["PROFILE_UPDATE", "AVATAR_CHANGE", "USERNAME_CHANGE"].includes(eventType);

        case "KEYWORD_MENTION": {
            if (eventType !== "MESSAGE_CREATE") return false;
            if (!cond.value) return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            // We need the actual message content - check from messages table
            try {
                const stmts = getStmts();
                const msg = stmts.getMessage.get(parsed.messageId) as any;
                if (msg?.content) {
                    const keywords = (cond.value as string).split(",").map(k => k.trim().toLowerCase());
                    const content = msg.content.toLowerCase();
                    return keywords.some(k => content.includes(k));
                }
            } catch { }
            return false;
        }

        case "NEW_GAME": {
            if (eventType !== "ACTIVITY_START") return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            if (parsed.type !== 0) return false; // Only games (type 0 = Playing)
            // Check if this game has ever been played before
            try {
                const stmts = getStmts();
                const sessions = stmts.getActivitySessions.all(rule.target_id || parsed.targetId, 0, 1000) as any[];
                const playedBefore = sessions.some((s: any) => s.activity_name === parsed.name && s.start_time < Date.now() - 60000);
                return !playedBefore;
            } catch { }
            return false;
        }

        case "UNUSUAL_HOUR": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            if (parsed.newStatus === "offline") return false;
            const hour = eventTime.getHours();
            // Default: unusual if between 2am and 6am
            const startHour = cond.start_hour ?? 2;
            const endHour = cond.end_hour ?? 6;
            return hour >= startHour && hour < endHour;
        }

        default:
            return false;
    }
}

function fireAlert(rule: AlertRule, targetId: string, eventType: string, eventData: any): void {
    const message = generateAlertMessage(rule, targetId, eventType, eventData);
    const stmts = getStmts();
    const now = Date.now();

    stmts.insertAlertHistory.run(rule.id, targetId, rule.rule_type, message, now);

    log.info(`ALERT [${rule.rule_type}] ${targetId}: ${message}`);

    alertCallback?.({
        ruleId: rule.id,
        targetId,
        alertType: rule.rule_type,
        message,
    });
}

function generateAlertMessage(rule: AlertRule, targetId: string, eventType: string, data: any): string {
    const parsed = typeof data === "string" ? safeParse(data) : data;

    switch (rule.rule_type) {
        case "COMES_ONLINE": return `Target ${targetId} came online`;
        case "GOES_OFFLINE": return `Target ${targetId} went offline`;
        case "STATUS_CHANGE": return `Target ${targetId} status: ${parsed.oldStatus} -> ${parsed.newStatus}`;
        case "STARTS_ACTIVITY": return `Target ${targetId} started: ${parsed.name || "activity"}`;
        case "STOPS_ACTIVITY": return `Target ${targetId} stopped: ${parsed.name || "activity"}`;
        case "JOINS_VOICE": return `Target ${targetId} joined voice channel`;
        case "LEAVES_VOICE": return `Target ${targetId} left voice channel`;
        case "SENDS_MESSAGE": return `Target ${targetId} sent a message`;
        case "DELETES_MESSAGE": return `Target ${targetId} deleted a message`;
        case "GHOST_TYPES": return `Target ${targetId} typed but didn't send`;
        case "PROFILE_CHANGE": return `Target ${targetId} updated their profile`;
        case "NEW_GAME": return `Target ${targetId} playing new game: ${parsed.name}`;
        case "UNUSUAL_HOUR": return `Target ${targetId} online at unusual hour (${new Date().getHours()}:00)`;
        case "KEYWORD_MENTION": return `Target ${targetId} mentioned keyword`;
        default: return `Alert triggered for ${targetId}: ${rule.rule_type}`;
    }
}

function safeParse(str: string): any {
    try { return JSON.parse(str); } catch { return {}; }
}
