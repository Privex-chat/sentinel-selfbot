export interface AlertCondition {
    field?: string;
    operator?: "eq" | "neq" | "contains" | "gt" | "lt" | "after_hour" | "before_hour";
    value?: any;
    after_hour?: number;
    before_hour?: number;
    start_hour?: number;
    end_hour?: number;
}

/** Parsed composite-rule envelope. The raw form on disk is a JSON string;
 *  reloadRules() parses it once and caches this shape on every AlertRule so
 *  the hot path doesn't re-parse on every event. */
export interface ParsedComposite {
    operator: string;
    window_ms: number;
    conditions: Array<{ rule_type: string; condition?: AlertCondition }>;
}

export interface AlertRule {
    id: number;
    target_id: string | null;
    rule_type: string;
    condition: AlertCondition;
    enabled: number;
    created_at: number;
    // v2 fields
    fire_count_24h: number;
    last_fire_at: number | null;
    auto_suppressed: number;
    fatigue_threshold: number;
    composite_condition: ParsedComposite | null;
    digest_mode: number;
}

export const ALERT_TYPES = {
    COMES_ONLINE: "COMES_ONLINE",
    GOES_OFFLINE: "GOES_OFFLINE",
    STARTS_ACTIVITY: "STARTS_ACTIVITY",
    STOPS_ACTIVITY: "STOPS_ACTIVITY",
    JOINS_VOICE: "JOINS_VOICE",
    LEAVES_VOICE: "LEAVES_VOICE",
    SENDS_MESSAGE: "SENDS_MESSAGE",
    DELETES_MESSAGE: "DELETES_MESSAGE",
    GHOST_TYPES: "GHOST_TYPES",
    STATUS_CHANGE: "STATUS_CHANGE",
    PROFILE_CHANGE: "PROFILE_CHANGE",
    UNUSUAL_HOUR: "UNUSUAL_HOUR",
    NEW_GAME: "NEW_GAME",
    KEYWORD_MENTION: "KEYWORD_MENTION",
} as const;

// Maps event types to alert rule types
export const EVENT_TO_ALERT_MAP: Record<string, string[]> = {
    PRESENCE_UPDATE: [ALERT_TYPES.COMES_ONLINE, ALERT_TYPES.GOES_OFFLINE, ALERT_TYPES.STATUS_CHANGE, ALERT_TYPES.UNUSUAL_HOUR],
    ACTIVITY_START: [ALERT_TYPES.STARTS_ACTIVITY, ALERT_TYPES.NEW_GAME],
    ACTIVITY_END: [ALERT_TYPES.STOPS_ACTIVITY],
    VOICE_JOIN: [ALERT_TYPES.JOINS_VOICE],
    VOICE_LEAVE: [ALERT_TYPES.LEAVES_VOICE],
    MESSAGE_CREATE: [ALERT_TYPES.SENDS_MESSAGE, ALERT_TYPES.KEYWORD_MENTION],
    MESSAGE_DELETE: [ALERT_TYPES.DELETES_MESSAGE],
    GHOST_TYPE: [ALERT_TYPES.GHOST_TYPES],
    PROFILE_UPDATE: [ALERT_TYPES.PROFILE_CHANGE],
    AVATAR_CHANGE: [ALERT_TYPES.PROFILE_CHANGE],
    USERNAME_CHANGE: [ALERT_TYPES.PROFILE_CHANGE],
};
