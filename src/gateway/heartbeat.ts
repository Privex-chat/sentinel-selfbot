import { createLogger } from "../utils/logger";

const log = createLogger("Heartbeat");

export class HeartbeatManager {
    private interval: NodeJS.Timeout | null = null;
    private jitterTimeout: NodeJS.Timeout | null = null;
    private lastAck = true;
    private intervalMs = 0;
    private sendFn: ((op: number, d: any) => void) | null = null;
    private onZombied: (() => void) | null = null;
    private sequenceFn: (() => number | null) | null = null;

    setup(
        intervalMs: number,
        sendFn: (op: number, d: any) => void,
        sequenceFn: () => number | null,
        onZombied: () => void
    ): void {
        this.destroy();
        this.intervalMs = intervalMs;
        this.sendFn = sendFn;
        this.sequenceFn = sequenceFn;
        this.onZombied = onZombied;
        this.lastAck = true;

        const jitter = Math.random() * intervalMs;
        this.jitterTimeout = setTimeout(() => {
            this.jitterTimeout = null;
            this.beat();
            this.interval = setInterval(() => this.beat(), intervalMs);
        }, jitter);

        log.info(`Heartbeat started with interval ${intervalMs}ms (jitter: ${Math.round(jitter)}ms)`);
    }

    ack(): void {
        this.lastAck = true;
        log.debug("Heartbeat ACK received");
    }

    private beat(): void {
        if (!this.lastAck) {
            log.warn("Zombied connection detected (no ACK received)");
            this.onZombied?.();
            return;
        }

        this.lastAck = false;
        const seq = this.sequenceFn?.() ?? null;
        this.sendFn?.(1, seq);
        log.debug(`Heartbeat sent (seq: ${seq})`);
    }

    destroy(): void {
        if (this.jitterTimeout) {
            clearTimeout(this.jitterTimeout);
            this.jitterTimeout = null;
        }
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.sendFn = null;
        this.onZombied = null;
        this.sequenceFn = null;
        log.debug("Heartbeat destroyed");
    }
}
