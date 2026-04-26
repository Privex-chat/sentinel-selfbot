import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { AlertCondition, AlertRule, EVENT_TO_ALERT_MAP } from "./conditions";
import { config } from "../utils/config";

const log = createLogger("AlertEngine");

type AlertCallback = (alert: {
    ruleId: number;
    targetId: string;
    alertType: string;
    message: string;
}) => void;

let alertCallback: AlertCallback | null = null;
let cachedRules: AlertRule[] = [];

// ── Composite alert tracker ───────────────────────────────────────────────────

interface CompositeState {
    satisfiedConditions: Set<string>;
    firstSatisfiedAt: number;
}

const compositeTracker = new Map<number, Map<string, CompositeState>>();

function cleanupStaleCompositeState(): void {
    const now = Date.now();
    for (const [ruleId, targetMap] of compositeTracker) {
        const rule = cachedRules.find(r => r.id === ruleId);
        if (!rule?.composite_condition) {
            compositeTracker.delete(ruleId);
            continue;
        }
        let windowMs = 300_000;
        try {
            const cc = JSON.parse(rule.composite_condition);
            windowMs = cc.window_ms || 300_000;
        } catch { }

        for (const [targetId, state] of targetMap) {
            if (now - state.firstSatisfiedAt > windowMs) {
                targetMap.delete(targetId);
            }
        }
        if (!targetMap.size) compositeTracker.delete(ruleId);
    }
}

setInterval(cleanupStaleCompositeState, 60_000).unref?.();

// ── Public API ────────────────────────────────────────────────────────────────

export function setAlertCallback(cb: AlertCallback): void {
    alertCallback = cb;
}

export function reloadRules(): void {
    const stmts = getStmts();
    const rows = stmts.getAlertRules.all() as any[];
    cachedRules = rows.map(r => ({
        ...r,
        condition: parseCondition(r.condition),
        fire_count_24h:      r.fire_count_24h      ?? 0,
        last_fire_at:        r.last_fire_at         ?? null,
        auto_suppressed:     r.auto_suppressed      ?? 0,
        fatigue_threshold:   r.fatigue_threshold    ?? config.alertFatigueThreshold,
        composite_condition: r.composite_condition  ?? null,
        digest_mode:         r.digest_mode          ?? 0,
    }));
    log.info(`Loaded ${cachedRules.length} active alert rules`);
}

function parseCondition(raw: string): AlertCondition {
    try { return JSON.parse(raw); } catch { return {}; }
}

export function evaluateEvent(
    eventType: string,
    targetId: string,
    eventData: any,
    eventTimestamp?: number
): void {
    const alertTypes = EVENT_TO_ALERT_MAP[eventType];
    if (!alertTypes) return;

    const ts = eventTimestamp || Date.now();

    for (const rule of cachedRules) {
        if (rule.target_id && rule.target_id !== targetId) continue;

        // Fatigue suppression
        if (rule.auto_suppressed === 1) continue;

        // Composite rule handling
        if (rule.composite_condition) {
            handleCompositeRule(rule, eventType, targetId, eventData, ts);
            continue;
        }

        if (!alertTypes.includes(rule.rule_type)) continue;

        if (matchesCondition(rule, eventType, eventData, ts, targetId)) {
            routeAlert(rule, targetId, eventType, eventData);
        }
    }
}

// ── Composite rules ───────────────────────────────────────────────────────────

