const DISCORD_EPOCH = 1420070400000n;

export function snowflakeToTimestamp(snowflake: string): number {
    const id = BigInt(snowflake);
    return Number((id >> 22n) + DISCORD_EPOCH);
}

export function timestampToSnowflake(timestamp: number): string {
    const ms = BigInt(timestamp) - DISCORD_EPOCH;
    return (ms << 22n).toString();
}

export function getSnowflakeAge(snowflake: string): number {
    return Date.now() - snowflakeToTimestamp(snowflake);
}
