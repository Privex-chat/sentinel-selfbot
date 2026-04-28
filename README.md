<p align="center">
  <img src="https://github.com/Privex-chat/sentinel/blob/8f32961fea344aefe68157d298e1392ceeb316b5/assets/Sentinel_Logging_Targets_Messages.PNG" alt="Selfbot collecting data" width="720">
</p>
<table align="center">
  <tr>
    <td>
      <img src="https://raw.githubusercontent.com/Privex-chat/sentinel/main/assets/logo.png" alt="Sentinel Logo" width="200" style="vertical-align: middle;">
    </td>
    <td>
      <h1>🔧 sentinel-selfbot</h1>
      <h3><em>The data collection engine for the Sentinel ecosystem</em></h3>
      <p>Connects to Discord as a user account, logs behavioral data on tracked targets, and exposes everything through a local REST/SSE API — now with AI-powered analysis.</p>
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

- 🟢 Online / offline presence — and on which device
- 🎮 Games & activities — what they play, for how long
- 🎵 Spotify listening — tracks, albums, artists
- 🎙️ Voice channel movements — joins, leaves, who they’re with
- 💬 Messages — sent, edited, deleted
- 👻 Ghost typing — started typing but never sent
- 🖼️ Profile changes — username, avatar, bio, connected accounts
- 📥 Server joins & leaves

**Now with AI-powered intelligence:**

- 🏷️ **Message categorization** — every message auto-tagged (gaming, music, venting, humor, etc.)
- 🌐 **AI social graph** — relationship classification with confidence scores (close friend, romantic interest, group buddy…)
- 📰 **Daily intelligence briefs** — a morning summary of what each target did, any anomalies, and what changed
- 🔄 **Historical message backfill** — fills in the past automatically when you start tracking someone
- 🔔 **Smarter alerts** — digest mode, fatigue prevention, instant Discord webhooks

All data lives in a local SQLite database. Optional Supabase sync gives you a cloud mirror for backup or cross‑device access.

---

## 🤖 AI-Powered Features Deep Dive

### 🌐 AI Social Graph Analysis

Instead of just counting replies, Sentinel now uses an LLM to examine the *texture* of interactions — sentiment, reply speed, topic clustering, initiation balance, voice co‑presence times — and classifies relationships like:

`close friend`, `romantic interest`, `group friend`, `conflict relationship`, `server contact`, and more.

Each classification comes with a **confidence score** and a **relationship timeline** showing how the connection has evolved over weeks.

### 🏷️ Message Categorization

Messages are automatically tagged with categories like *gaming*, *music*, *venting*, *humor*, *planning*, *questions*, etc. No need to read everything — the categories tell the story at a glance. Works by batching recent messages and running them through a lightweight LLM call.

### 📰 Automated Daily Briefs

Every morning at your chosen time, Sentinel generates a plain‑text summary for each active target:
- Presence duration and devices used
- Games and music played
- Message counts (including deleted / ghost typing)
- Voice channel activity
- Profile changes
- Anomaly flags

Briefs are stored in the database and accessible via the API, ready for the dashboard.

### 🔄 Historical Message Backfill

When you add a target, Sentinel immediately starts collecting future data — but now it can also walk backwards through every shared channel to fill in the past. Configurable depth (max days, max messages per channel) with rate‑limit‑safe pagination. The API shows live progress.

### 🔔 Alert Upgrades

- **Digest mode** — batch multiple alerts into a single notification every N minutes
- **Fatigue detection** — auto‑suppress rules that fire too often (configurable threshold)
- **Discord webhooks** — fire alerts straight to your server

All driven by the new `.env` settings below.

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

## ⚙️ Configuration (Highlights)

<details>
<summary>Click to see the full <code>.env.example</code> with AI, backfill, and alert settings</summary>

```env
DISCORD_TOKEN=your_account_token_here
API_PORT=48923
API_AUTH_TOKEN=generate_a_random_string_here
DB_PATH=./data/sentinel.db
LOG_LEVEL=info
PROFILE_POLL_INTERVAL_MS=300000
STATUS_POLL_INTERVAL_MS=120000
DAILY_SUMMARY_INTERVAL_MS=3600000

# ── Randomisation ──────────────────────────────────────────────
RANDOM_JITTER=false  # true adds ±20% jitter to polling and randomises browser/OS fingerprint

# ── Database mode ──────────────────────────────────────────────
DB_MODE=local        # local | local+cloud | cloud
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SYNC_INTERVAL_MS=300000

# ── AI Provider (choose one) ────────────────────────────────────
# Recommended free tier: Google Gemini
# AI_PROVIDER=gemini
# AI_MODEL=gemini-2.5-flash-lite
# AI_API_KEY=your_google_ai_studio_key
#
# Local & private (requires Ollama + ngrok):
# AI_PROVIDER=ollama
# AI_MODEL=llama3.2
# AI_BASE_URL=https://your-static-domain.ngrok-free.app/v1
#
# AI_PROVIDER=openai
# AI_MODEL=gpt-4o-mini
# AI_API_KEY=sk-...
#
# AI_PROVIDER=anthropic
# AI_MODEL=claude-haiku-4-5-20251001
# AI_API_KEY=sk-ant-...

AI_PROVIDER=none
AI_MODEL=gemini-2.0-flash
AI_API_KEY=
AI_BASE_URL=http://localhost:11434/v1
AI_ANALYSIS_INTERVAL_MS=86400000     # daily re‑analysis
AI_CATEGORIZATION_BATCH_SIZE=50

# ── Backfill ───────────────────────────────────────────────────
BACKFILL_ENABLED=true
BACKFILL_MAX_DAYS=90
BACKFILL_MAX_MESSAGES_PER_CHANNEL=5000

# ── Alert Improvements ─────────────────────────────────────────
ALERT_DIGEST_MODE=false
ALERT_DIGEST_INTERVAL_MS=900000   # 15 min
ALERT_FATIGUE_THRESHOLD=20        # suppress after 20 fires/day
ALERT_WEBHOOK_URL=

# ── Daily Briefs ───────────────────────────────────────────────
BRIEF_GENERATION_TIME=07:00
```
</details>

OPSEC tip: Set `RANDOM_JITTER=true` to make your polling patterns and gateway fingerprint less predictable.

---

## 🚢 Deployment

| Platform | Notes |
|----------|-------|
| Local / VPS | `npm start` or PM2 |
| Docker | `Dockerfile` included |
| **Railway** | **One‑click deploy** – [![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/deploy/sentinel-selfbot?referralCode=zpvHsG&utm_medium=integration&utm_source=template&utm_campaign=generic) |
| Fly.io | `fly.toml` included. Use `DB_MODE=cloud` with Supabase |

---

## 🔗 Related

- [sentinel-plugin](https://github.com/Privex-chat/sentinel-plugin) — Vencord plugin UI
- [sentinel-web](https://github.com/Privex-chat/sentinel-web) — Browser dashboard
- [sentinel-proxy](https://github.com/Privex-chat/sentinel-proxy) — Windows proxy for remote selfbot

---

## 📜 License

[PolyForm Noncommercial License 1.0.0](LICENSE)