function handleCompositeRule(
    rule: AlertRule,
    eventType: string,
    targetId: string,
    eventData: any,
    ts: number
): void {
    let cc: { operator: string; window_ms: number; conditions: any[] };
    try { cc = JSON.parse(rule.composite_condition!); }
    catch { return; }

    const windowMs = cc.window_ms || 300_000;

    if (!compositeTracker.has(rule.id)) {
        compositeTracker.set(rule.id, new Map());
    }
    const targetMap = compositeTracker.get(rule.id)!;

    if (!targetMap.has(targetId)) {
        targetMap.set(targetId, {
            satisfiedConditions: new Set(),
            firstSatisfiedAt: ts,
        });
    }

    const state = targetMap.get(targetId)!;
    let anySatisfied = false;

    for (const subCond of cc.conditions) {
        const condKey = JSON.stringify(subCond);
        if (state.satisfiedConditions.has(condKey)) continue;

        const fakeRule: AlertRule = {
            ...rule,
            rule_type: subCond.rule_type,
            condition: subCond.condition || {},
            composite_condition: null,
        };

        const alertTypes = EVENT_TO_ALERT_MAP[eventType];
        if (!alertTypes?.includes(subCond.rule_type)) continue;

        if (matchesCondition(fakeRule, eventType, eventData, ts, targetId)) {
            state.satisfiedConditions.add(condKey);
            anySatisfied = true;
            // Record the timestamp of the first satisfied condition
            if (state.satisfiedConditions.size === 1) {
                state.firstSatisfiedAt = ts;
            }
        }
    }

    // Only evaluate completion when this event actually contributed something
    if (!anySatisfied) return;

    const allSatisfied = cc.conditions.every(c =>
        state.satisfiedConditions.has(JSON.stringify(c))
    );
    const withinWindow = ts - state.firstSatisfiedAt <= windowMs;

    if (allSatisfied && withinWindow) {
        targetMap.delete(targetId);
        routeAlert(rule, targetId, eventType, eventData);
    }
}

// ── Condition matching ────────────────────────────────────────────────────────
//
// NOTE: eventData is always the PROCESSED event payload stored in the events
// table (camelCase fields: newStatus, oldStatus, channelId, messageId, …).
// Collectors call evaluateEvent directly with that processed JSON string.

function matchesCondition(
    rule: AlertRule,
    eventType: string,
    data: any,
    eventTimestamp: number,
    targetId: string
): boolean {
    const cond = rule.condition;
    const eventTime = new Date(eventTimestamp);

    // Parse once — data is always a JSON string from the collector
    const parsed: any = typeof data === "string" ? safeParse(data) : data;

    switch (rule.rule_type) {
        case "COMES_ONLINE": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            // processed: { newStatus, oldStatus, … }
            if (parsed.newStatus !== "online") return false;
            if (cond.after_hour !== undefined) {
                const hour = eventTime.getHours();
                if (hour < cond.after_hour) return false;
            }
            return true;
        }

        case "GOES_OFFLINE": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            return parsed.newStatus === "offline";
        }

        case "STATUS_CHANGE": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            if (cond.field === "transition") {
                const expected = cond.value as string;
                const actual = `${parsed.oldStatus}->${parsed.newStatus}`;
                return actual === expected;
            }
            return true;
        }

        case "STARTS_ACTIVITY": {
            if (eventType !== "ACTIVITY_START") return false;
            if (cond.value) {
                return parsed.name?.toLowerCase().includes(cond.value.toLowerCase());
            }
            return true;
        }

        case "STOPS_ACTIVITY": {
            if (eventType !== "ACTIVITY_END") return false;
            if (cond.value) {
                return parsed.name?.toLowerCase().includes(cond.value.toLowerCase());
            }
            return true;
        }

        case "JOINS_VOICE": {
            if (eventType !== "VOICE_JOIN") return false;
            if (cond.field === "guildId" && cond.value) return parsed.guildId === cond.value;
            if (cond.field === "channelId" && cond.value) return parsed.channelId === cond.value;
            return true;
        }

        case "LEAVES_VOICE":
            return eventType === "VOICE_LEAVE";

        case "SENDS_MESSAGE": {
            if (eventType !== "MESSAGE_CREATE") return false;
            // processed: { messageId, channelId, guildId, … }
            if (cond.field === "channelId" && cond.value) {
                return parsed.channelId === cond.value;
            }
            if (cond.field === "guildId" && cond.value) {
                return parsed.guildId === cond.value;
            }
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
            // processed: { messageId, … } — look up stored content
            const msgId = parsed.messageId;
            if (!msgId) return false;
            try {
                const stmts = getStmts();
                const msg = stmts.getMessage.get(msgId) as any;
                if (msg?.content) {
                    const keywords = (cond.value as string)
                        .split(",")
                        .map((k: string) => k.trim().toLowerCase())
                        .filter(Boolean);
                    const content = msg.content.toLowerCase();
                    return keywords.some((k: string) => content.includes(k));
                }
            } catch (err: any) {
                log.warn(`KEYWORD_MENTION lookup failed: ${err.message}`);
            }
            return false;
        }

        case "NEW_GAME": {
            if (eventType !== "ACTIVITY_START") return false;
            if (parsed.type !== 0) return false;
            // Use rule target or the event's target — never bind undefined to the query
            const queryTarget = rule.target_id || targetId;
            if (!queryTarget) return false;
            try {
                const stmts = getStmts();
                const sessions = stmts.getActivitySessions.all(queryTarget, 0, 1000) as any[];
                const playedBefore = sessions.some((s: any) =>
                    s.activity_name === parsed.name && s.start_time < Date.now() - 60000
                );
                return !playedBefore;
            } catch { }
            return false;
        }

        case "UNUSUAL_HOUR": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            if (parsed.newStatus === "offline") return false;
            const hour = eventTime.getHours();
            const startHour = cond.start_hour ?? 2;
            const endHour = cond.end_hour ?? 6;
            return hour >= startHour && hour < endHour;
        }

        default:
            return false;
    }
}

