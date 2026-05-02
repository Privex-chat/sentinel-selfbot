<table align="center">
  <tr>
    <td>
      <img src="https://github.com/Privex-chat/sentinel/blob/10876a3b78636b7005dbef21938a0fe70108a6ce/assets/cropped_circle_image.png" alt="Sentinel Logo" width="220" style="vertical-align: middle;">
    </td>
    <td>
      <h1>🔧 sentinel-selfbot</h1>
      <h3><em>The data collection engine for the Sentinel ecosystem</em></h3>
      <p>Connects to Discord as a user account, logs behavioral data on tracked targets, and exposes everything through a local REST/SSE API — with AI-powered analysis and real-time event-driven presence tracking.</p>
    </td>
  </tr>
</table>

Part of the [Sentinel](https://github.com/Privex-chat/sentinel) project.
<p align="center">
  <a href="https://github.com/Privex-chat/sentinel-selfbot"><img src="https://img.shields.io/github/stars/Privex-chat/sentinel-selfbot?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/Privex-chat/sentinel-selfbot"><img src="https://img.shields.io/github/forks/Privex-chat/sentinel-selfbot?style=social" alt="GitHub forks"></a>
  <br>
  <a href="https://polyformproject.org/licenses/noncommercial/1.0.0"><img src="https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/status-active-brightgreen" alt="Project Status">
  <img src="https://img.shields.io/badge/self‑hosted-yes-green" alt="Self-Hosted">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node version">
  <img src="https://img.shields.io/badge/AI-ready-blueviolet" alt="AI Ready">
</p>

---

## 🧠 What It Does

Add a user ID. From that moment, the selfbot records everything it can observe:

- 🟢 **Online / offline presence** — real-time, event-driven, including which device (desktop / mobile / web)
- 🎮 **Games & activities** — what they play, for how long, with rich metadata
- 🎵 **Spotify listening** — tracks, albums, artists, timestamps
- 🖥️ **Custom status changes** — every status text and emoji set or cleared
- 🎙️ **Voice channel movements** — joins, leaves, moves, mute/deafen state, co-participants
- 💬 **Messages** — sent, edited, deleted (content preserved before deletion)
- 👻 **Ghost typing** — started typing but never sent
- 🖼️ **Profile changes** — username, display name, avatar, bio, connected accounts (Twitter, Steam, etc.)
- 🔔 **Platform switches** — detects when a target moves from desktop to mobile mid-session
- 🖥️ **Self-commands** — manage tracking from any Discord channel with instant trace deletion

**AI-powered intelligence (optional):**

- 🏷️ **Message categorization** — every message auto-tagged (gaming, music, venting, humor, etc.)
- 🌐 **AI social graph** — relationship classification with confidence scores (close friend, romantic interest, group buddy…)
- 📰 **Daily intelligence briefs** — morning summary with anomalies and behavioral changes
- 🔄 **Historical message backfill** — fills in the past automatically when you start tracking someone
- 🔔 **Smarter alerts** — digest mode, fatigue prevention, instant Discord webhooks

All data lives in a local SQLite database. Optional Supabase sync gives a cloud mirror for backup or cross-device access.

---

## ⚡ How Presence Tracking Works

Sentinel uses Discord's **op 14 (GUILD_SUBSCRIBE) gateway opcode** with a `members` array to subscribe to real-time presence events for specific users. When a tracked target changes status — online, idle, DND, or **offline** — Discord pushes the change immediately as a `PRESENCE_UPDATE` event. No polling delay.

Key properties:
- **Offline detection is instant** — no waiting for a poll cycle
- **Subscriptions refresh automatically** — re-sent on every reconnect, session resume, and every 4 minutes in case of silent expiry
- **New targets subscribe within 5 seconds** of being added via the API or self-command
- **Platform switches tracked independently** — moving from desktop to mobile without a status change is its own event

> Requires at least one mutual Discord server between the selfbot account and the target.

→ Technical deep-dive: [docs/presence-tracking.md](https://github.com/Privex-chat/sentinel/blob/main/docs/presence-tracking.md)

---

## 🖥️ Self-Command System

Type commands in any Discord channel (including your own private servers). The triggering message is deleted **immediately** before anyone else sees it. Feedback appears as a temporary message that self-deletes after a few seconds — no permanent trace in the channel.

| Command | Description |
|---|---|
| `$add <@user>` | Add a tracking target |
| `$remove <@user>` | Remove a target (deletes all history) |
| `$pause <@user>` | Suspend tracking without deleting history |
| `$resume <@user>` | Re-activate a paused target |
| `$label <@user> <text>` | Set a display label for a target |
| `$note <@user> <text>` | Append a timestamped note to a target |
| `$status <@user>` | Current presence, platform & activities |
| `$seen <@user>` | When the target was last online |
| `$uptime <@user>` | Today's total active time with progress bar |
| `$streak <@user>` | How long in current status uninterrupted |
| `$history <@user> [n]` | Last N presence transitions with timestamps |
| `$pattern <@user>` | 30-day hourly activity heatmap (`▁▂▃▄▅▆▇█`) |
| `$list` | All active targets with live status |
| `$ping` | REST & gateway heartbeat latency check |
| `$stats` | System stats (targets, events, DB size, uptime) |
| `$reload` | Reload alert rules & runtime config live |
| `$help` | Full command reference |

All commands accept `<@mention>` or a raw Discord user ID snowflake.

→ Full reference: [docs/commands.md](https://github.com/Privex-chat/sentinel/blob/main/docs/commands.md)

---

## 🤖 AI-Powered Features

### 🌐 AI Social Graph Analysis

Uses an LLM to examine the texture of interactions — sentiment, reply speed, topic clustering, initiation balance, voice co-presence times — and classifies relationships:

`close friend`, `romantic interest`, `group friend`, `conflict relationship`, `server contact`, and more.

Each classification includes a **confidence score** and a **relationship timeline** showing how the connection has evolved over weeks.

### 🏷️ Message Categorization

Messages are automatically tagged with categories like *gaming*, *music*, *venting*, *humor*, *planning*, *questions*, etc. Works by batching recent messages through a lightweight LLM call, configurable batch size.

### 📰 Automated Daily Briefs

Every morning at your configured time, Sentinel generates a plain-text summary per active target:
- Presence duration and devices used
- Games and music played
- Message counts (including deleted / ghost typing)
- Voice channel activity
- Profile changes
- Anomaly flags

### 🔄 Historical Message Backfill

When you add a target, Sentinel walks backwards through every shared channel to fill in past messages. Configurable depth (max days, max messages per channel). The API exposes live progress per channel.

### 🔔 Alert System

- **14 alert types** — comes online, goes offline, starts activity, joins voice, sends message, ghost types, profile change, unusual hour, new game, keyword mention, and more
- **Digest mode** — batch alerts into a single notification every N minutes
- **Fatigue detection** — auto-suppress rules that fire too often (configurable threshold)
- **Composite conditions** — combine multiple conditions in one rule
- **Discord webhooks** — normal alerts and critical system errors routed to separate channels

---

## Some Screenshots

Sentinel logging multiple targets' messages across servers:
<p align="center">
  <img src="https://github.com/Privex-chat/sentinel/blob/8f32961fea344aefe68157d298e1392ceeb316b5/assets/Sentinel_Logging_Targets_Messages.PNG" alt="Selfbot collecting data" height="550" width="720">
</p>

Sentinel running AI Social Relation/Graph Analysis:
<p align="center">
  <img src="https://github.com/Privex-chat/sentinel/blob/4dd4af3a49712f7756c9238d1fda6a1c6a3f4ca7/assets/Sentinel_AI_Social_Graph_Analyzing.PNG" alt="AI social graph analysis" height="550" width="720">
</p>

<p align="center">
  <b>View more:</b> <a href="https://github.com/Privex-chat/sentinel">github.com/Privex-chat/sentinel</a>
</p>

---

## ⚡ Quick Start

```bash
git clone https://github.com/Privex-chat/sentinel-selfbot.git
cd sentinel-selfbot
npm install
cp .env.example .env
# Edit .env — set DISCORD_TOKEN, API_AUTH_TOKEN, and optionally AI provider
npm run build && npm start
```

Then connect the plugin or web panel to `http://localhost:48923`.

Full setup guide: [docs/selfbot.md](https://github.com/Privex-chat/sentinel/blob/main/docs/selfbot.md)

---

## ⚙️ Configuration

<details>
<summary>Click to expand the full <code>.env</code> reference</summary>

```env
# ── Core (requires restart to change) ────────────────────────────────────────
DISCORD_TOKEN=your_account_token_here
API_PORT=48923
API_AUTH_TOKEN=generate_a_random_string_here
DB_PATH=./data/sentinel.db
LOG_LEVEL=info

# RANDOM_JITTER=true — adds ±20% jitter to polling intervals so requests
# don't fire on a predictable schedule. Also randomises the browser/OS
# fingerprint sent in the Discord gateway IDENTIFY and REST headers.
# Recommended for Railway / cloud deployments.
RANDOM_JITTER=false

# ── Database mode (requires restart) ─────────────────────────────────────────
# local       — SQLite only. Default.
# local+cloud — SQLite live DB + async Supabase mirror.
# cloud       — Hydrates SQLite from Supabase on boot. For Railway / Fly.io.
DB_MODE=local
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SYNC_INTERVAL_MS=300000   # cloud recommended: 30000

# ── All settings below are hot-reloadable via PATCH /api/config ───────────────
PROFILE_POLL_INTERVAL_MS=300000
STATUS_POLL_INTERVAL_MS=120000
DAILY_SUMMARY_INTERVAL_MS=3600000

# ── AI Provider ───────────────────────────────────────────────────────────────
# Providers: none (default) | gemini | ollama | openai | anthropic
# Gemini recommended — free tier: 15 RPM / 1M tokens per day
# Get a free key: https://aistudio.google.com

AI_PROVIDER=none
AI_MODEL=gemini-2.5-flash
AI_API_KEY=
AI_BASE_URL=http://localhost:11434/v1
AI_ANALYSIS_INTERVAL_MS=86400000
AI_CATEGORIZATION_BATCH_SIZE=50

# ── Backfill ──────────────────────────────────────────────────────────────────
BACKFILL_ENABLED=true
BACKFILL_MAX_DAYS=90
BACKFILL_MAX_MESSAGES_PER_CHANNEL=5000

# ── Alerts ────────────────────────────────────────────────────────────────────
ALERT_WEBHOOK_URL=
CRITICAL_WEBHOOK_URL=        # system errors only (token invalidation, auth failures)
ALERT_DIGEST_MODE=false
ALERT_DIGEST_INTERVAL_MS=900000
ALERT_FATIGUE_THRESHOLD=20

# ── Daily Briefs ──────────────────────────────────────────────────────────────
BRIEF_GENERATION_TIME=07:00  # UTC — requires AI_PROVIDER != none
```
</details>

OPSEC tip: Set `RANDOM_JITTER=true` to make your polling patterns and gateway fingerprint less predictable.

---

## 🚢 Deployment

| Platform | Notes |
|----------|-------|
| Local / VPS | `npm start` or PM2 (`pm2 start npm -- start`) |
| Docker | `Dockerfile` included |
| **Railway** | **One-click deploy** — [![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/deploy/sentinel-selfbot?referralCode=zpvHsG&utm_medium=integration&utm_source=template&utm_campaign=generic) |
| Fly.io | `fly.toml` included. Use `DB_MODE=cloud` with Supabase |

For cloud deployments: set `DB_MODE=cloud`, `SUPABASE_SYNC_INTERVAL_MS=30000`, and `RANDOM_JITTER=true`.

---

## 📚 Documentation

| Guide | Description |
|-------|-------------|
| [docs/selfbot.md](https://github.com/Privex-chat/sentinel/blob/main/docs/selfbot.md) | Full setup and configuration guide |
| [docs/commands.md](https://github.com/Privex-chat/sentinel/blob/main/docs/commands.md) | Self-command system reference |
| [docs/api.md](https://github.com/Privex-chat/sentinel/blob/main/docs/api.md) | REST & SSE API reference |
| [docs/presence-tracking.md](https://github.com/Privex-chat/sentinel/blob/main/docs/presence-tracking.md) | How real-time presence tracking works |

---

## 🔗 Related

- [sentinel-plugin](https://github.com/Privex-chat/sentinel-plugin) — Vencord plugin UI
- [sentinel-web](https://github.com/Privex-chat/sentinel-web) — Browser dashboard
- [sentinel-proxy](https://github.com/Privex-chat/sentinel-proxy) — Windows proxy for remote selfbot

---

## 📜 License

[PolyForm Noncommercial License 1.0.0](LICENSE)
