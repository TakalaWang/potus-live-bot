<p align="center">
  <img src="assets/logo.png" width="140" alt="potus-live-bot logo">
</p>

<h1 align="center">potus-live-bot</h1>

<p align="center">
  A Discord bot that watches the White House YouTube channel —<br>
  instant live notifications, AI transcription, and post-stream market analysis.
</p>

<p align="center">
  <a href="https://github.com/TakalaWang/potus-live-bot/actions/workflows/ci.yml"><img src="https://github.com/TakalaWang/potus-live-bot/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white" alt="Node >= 20">
  <img src="https://img.shields.io/badge/cost-%240%2Fmonth-success" alt="$0/month">
</p>

<p align="center">
  <a href="https://discord.com/oauth2/authorize?client_id=1514254280637284423&scope=bot+applications.commands&permissions=52224&integration_type=0"><b>➕ Invite the bot to your server</b></a>
</p>

---

## Features

- 🔴 **Live notifications** — a message lands in your channel the moment the White House goes live
- 🎙️ **AI transcription** — silero-VAD strips silence, Gemini transcribes the speech verbatim
- 📊 **Post-stream report** — Traditional Chinese summary, key points, and stock watch suggestions with live Yahoo Finance quotes, plus the full transcript as a `.txt` attachment
- 🌐 **Multi-server** — any admin invites the bot and picks a channel with `/subscribe`; no per-server setup on the operator side
- 💸 **100% serverless and free** — Cloudflare Workers + GitHub Actions + free-tier APIs; no always-on machine anywhere

> ⚠️ Stock suggestions are AI-generated, for reference only, and do not constitute investment advice.

## Usage

1. [Invite the bot](https://discord.com/oauth2/authorize?client_id=1514254280637284423&scope=bot+applications.commands&permissions=52224&integration_type=0) (requires Manage Server).
2. Run `/subscribe channel:#your-channel` anywhere in the server.
3. Done — `/unsubscribe` stops notifications.

## How it works

```
Discord /subscribe ──► Cloudflare Worker /interactions (Ed25519 verified)
                            │  per-guild subscriptions in KV
                            │
1-min cron ──► YouTube Data API (official; immune to IP bot-checks)
                            │
        live start ──► REST fan-out notification to subscribed channels
        stream end  ──► GitHub repository_dispatch
                            │
GitHub Actions: yt-dlp downloads the VOD audio → silero-VAD → Gemini ASR
→ Gemini analysis → yahoo-finance2 quotes → report fan-out
(3 attempts on fresh runner IPs; Discord alert on final failure)
```

Detection runs every minute on a Cloudflare Worker. The heavy lifting (audio download, VAD, transcription, analysis) happens in a one-shot GitHub Actions job after the stream ends, so nothing needs to stay running — and nothing costs money.

There is also a legacy 24/7 single-process mode (`node dist/index.js`) with real-time transcription for self-hosting on a residential-IP machine; YouTube aggressively bot-checks datacenter IPs, which is exactly what the serverless architecture avoids.

## Deploy your own

Everything fits in free tiers: a Discord application, a YouTube Data API key (Google Cloud), a Cloudflare account, a Gemini API key (AI Studio), and a public GitHub repo.

1. **Discord app** — create at the [Developer Portal](https://discord.com/developers/applications): grab the bot token, application id, and public key. Register the commands:
   ```bash
   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... pnpm register-commands
   ```
2. **Worker** — in `worker/`: `pnpm exec wrangler login`, create the KV namespace (`pnpm exec wrangler kv namespace create STATE`, paste the id into `wrangler.toml`), set the five secrets listed at the top of `wrangler.toml`, then `pnpm exec wrangler deploy`.
3. **Connect Discord** — set the Interactions Endpoint URL to `https://<your-worker>.workers.dev/interactions`.
4. **GitHub Actions secrets** — `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, `WORKER_URL`, `SUBSCRIPTIONS_SECRET` (same value as the Worker secret), and optionally `DISCORD_WEBHOOK_URL` for failure alerts.
5. **Test** — Actions → `stream-report` → Run workflow with any past stream's `video_id`.

Monitoring a different channel? Change `CHANNEL_ID` in `worker/wrangler.toml`.

## Development

Requires Node ≥ 20, [pnpm](https://pnpm.io), `ffmpeg`, and `yt-dlp` (macOS: `brew install yt-dlp ffmpeg deno`).

```bash
pnpm install
pnpm download-model     # silero-vad v6.2 ONNX (2.3 MB)
pnpm build
pnpm test
pnpm typecheck
```

Run the full pipeline against any video without waiting for a live stream:

```bash
node dist/index.js --replay path/to/video.mp4 --no-discord
```

### Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | — | Discord bot token |
| `GEMINI_API_KEY` | ✅ | — | Google AI Studio API key |
| `SUBSCRIPTIONS_URL` | multi-server mode | — | Worker `/subscriptions` endpoint |
| `SUBSCRIPTIONS_SECRET` | with the above | — | shared secret for the endpoint |
| `DISCORD_CHANNEL_ID` | single-channel mode | — | legacy fixed-channel alternative |
| `YOUTUBE_CHANNEL_URL` | | `https://www.youtube.com/@WhiteHouse/live` | 24/7 mode polling target |
| `POLL_INTERVAL_SEC` | | `60` | 24/7 mode poll interval (≥ 30) |
| `DATA_DIR` | | `./data` | dedup state and transcripts |
| `GEMINI_TRANSCRIBE_MODEL` | | `gemini-3.1-flash-lite` | ASR model |
| `GEMINI_ANALYZE_MODEL` | | `gemini-3.5-flash` | analysis model |
| `VAD_MODEL_PATH` | | `models/silero_vad.onnx` | silero VAD model path |

## Contributing

Issues and PRs are welcome. Before submitting, make sure `pnpm test` and `pnpm typecheck` pass; CI runs both on every PR.

## License

[MIT](LICENSE)
