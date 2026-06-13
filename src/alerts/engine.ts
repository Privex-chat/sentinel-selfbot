import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { AlertCondition, AlertRule, EVENT_TO_ALERT_MAP, ParsedComposite } from "./conditions";
import { config } from "../utils/config";
import { enqueueWebhook } from "../utils/webhook-queue";
import { addToDigest } from "./digest";
import { getTargetTimezone } from "../target-lifecycle";
import { getHourInTz } from "../utils/timezone";

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

// ── NEW_GAME known-games cache ───────────────────────────────────────────────
//
// Each ACTIVITY_START used to fan out a 1000-row activity_sessions read just to
// answer "has this target played this game before?". With multiple targets and
// frequent Discord rich-presence activity-start spam, that was a real hot path.
// Cache one Set<gameName> per target; lazy-seeded from the DB on first miss with
// a 60 s cutoff so the just-inserted session row from the current event doesn't
// shadow itself.
const knownGamesByTarget = new Map<string, Set<string>>();

function getKnownGames(targetId: string): Set<string> {
    let set = knownGamesByTarget.get(targetId);
    if (set) return set;

    try {
        const stmts = getStmts();
        const cutoff = Date.now() - 60_000;
        const rows = stmts.getDistinctGameNamesBefore.all(targetId, cutoff) as Array<{ activity_name: string }>;
        set = new Set(rows.map(r => r.activity_name));
    } catch (err: any) {
        log.warn(`NEW_GAME cache seed failed for ${targetId}: ${err.message}`);
        set = new Set();
    }

    knownGamesByTarget.set(targetId, set);
    return set;
}

function cleanupStaleCompositeState(): void {
    const now = Date.now();
    for (const [ruleId, targetMap] of compositeTracker) {
        const rule = cachedRules.find(r => r.id === ruleId);
        if (!rule?.composite_condition) {
            compositeTracker.delete(ruleId);
            continue;
        }
        const windowMs = rule.composite_condition.window_ms || 300_000;

        for (const [targetId, state] of targetMap) {
            if (now - state.firstSatisfiedAt > windowMs) {
                targetMap.delete(targetId);
            }
        }
        if (!targetMap.size) compositeTracker.delete(ruleId);
    }
}

setInterval(cleanupStaleCompositeState, 60_000).unref?.();

/** Drop every composite-tracker entry for this target across all rules.
 *  Also clears the NEW_GAME known-games cache so a re-added target with the
 *  same userId starts fresh (and re-seeds from any historical activity rows). */
export function removeTargetState(targetId: string): void {
    for (const [ruleId, targetMap] of compositeTracker) {
        targetMap.delete(targetId);
        if (!targetMap.size) compositeTracker.delete(ruleId);
    }
    knownGamesByTarget.delete(targetId);
}

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
        // Parse composite_condition ONCE on load. The hot path used to JSON.parse
        // on every event + every cleanup tick — for a busy install with several
        // composite rules that's tens of parses per second.
        composite_condition: parseComposite(r.composite_condition),
        digest_mode:         r.digest_mode          ?? 0,
    }));
    log.info(`Loaded ${cachedRules.length} active alert rules`);
}

function parseCondition(raw: string): AlertCondition {
    try { return JSON.parse(raw); } catch { return {}; }
}

function parseComposite(raw: string | null | undefined): ParsedComposite | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.conditions)) {
            return null;
        }
        return {
            operator:   typeof parsed.operator === "string" ? parsed.operator : "AND",
            window_ms:  typeof parsed.window_ms === "number" ? parsed.window_ms : 300_000,
            conditions: parsed.conditions,
        };
    } catch {
        return null;
    }
}

