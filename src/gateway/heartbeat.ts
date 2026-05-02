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

    // Latency tracking — measured as time between sending a heartbeat and receiving its ACK.
    private beatSentAt  = 0;
    private latencyMs: number | null = null;

    /** Last measured gateway heartbeat round-trip latency in ms, or null if not yet measured. */
    getLatencyMs(): number | null { return this.latencyMs; }

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
        if (this.beatSentAt > 0) {
            this.latencyMs = Date.now() - this.beatSentAt;
        }
        this.lastAck = true;
        log.debug(`Heartbeat ACK received (latency: ${this.latencyMs ?? "?"}ms)`);
    }

    private beat(): void {
        if (!this.lastAck) {
            log.warn("Zombied connection detected (no ACK received)");
            this.onZombied?.();
            return;
        }

        this.lastAck = false;
        this.beatSentAt = Date.now();
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
