import WebSocket from "ws";
import { EventEmitter } from "events";
import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { GatewayOpcodes, RESUMABLE_CLOSE_CODES } from "./intents";
import { HeartbeatManager } from "./heartbeat";
import { ReconnectManager } from "./reconnect";

const log = createLogger("Gateway");
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const GATEWAY_RATE_LIMIT = 120;
const GATEWAY_RATE_PERIOD = 60_000;

// ── Browser / OS profiles used in the IDENTIFY payload ───────────────────────
// When RANDOM_JITTER=true a profile is chosen at random on every (re)connect,
// making the gateway fingerprint less predictable.
const BROWSER_PROFILES = [
    {
        os: "Windows",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        browser_version: "133.0.0.0",
        os_version: "10",
        client_build_number: 368849,
    },
    {
        os: "Windows",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        browser_version: "132.0.0.0",
        os_version: "10",
        client_build_number: 367905,
    },
    {
        os: "Mac OS X",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        browser_version: "133.0.0.0",
        os_version: "10.15.7",
        client_build_number: 368849,
    },
    {
        os: "Windows",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        browser_version: "131.0.0.0",
        os_version: "10",
        client_build_number: 366994,
    },
    {
        os: "Mac OS X",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        browser_version: "132.0.0.0",
        os_version: "10.15.7",
        client_build_number: 367905,
    },
] as const;

function pickIdentifyProperties() {
    const profile = config.randomJitter
        ? BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)]
        : BROWSER_PROFILES[0];

    return {
        os: profile.os,
        browser: profile.browser,
        device: "",
        system_locale: "en-US",
        browser_user_agent: profile.browser_user_agent,
        browser_version: profile.browser_version,
        os_version: profile.os_version,
        referrer: "",
        referring_domain: "",
        release_channel: "stable",
        client_build_number: profile.client_build_number,
        client_event_source: null,
    };
}

// ── Public interface ──────────────────────────────────────────────────────────
export interface GatewayClient {
    on(event: "dispatch", listener: (eventName: string, data: any) => void): this;
    on(event: "ready",    listener: (data: any) => void): this;
    on(event: "close",    listener: (code: number, reason: string) => void): this;
    on(event: "error",    listener: (error: Error) => void): this;
}