export function evaluateEvent(
    eventType: string,
    targetId: string,
    eventData: any,
    eventTimestamp?: number
): void {
    const alertTypes = EVENT_TO_ALERT_MAP[eventType];
    if (!alertTypes) return;

    log.debug(`evaluateEvent: ${eventType} target=${targetId} rules=${cachedRules.length} digestMode=${config.alertDigestMode}`);

    const ts = eventTimestamp || Date.now();

    for (const rule of cachedRules) {
        // Normalise to string — SQLite may return target_id as number if stored without TEXT affinity
        const ruleTarget = rule.target_id != null ? String(rule.target_id) : null;

        if (ruleTarget && ruleTarget !== targetId) {
            log.debug(`  rule ${rule.id} (${rule.rule_type}): skip — ruleTarget="${ruleTarget}" != "${targetId}"`);
            continue;
        }

        if (rule.auto_suppressed === 1) {
            log.debug(`  rule ${rule.id} (${rule.rule_type}): skip — auto_suppressed`);
            continue;
        }

        if (rule.composite_condition) {
            log.debug(`  rule ${rule.id} (${rule.rule_type}): composite — delegating`);
            handleCompositeRule(rule, eventType, targetId, eventData, ts);
            continue;
        }

        if (!alertTypes.includes(rule.rule_type)) {
            log.debug(`  rule ${rule.id} (${rule.rule_type}): skip — rule_type not in alertTypes [${alertTypes.join(",")}]`);
            continue;
        }

        const matched = matchesCondition(rule, eventType, eventData, ts, targetId);
        log.debug(`  rule ${rule.id} (${rule.rule_type}): matchesCondition=${matched}`);
        if (matched) {
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
    const cc = rule.composite_condition;
    if (!cc) return;

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

    // Parse once — data is always a JSON string from the collector
    const parsed: any = typeof data === "string" ? safeParse(data) : data;

    // Per-target tz drives any hour-of-day comparison so "after 10pm" / "between
    // 2am and 6am" mean 10pm/2am-in-the-target's-clock, not the host's. Lazily
    // looked up only by branches that need it.
    const targetTz = getTargetTimezone(targetId);

    switch (rule.rule_type) {
        case "COMES_ONLINE": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            // processed: { newStatus, oldStatus, … }
            if (parsed.newStatus !== "online") return false;
            if (cond.after_hour !== undefined) {
                const hour = getHourInTz(eventTimestamp, targetTz);
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
            if (!queryTarget || !parsed.name) return false;

            const games = getKnownGames(queryTarget);
            const isNew = !games.has(parsed.name);
            // Record regardless of fire decision so the next ACTIVITY_START for
            // the same game doesn't re-fire. Cheap and reliable.
            games.add(parsed.name);
            return isNew;
        }

        case "UNUSUAL_HOUR": {
            if (eventType !== "PRESENCE_UPDATE") return false;
            if (parsed.newStatus === "offline") return false;
            const hour = getHourInTz(eventTimestamp, targetTz);
            const startHour = cond.start_hour ?? 2;
            const endHour = cond.end_hour ?? 6;
            return hour >= startHour && hour < endHour;
        }

        default:
            return false;
    }
}

// ── Alert routing — always immediate ─────────────────────────────────────────
// Digest mode is kept for SSE batching only; the webhook always fires instantly.

function routeAlert(
    rule: AlertRule,
    targetId: string,
    eventType: string,
    eventData: any
): void {
    // Always fire the webhook immediately
    fireAlert(rule, targetId, eventType, eventData);

    // Optionally also buffer into digest for SSE display (no webhook side effect —
    // digest is SSE-only; webhook delivery already fired above)
    if (config.alertDigestMode || rule.digest_mode === 1) {
        const message = generateAlertMessage(rule, targetId, eventType, eventData);
        addToDigest(rule.id, targetId, rule.rule_type, message, Date.now());
    }
}

// ── Alert colors ─────────────────────────────────────────────────────────────

const ALERT_COLORS: Record<string, number> = {
    SENDS_MESSAGE:    0x5865f2,
    DELETES_MESSAGE:  0xed4245,
    JOINS_VOICE:      0x57f287,
    LEAVES_VOICE:     0xfee75c,
    COMES_ONLINE:     0x57f287,
    GOES_OFFLINE:     0x747f8d,
    STATUS_CHANGE:    0xfee75c,
    STARTS_ACTIVITY:  0x9b59b6,
    STOPS_ACTIVITY:   0x747f8d,
    GHOST_TYPES:      0xe67e22,
    PROFILE_CHANGE:   0x3498db,
    KEYWORD_MENTION:  0xe74c3c,
    NEW_GAME:         0x9b59b6,
    UNUSUAL_HOUR:     0xe67e22,
};

const ACTIVITY_TYPES: Record<number, string> = {
    0: "Game", 1: "Streaming", 2: "Listening", 3: "Watching", 5: "Competing",
};

// ── Rich embed builder ────────────────────────────────────────────────────────

function buildAlertEmbed(
    rule: AlertRule, targetId: string, eventType: string, data: any
): object {
    const parsed    = typeof data === "string" ? safeParse(data) : data;
    const timestamp = new Date().toISOString();
    const color     = ALERT_COLORS[rule.rule_type] ?? 0xffffff;
    const footer    = { text: `Sentinel • Rule #${rule.id}` };

    let targetDisplay = targetId;
    try {
        const target = getStmts().getTarget.get(targetId) as any;
        if (target?.label) targetDisplay = `${target.label} (${targetId})`;
    } catch { /* non-fatal */ }

    type Field = { name: string; value: string; inline?: boolean };
    const f = (name: string, value: string, inline = true): Field => ({ name, value, inline });
    const base: Field[] = [f("Target", `\`${targetDisplay}\``)];

    function msgContent(msgId: string, fieldName = "Content"): Field | null {
        try {
            const msg = getStmts().getMessage.get(msgId) as any;
            if (!msg?.content || !msg.content.trim()) return null;
            const text = msg.content.length > 1000
                ? msg.content.slice(0, 997) + "..."
                : msg.content;
            return f(fieldName, text, false);
        } catch { return null; }
    }

    switch (rule.rule_type) {

        case "SENDS_MESSAGE": {
            const fields: Field[] = [...base];
            if (parsed.channelId) fields.push(f("Channel", `<#${parsed.channelId}>`));
            if (parsed.guildId)   fields.push(f("Server",  `\`${parsed.guildId}\``));
            const c = parsed.messageId ? msgContent(parsed.messageId) : null;
            if (c) fields.push(c);
            const stats: string[] = [];
            if (parsed.wordCount > 0) stats.push(`${parsed.wordCount} words`);
            if (parsed.attachmentCount > 0) stats.push(`${parsed.attachmentCount} attachment(s)`);
            if (parsed.embedCount > 0) stats.push(`${parsed.embedCount} embed(s)`);
            if (parsed.isReply) stats.push("reply");
            if (stats.length) fields.push(f("Details", stats.join(" · "), false));
            return { title: "Message Sent", color, fields, footer, timestamp };
        }

        case "DELETES_MESSAGE": {
            const fields: Field[] = [...base];
            if (parsed.channelId) fields.push(f("Channel", `<#${parsed.channelId}>`));
            if (parsed.guildId)   fields.push(f("Server",  `\`${parsed.guildId}\``));
            const c = parsed.messageId ? msgContent(parsed.messageId, "Deleted Content") : null;
            if (c) fields.push(c);
            const stats: string[] = [];
            if (parsed.wordCount > 0) stats.push(`${parsed.wordCount} words`);
            if (parsed.contentLength > 0) stats.push(`${parsed.contentLength} chars`);
            if (stats.length) fields.push(f("Details", stats.join(" · "), false));
            return { title: "Message Deleted", color, fields, footer, timestamp };
        }

        case "JOINS_VOICE": {
            const fields: Field[] = [...base];
            if (parsed.guildId)   fields.push(f("Server",  `\`${parsed.guildId}\``));
            if (parsed.channelId) fields.push(f("Channel", `\`${parsed.channelId}\``));
            return { title: "Joined Voice Channel", color, fields, footer, timestamp };
        }

        case "LEAVES_VOICE": {
            const fields: Field[] = [...base];
            if (parsed.guildId)   fields.push(f("Server",  `\`${parsed.guildId}\``));
            if (parsed.channelId) fields.push(f("Channel", `\`${parsed.channelId}\``));
            return { title: "Left Voice Channel", color, fields, footer, timestamp };
        }

        case "COMES_ONLINE": {
            const fields: Field[] = [...base];
            if (parsed.platform) fields.push(f("Platform", parsed.platform));
            if (parsed.newStatus && parsed.newStatus !== "online") fields.push(f("Status", parsed.newStatus));
            return { title: "Came Online", color, fields, footer, timestamp };
        }

        case "GOES_OFFLINE": {
            const fields: Field[] = [...base];
            const lastPlatform = parsed.oldPlatform || parsed.platform;
            if (lastPlatform) fields.push(f("Last Platform", lastPlatform));
            return { title: "Went Offline", color, fields, footer, timestamp };
        }

        case "STATUS_CHANGE": {
            const fields: Field[] = [...base];
            fields.push(f("Change", `${parsed.oldStatus || "?"} → ${parsed.newStatus || "?"}`));
            if (parsed.platform) fields.push(f("Platform", parsed.platform));
            return { title: "Status Changed", color, fields, footer, timestamp };
        }

        case "STARTS_ACTIVITY": {
            const fields: Field[] = [...base];
            if (parsed.name) fields.push(f("Activity", parsed.name));
            if (parsed.type !== undefined) fields.push(f("Type", ACTIVITY_TYPES[parsed.type] ?? String(parsed.type)));
            if (parsed.details) fields.push(f("Details", parsed.details, false));
            if (parsed.state)   fields.push(f("State",   parsed.state,   false));
            return { title: "Started Activity", color, fields, footer, timestamp };
        }

        case "STOPS_ACTIVITY": {
            const fields: Field[] = [...base];
            if (parsed.name) fields.push(f("Activity", parsed.name));
            return { title: "Stopped Activity", color, fields, footer, timestamp };
        }

        case "GHOST_TYPES": {
            const fields: Field[] = [...base];
            if (parsed.channelId) fields.push(f("Channel", `<#${parsed.channelId}>`));
            if (parsed.guildId)   fields.push(f("Server",  `\`${parsed.guildId}\``));
            return { title: "Typed Without Sending", color, fields, footer, timestamp };
        }

        case "PROFILE_CHANGE": {
            const fields: Field[] = [...base];
            if (Array.isArray(parsed.changes) && parsed.changes.length) {
                fields.push(f("Changes", parsed.changes.join("\n").slice(0, 500), false));
            } else if (parsed.field) {
                fields.push(f("Field", parsed.field));
                if (parsed.newValue !== undefined) fields.push(f("New Value", String(parsed.newValue)));
            }
            return { title: "Profile Updated", color, fields, footer, timestamp };
        }

        case "KEYWORD_MENTION": {
            const fields: Field[] = [...base];
            if (parsed.channelId) fields.push(f("Channel", `<#${parsed.channelId}>`));
            if (parsed.guildId)   fields.push(f("Server",  `\`${parsed.guildId}\``));
            const c = parsed.messageId ? msgContent(parsed.messageId) : null;
            if (c) fields.push(c);
            return { title: "Keyword Mentioned", color, fields, footer, timestamp };
        }

        case "NEW_GAME": {
            const fields: Field[] = [...base];
            if (parsed.name) fields.push(f("Game", parsed.name, false));
            return { title: "Playing a New Game", color, fields, footer, timestamp };
        }

        case "UNUSUAL_HOUR": {
            const fields: Field[] = [...base];
            const tz = getTargetTimezone(targetId);
            fields.push(f("Local Hour", `${getHourInTz(Date.now(), tz)}:00 (${tz})`));
            if (parsed.newStatus) fields.push(f("Status", parsed.newStatus));
            if (parsed.platform)  fields.push(f("Platform", parsed.platform));
            return { title: "Online at Unusual Hour", color, fields, footer, timestamp };
        }

        default:
            return { title: rule.rule_type.replace(/_/g, " "), color, fields: base, footer, timestamp };
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

    // ── Persist to DB ─────────────────────────────────────────────────────────
    try {
        const stmts = getStmts();
        stmts.insertAlertHistory.run(rule.id, targetId, rule.rule_type, message, now);
        stmts.incrementAlertFireCount.run(now, rule.id);

        const cached = cachedRules.find(r => r.id === rule.id);
        if (cached) {
            cached.fire_count_24h = (cached.fire_count_24h || 0) + 1;
            cached.last_fire_at = now;

            const threshold = cached.fatigue_threshold || config.alertFatigueThreshold;
            if (cached.fire_count_24h >= threshold) {
                stmts.suppressAlertRule.run(rule.id);
                cached.auto_suppressed = 1;
                log.warn(`Alert rule ${rule.id} (${rule.rule_type}) auto-suppressed after ${cached.fire_count_24h} fires in 24h`);
                pushSSEAlertSuppressed(rule.id, targetId, rule.rule_type);
            }
        }
    } catch (err: any) {
        log.error(`Alert DB write failed for rule ${rule.id}: ${err.message}`);
    }

    log.info(`ALERT [${rule.rule_type}] target=${targetId}: ${message}`);

    alertCallback?.({ ruleId: rule.id, targetId, alertType: rule.rule_type, message });

    // ── Webhook delivery ──────────────────────────────────────────────────────
    if (!config.alertWebhookUrl) {
        log.warn(`No ALERT_WEBHOOK_URL — alert [${rule.rule_type}] not delivered`);
        return;
    }

    const isDiscord =
        /https?:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//i.test(config.alertWebhookUrl);

    const body = isDiscord
        ? JSON.stringify({
            username: "Sentinel",
            embeds: [buildAlertEmbed(rule, targetId, eventType, eventData)],
        })
        : JSON.stringify({
            event:     "alert",
            ruleId:    rule.id,
            targetId,
            alertType: rule.rule_type,
            message,
            timestamp: now,
            data:      typeof eventData === "string" ? safeParse(eventData) : eventData,
        });

    log.info(`Queueing webhook for [${rule.rule_type}] target=${targetId}`);
    enqueueWebhook(config.alertWebhookUrl, body, `alert:${rule.rule_type}:${targetId}`);
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
        case "UNUSUAL_HOUR":    return `Target ${targetId} online at unusual hour (${getHourInTz(Date.now(), getTargetTimezone(targetId))}:00 ${getTargetTimezone(targetId)})`;
        case "KEYWORD_MENTION": return `Target ${targetId} mentioned a tracked keyword`;
        default:                return `Alert triggered for ${targetId}: ${rule.rule_type}`;
    }
}

function safeParse(str: string): any {
    try { return JSON.parse(str); } catch { return {}; }
}