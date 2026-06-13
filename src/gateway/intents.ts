// Selfbots IDENTIFY with `capabilities`, not `intents` (intents are bot-only).
// The intent bitmask constants previously exported here were unused and have
// been removed. See gateway/client.ts:identify() for the capabilities value.

export enum GatewayOpcodes {
    DISPATCH = 0,
    HEARTBEAT = 1,
    IDENTIFY = 2,
    PRESENCE_UPDATE = 3,
    VOICE_STATE_UPDATE = 4,
    RESUME = 6,
    RECONNECT = 7,
    REQUEST_GUILD_MEMBERS = 8,
    INVALID_SESSION = 9,
    HELLO = 10,
    HEARTBEAT_ACK = 11,
    // Op 14 is an undocumented user-client opcode. It tells Discord to stream
    // real-time PRESENCE_UPDATE events (including offline transitions) for a
    // guild. Without it, large guilds (>~100 members) send no presence stream.
    GUILD_SUBSCRIBE = 14,
}

export enum GatewayCloseCodes {
    UNKNOWN_ERROR = 4000,
    UNKNOWN_OPCODE = 4001,
    DECODE_ERROR = 4002,
    NOT_AUTHENTICATED = 4003,
    AUTHENTICATION_FAILED = 4004,
    ALREADY_AUTHENTICATED = 4005,
    INVALID_SEQ = 4007,
    RATE_LIMITED = 4008,
    SESSION_TIMED_OUT = 4009,
    INVALID_SHARD = 4010,
    SHARDING_REQUIRED = 4011,
    INVALID_API_VERSION = 4012,
    INVALID_INTENTS = 4013,
    DISALLOWED_INTENTS = 4014,
}

export const RESUMABLE_CLOSE_CODES = new Set([
    4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009,
]);
