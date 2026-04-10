# sentinel-selfbot

> The data collection engine for the Sentinel ecosystem. Connects to Discord as a user account, logs behavioral data on tracked targets, and exposes everything through a local REST/SSE API.

Part of the [Sentinel](https://github.com/Privex-chat/sentinel) project.

---

## What It Does

Add a user ID. From that moment, the selfbot starts recording everything it can observe:

- When they come online and go offline — and on which device
- What games they play, for how long, and when
- What music they listen to on Spotify
- When they join or leave voice channels, and who they're with
- Messages sent, edited, or deleted
- Times they started typing but never sent anything (ghost typing)
- Profile changes — username, avatar, bio, connected accounts
- Server joins and leaves

All data is stored in a local SQLite database. An optional Supabase sync keeps a cloud mirror for backup or cross-device access.

---

## Requirements

- Node.js 18 or newer
- A dedicated Discord user account (not your main account)
- The account's user token

---

## Quick Start

```bash
git clone https://github.com/Privex-chat/sentinel-selfbot.git
cd sentinel-selfbot
npm install
cp .env.example .env
# Edit .env — set DISCORD_TOKEN and API_AUTH_TOKEN
npm run build && npm start
```

Full setup guide: [docs/selfbot.md](https://github.com/Privex-chat/sentinel/blob/main/docs/selfbot.md)

---

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | User account token (not a bot token) |
| `API_AUTH_TOKEN` | Yes | — | Bearer token for API authentication |
| `API_PORT` | No | `48923` | Port the API listens on |
| `DB_PATH` | No | `./data/sentinel.db` | SQLite database file path |
| `LOG_LEVEL` | No | `info` | `debug` / `info` / `warn` / `error` |
| `DB_MODE` | No | `local` | `local`, `local+cloud`, or `cloud` |
| `SUPABASE_URL` | Conditional | — | Required when `DB_MODE` is not `local` |
| `SUPABASE_SERVICE_KEY` | Conditional | — | Required when `DB_MODE` is not `local` |
| `RANDOM_JITTER` | No | `false` | Randomise polling intervals and gateway fingerprint |

---

## API

The selfbot exposes a Fastify HTTP server with endpoints for targets, events, analytics, insights, messages, profiles, and alerts. Full reference: [docs/api.md](https://github.com/Privex-chat/sentinel/blob/main/docs/api.md)

```bash
# Check status
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:48923/api/status

# Add a target
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"123456789012345678"}' \
  http://localhost:48923/api/targets
```

---

## Deployment

| Platform | Notes |
|----------|-------|
| Local / VPS | Run with `npm start` or use PM2 for persistence |
| Docker | `Dockerfile` included |
| Railway | `railway.toml` included. Use `DB_MODE=cloud` with Supabase |
| Fly.io | `fly.toml` included. Use `DB_MODE=cloud` with Supabase |

---

## Project Structure

```
src/
├── gateway/        Discord WebSocket connection
├── collectors/     Event handlers (presence, messages, voice, etc.)
├── analyzers/      Statistical analysis modules
├── api/            HTTP API server and routes
├── pollers/        Periodic REST API fetchers
├── alerts/         Alert rule engine
├── database/       SQLite schema, queries, migrations, Supabase sync
└── utils/          Config, logger, rate limiter, snowflake utils
```

---

## Important Notes

**This uses a selfbot.** Running automated code on a regular Discord user account violates Discord's Terms of Service. Use a dedicated account. Understand the risks.

**Only track people you have a legitimate reason to monitor.** This tool is built for personal and research use.

---

## Related

- [sentinel-plugin](https://github.com/Privex-chat/sentinel-plugin) — Vencord plugin UI
- [sentinel-web](https://github.com/Privex-chat/sentinel-web) — Browser dashboard
- [sentinel-proxy](https://github.com/Privex-chat/sentinel-proxy) — Windows proxy for remote selfbot

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)