// ── Alert routing (digest vs immediate) ──────────────────────────────────────

function routeAlert(
    rule: AlertRule,
    targetId: string,
    eventType: string,
    eventData: any
): void {
    if (config.alertDigestMode || rule.digest_mode === 1) {
        const message = generateAlertMessage(rule, targetId, eventType, eventData);
        import("./digest").then(({ addToDigest }) => {
            addToDigest(rule.id, targetId, rule.rule_type, message, Date.now());
        }).catch(() => { });
    } else {
        fireAlert(rule, targetId, eventType, eventData);
    }
}

// ── Fire alert ────────────────────────────────────────────────────────────────

function fireAlert(
    rule: AlertRule,
    targetId: string,
    eventType: string,
    eventData: any
): void {
    const message = generateAlertMessage(rule, targetId, eventType, eventData);
    const now = Date.now();

    // ── Persist to DB — isolated so a DB failure never blocks webhook delivery ──
    try {
        const stmts = getStmts();
        stmts.insertAlertHistory.run(rule.id, targetId, rule.rule_type, message, now);
        stmts.incrementAlertFireCount.run(now, rule.id);

        // Fatigue tracking (in-memory + DB)
        const cached = cachedRules.find(r => r.id === rule.id);
        if (cached) {
            cached.fire_count_24h = (cached.fire_count_24h || 0) + 1;
            cached.last_fire_at = now;

            const threshold = cached.fatigue_threshold || config.alertFatigueThreshold;
            if (cached.fire_count_24h >= threshold) {
                stmts.suppressAlertRule.run(rule.id);
                cached.auto_suppressed = 1;
                log.warn(
                    `Alert rule ${rule.id} (${rule.rule_type}) auto-suppressed ` +
                    `after ${cached.fire_count_24h} fires in 24h`
                );
                pushSSEAlertSuppressed(rule.id, targetId, rule.rule_type);
            }
        }
    } catch (err: any) {
        log.error(`Alert DB write failed for rule ${rule.id} (${rule.rule_type}): ${err.message}`);
        // Continue — webhook must still fire even if DB write fails
    }

    log.info(`ALERT [${rule.rule_type}] target=${targetId}: ${message}`);

    // SSE callback
    alertCallback?.({
        ruleId: rule.id,
        targetId,
        alertType: rule.rule_type,
        message,
    });

    // ── Webhook delivery (non-blocking, fire-and-forget) ──────────────────────
    if (config.alertWebhookUrl) {
        const isDiscord =
            /https?:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//i.test(
                config.alertWebhookUrl
            );

        const body = isDiscord
            ? JSON.stringify({
                content: `**[${rule.rule_type.replace(/_/g, " ")}]** ${message}`,
                username: "Sentinel",
            })
            : JSON.stringify({
                event: "alert",
                ruleId: rule.id,
                targetId,
                alertType: rule.rule_type,
                message,
                timestamp: now,
            });

        log.info(`Sending webhook for [${rule.rule_type}] target=${targetId} (${isDiscord ? "discord" : "generic"})`);

        fetch(config.alertWebhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
        })
            .then(async (res) => {
                if (!res.ok) {
                    const text = await res.text().catch(() => "");
                    log.warn(
                        `Webhook delivery failed: HTTP ${res.status} — ${text.slice(0, 200)}`
                    );
                } else {
                    log.info(
                        `Webhook delivered OK for [${rule.rule_type}] target=${targetId}`
                    );
                }
            })
            .catch((err) =>
                log.warn(`Webhook delivery error: ${err.message}`)
            );
    } else {
        log.warn(`No ALERT_WEBHOOK_URL set — alert [${rule.rule_type}] not delivered via webhook`);
    }
}

