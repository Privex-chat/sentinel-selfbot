import { createLogger } from "../utils/logger";

const log = createLogger("Reconnect");

export class ReconnectManager {
    private attempts = 0;
    private readonly maxDelay = 60000;
    private readonly baseDelay = 1000;

    getDelay(): number {
        const delay = Math.min(this.baseDelay * Math.pow(2, this.attempts), this.maxDelay);
        this.attempts++;
        log.info(`Reconnect attempt ${this.attempts}, delay: ${delay}ms`);
        return delay;
    }

    reset(): void {
        this.attempts = 0;
    }

    getAttempts(): number {
        return this.attempts;
    }
}