export class GatewayClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private heartbeat  = new HeartbeatManager();
    private reconnect  = new ReconnectManager();

    private sessionId:        string | null = null;
    private resumeGatewayUrl: string | null = null;
    private sequence:         number | null = null;
    private user:  any   = null;
    private guilds: any[] = [];

    private commandsSent   = 0;
    private commandResetAt = 0;
    private destroying     = false;
    private connected      = false;

    private pendingRateLimitTimers: Set<NodeJS.Timeout> = new Set();

    getUser()      { return this.user; }
    getGuilds()    { return this.guilds; }
    getSessionId() { return this.sessionId; }
    isConnected()  { return this.connected; }

    // ── Connection ─────────────────────────────────────────────────────────────
    async connect(): Promise<void> {
        this.destroying = false;
        this.clearPendingTimers();
        this.commandsSent   = 0;
        this.commandResetAt = 0;

        const url = this.resumeGatewayUrl || GATEWAY_URL;
        log.info(`Connecting to gateway: ${url}`);

        this.ws = new WebSocket(url);
        this.ws.binaryType = "nodebuffer";

        this.ws.on("open", () => {
            log.info("WebSocket connection opened");
            this.connected = true;
            this.reconnect.reset();
        });

        this.ws.on("message", (data: Buffer) => {
            this.handleRawMessage(data);
        });

        this.ws.on("close", (code: number, reason: Buffer) => {
            const reasonStr = reason.toString();
            log.warn(`WebSocket closed: ${code} - ${reasonStr}`);
            this.connected = false;
            this.heartbeat.destroy();
            this.clearPendingTimers();
            this.emit("close", code, reasonStr);

            if (!this.destroying) {
                this.handleDisconnect(code);
            }
        });

        this.ws.on("error", (error: Error) => {
            log.error(`WebSocket error: ${error.message}`);
            this.emit("error", error);
        });
    }

    private clearPendingTimers(): void {
        for (const t of this.pendingRateLimitTimers) clearTimeout(t);
        this.pendingRateLimitTimers.clear();
    }

    // ── Message handling ───────────────────────────────────────────────────────
    private handleRawMessage(data: Buffer): void {
        try {
            const payload = JSON.parse(data.toString());
            this.handleMessage(payload);
        } catch (e) {
            log.error("Failed to parse gateway message", e);
        }
    }

    private handleMessage(
        payload: { op: number; d: any; s: number | null; t: string | null }
    ): void {
        if (payload.s !== null) this.sequence = payload.s;

        switch (payload.op) {
            case GatewayOpcodes.DISPATCH:
                this.handleDispatch(payload.t!, payload.d);
                break;
            case GatewayOpcodes.HELLO:
                this.handleHello(payload.d);
                break;
            case GatewayOpcodes.HEARTBEAT:
                this.send(GatewayOpcodes.HEARTBEAT, this.sequence);
                break;
            case GatewayOpcodes.HEARTBEAT_ACK:
                this.heartbeat.ack();
                break;
            case GatewayOpcodes.RECONNECT:
                log.info("Server requested reconnect");
                this.ws?.close(4000);
                break;
            case GatewayOpcodes.INVALID_SESSION:
                log.warn(`Invalid session (resumable: ${payload.d})`);
                if (!payload.d) {
                    this.sessionId        = null;
                    this.sequence         = null;
                    this.resumeGatewayUrl = null;
                }
                this.ws?.close(4000);
                break;
        }
    }

    private handleHello(data: { heartbeat_interval: number }): void {
        log.info(`HELLO received, heartbeat interval: ${data.heartbeat_interval}ms`);

        this.heartbeat.setup(
            data.heartbeat_interval,
            (op, d) => this.send(op, d),
            () => this.sequence,
            () => {
                log.warn("Zombied connection, reconnecting…");
                this.ws?.close(4000);
            }
        );

        if (this.sessionId && this.sequence !== null) {
            this.resume();
        } else {
            this.identify();
        }
    }

    private identify(): void {
        const properties = pickIdentifyProperties();
        log.info(`Sending IDENTIFY (browser: ${properties.browser} on ${properties.os})`);
        this.send(GatewayOpcodes.IDENTIFY, {
            token: config.discordToken,
            capabilities: 16381,
            properties,
            compress: false,
            large_threshold: 250,
        });
    }

    private resume(): void {
        log.info(`Sending RESUME (session: ${this.sessionId}, seq: ${this.sequence})`);
        this.send(GatewayOpcodes.RESUME, {
            token:      config.discordToken,
            session_id: this.sessionId,
            seq:        this.sequence,
        });
    }

    private handleDispatch(eventName: string, data: any): void {
        switch (eventName) {
            case "READY":
                this.sessionId        = data.session_id;
                this.resumeGatewayUrl = data.resume_gateway_url;
                this.user             = data.user;
                this.guilds           = data.guilds || [];
                log.info(
                    `READY! Logged in as ${data.user.username}#${data.user.discriminator} | ` +
                    `${this.guilds.length} guilds | Session: ${this.sessionId}`
                );
                this.emit("ready", data);
                break;
            case "RESUMED":
                log.info("Session resumed successfully");
                this.emit("dispatch", "RESUMED", data);
                return;
        }
        this.emit("dispatch", eventName, data);
    }

    // ── Sending ────────────────────────────────────────────────────────────────
    send(op: number, d: any): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        if (now > this.commandResetAt) {
            this.commandsSent   = 0;
            this.commandResetAt = now + GATEWAY_RATE_PERIOD;
        }

        if (this.commandsSent >= GATEWAY_RATE_LIMIT) {
            log.warn("Gateway rate limit reached, queuing…");
            const delay = this.commandResetAt - now + 100;
            const t = setTimeout(() => {
                this.pendingRateLimitTimers.delete(t);
                this.send(op, d);
            }, delay);
            this.pendingRateLimitTimers.add(t);
            return;
        }

        this.commandsSent++;
        this.ws.send(JSON.stringify({ op, d }));
    }

    requestGuildMembers(guildId: string, userIds: string[], delayMs = 0): void {
        const payload = {
            guild_id:  guildId,
            user_ids:  userIds,
            limit:     0,
            presences: true,
        };
        if (delayMs <= 0) {
            this.send(GatewayOpcodes.REQUEST_GUILD_MEMBERS, payload);
        } else {
            const t = setTimeout(() => {
                this.pendingRateLimitTimers.delete(t);
                this.send(GatewayOpcodes.REQUEST_GUILD_MEMBERS, payload);
            }, delayMs);
            this.pendingRateLimitTimers.add(t);
        }
    }

    // ── Disconnect / reconnect ─────────────────────────────────────────────────
    private handleDisconnect(code: number): void {
        if (code === 4004) {
            log.error("Authentication failed. Check your token.");
            return;
        }
        if (code === 4013 || code === 4014) {
            log.error(`Invalid/disallowed intents (code ${code}).`);
            return;
        }

        if (!RESUMABLE_CLOSE_CODES.has(code)) {
            this.sessionId        = null;
            this.sequence         = null;
            this.resumeGatewayUrl = null;
        }

        const delay = this.reconnect.getDelay();
        log.info(`Reconnecting in ${delay}ms…`);
        setTimeout(() => this.connect(), delay);
    }

    destroy(): void {
        this.destroying = true;
        this.heartbeat.destroy();
        this.clearPendingTimers();
        if (this.ws) {
            this.ws.removeAllListeners();
            if (
                this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING
            ) {
                this.ws.close(1000);
            }
            this.ws = null;
        }
        this.connected = false;
        log.info("Gateway client destroyed");
    }
}