function pushSSEAlertSuppressed(ruleId: number, targetId: string, alertType: string): void {
    import("../api/routes/events").then(({ pushSSEEvent }) => {
        pushSSEEvent({
            target_id: targetId,
            event_type: "ALERT_SUPPRESSED",
            timestamp: Date.now(),
            data: { ruleId, alertType, reason: "fatigue_threshold_reached" },
        });
    }).catch(() => { });
}

// ── Alert fire count reset (daily job) ───────────────────────────────────────

export function resetAlertFireCounts(): void {
    const stmts = getStmts();
    const cutoff = Date.now() - 86_400_000;
    stmts.resetAlertFireCounts.run(cutoff);
    reloadRules();
}

// ── Message generation ────────────────────────────────────────────────────────

function generateAlertMessage(
    rule: AlertRule,
    targetId: string,
    eventType: string,
    data: any
): string {
    const parsed = typeof data === "string" ? safeParse(data) : data;

    switch (rule.rule_type) {
        case "COMES_ONLINE":    return `Target ${targetId} came online`;
        case "GOES_OFFLINE":    return `Target ${targetId} went offline`;
        case "STATUS_CHANGE":   return `Target ${targetId} status: ${parsed.oldStatus} -> ${parsed.newStatus}`;
        case "STARTS_ACTIVITY": return `Target ${targetId} started: ${parsed.name || "activity"}`;
        case "STOPS_ACTIVITY":  return `Target ${targetId} stopped: ${parsed.name || "activity"}`;
        case "JOINS_VOICE":     return `Target ${targetId} joined voice channel`;
        case "LEAVES_VOICE":    return `Target ${targetId} left voice channel`;
        case "SENDS_MESSAGE":   return `Target ${targetId} sent a message`;
        case "DELETES_MESSAGE": return `Target ${targetId} deleted a message`;
        case "GHOST_TYPES":     return `Target ${targetId} typed but didn't send`;
        case "PROFILE_CHANGE":  return `Target ${targetId} updated their profile`;
        case "NEW_GAME":        return `Target ${targetId} playing new game: ${parsed.name}`;
        case "UNUSUAL_HOUR":    return `Target ${targetId} online at unusual hour (${new Date().getHours()}:00)`;
        case "KEYWORD_MENTION": return `Target ${targetId} mentioned a tracked keyword`;
        default:                return `Alert triggered for ${targetId}: ${rule.rule_type}`;
    }
}

function safeParse(str: string): any {
    try { return JSON.parse(str); } catch { return {}; }
}