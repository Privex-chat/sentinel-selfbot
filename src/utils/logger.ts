import { config } from "./config";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

function getTimestamp(): string {
    return new Date().toISOString();
}

function shouldLog(level: keyof typeof LOG_LEVELS): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
}

function formatMessage(level: string, module: string, message: string, data?: any): string {
    const ts = getTimestamp();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${module}]`;
    if (data !== undefined) {
        return `${prefix} ${message} ${JSON.stringify(data)}`;
    }
    return `${prefix} ${message}`;
}

export function createLogger(module: string) {
    return {
        debug(message: string, data?: any) {
            if (shouldLog("debug")) {
                console.debug(formatMessage("debug", module, message, data));
            }
        },
        info(message: string, data?: any) {
            if (shouldLog("info")) {
                console.info(formatMessage("info", module, message, data));
            }
        },
        warn(message: string, data?: any) {
            if (shouldLog("warn")) {
                console.warn(formatMessage("warn", module, message, data));
            }
        },
        error(message: string, data?: any) {
            if (shouldLog("error")) {
                console.error(formatMessage("error", module, message, data));
            }
        },
    };
}
