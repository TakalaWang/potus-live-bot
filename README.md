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
  <a href="https://discord.com/oauth2/authorize?client_id=1514254280637284423&scope=bot+applications.commands&permissions=52224&integration_type=0"><b>Invite the bot to your server</b></a>
</p>

---

## Features

- **Live notifications** — a message lands in your channel the moment the White House goes live
- **AI transcription** — silero-VAD strips silence, Gemini transcribes the speech verbatim
- **Post-stream report** — summary, key points, and stock watch suggestions with live Yahoo Finance quotes, plus the full transcript as a `.txt` attachment
- **Multi-server** — any admin invites the bot and picks a channel with `/subscribe`; no per-server setup on the operator side
- **Serverless and free** — Cloudflare Workers + GitHub Actions + free-tier APIs; no always-on machine anywhere

> Stock suggestions are AI-generated, for reference only, and do not constitute investment advice.

## Usage

1. [Invite the bot](https://discord.com/oauth2/authorize?client_id=1514254280637284423&scope=bot+applications.commands&permissions=52224&integration_type=0) (requires Manage Server).
2. Run `/subscribe channel:#your-channel` anywhere in the server.
3. Done — `/unsubscribe` stops notifications.

## Example output

When a stream starts, the subscribed channel gets a notification:

> **LIVE: President Trump Signs the Secure America Act**
> The White House is streaming. An analysis report will follow automatically when it ends.

About 10–30 minutes after the stream ends, the report follows. Reports are delivered in Traditional Chinese; the example below is translated to English for illustration (the transcript attachment stays in the original English):

> **Stream report: President Trump Signs the Secure America Act**
> President Trump announced a 25% tariff on all imported semiconductors, aiming to bring chip manufacturing back to the US. He also pledged to approve new drilling permits immediately...
>
> **Duration** 1:42:08 — **Key points** announced a 25% semiconductor import tariff; pledged immediate approval of new drilling permits; ...
>
> **Stock watch**
> Bearish | TSM (confidence: high) — Taiwan Semiconductor: 427.92 USD (+0.26%) — the tariff directly raises costs on TSMC's US-bound chips...
> Bullish | INTC (confidence: high) — Intel: 107.92 USD (−2.13%) — flagship domestic fab operator positioned to benefit...
>
> `transcript.txt` attached — *AI-generated, not investment advice*

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

(A legacy 24/7 single-process mode with real-time transcription also exists for self-hosting — see [Configuration](#configuration).)

## Deploy your own

You need five free accounts/keys: a [Discord application](https://discord.com/developers/applications), a YouTube Data API key ([Google Cloud](https://console.cloud.google.com), enable *YouTube Data API v3*), a [Cloudflare](https://dash.cloudflare.com) account, a Gemini API key ([AI Studio](https://aistudio.google.com)), and a public GitHub fork of this repo.

**1. Discord app** — from the Developer Portal grab the **bot token**, **application id**, and **public key**, then register the slash commands:

```bash
DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... pnpm register-commands
```

**2. Deploy the Worker** — also create a [fine-grained PAT](https://github.com/settings/personal-access-tokens) (this repo only, *Contents: read & write*) so the Worker can trigger the report workflow:

```bash
cd worker
pnpm install
pnpm exec wrangler login
pnpm exec wrangler kv namespace create STATE    # paste the printed id into wrangler.toml
pnpm exec wrangler secret put YOUTUBE_API_KEY
pnpm exec wrangler secret put DISCORD_BOT_TOKEN
pnpm exec wrangler secret put DISCORD_PUBLIC_KEY
pnpm exec wrangler secret put SUBSCRIPTIONS_SECRET   # any long random string
pnpm exec wrangler secret put GITHUB_TOKEN           # the fine-grained PAT
pnpm exec wrangler deploy                            # prints your workers.dev URL
```

Also set `GITHUB_REPO` (your fork) and, for a different channel, `CHANNEL_ID` in `wrangler.toml`.

**3. Connect Discord** — Developer Portal → General Information → **Interactions Endpoint URL** → `https://<your-worker>.workers.dev/interactions`.

**4. GitHub Actions secrets** — in your fork's Settings → Secrets → Actions, add `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, `WORKER_URL` (the workers.dev URL), `SUBSCRIPTIONS_SECRET` (same value as the Worker secret), and optionally `DISCORD_WEBHOOK_URL` for failure alerts.

**5. Test** — Actions → `stream-report` → *Run workflow* with any past stream's `video_id`; the report should reach your subscribed channel in ~10–30 minutes.

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
| `DISCORD_BOT_TOKEN` | yes | — | Discord bot token |
| `GEMINI_API_KEY` | yes | — | Google AI Studio API key |
| `SUBSCRIPTIONS_URL` | multi-server mode | — | Worker `/subscriptions` endpoint |
| `SUBSCRIPTIONS_SECRET` | with the above | — | shared secret for the endpoint |
| `DISCORD_CHANNEL_ID` | single-channel mode | — | legacy fixed-channel alternative |
| `YOUTUBE_CHANNEL_URL` | | `https://www.youtube.com/@WhiteHouse/live` | 24/7 mode polling target |
| `POLL_INTERVAL_SEC` | | `60` | 24/7 mode poll interval (≥ 30) |
| `DATA_DIR` | | `./data` | dedup state and transcripts |
| `GEMINI_TRANSCRIBE_MODEL` | | `gemini-3.1-flash-lite` | ASR model |
| `GEMINI_ANALYZE_MODEL` | | `gemini-3.5-flash` | analysis model |
| `VAD_MODEL_PATH` | | `models/silero_vad.onnx` | silero VAD model path |

## Limitations

- The VOD download on GitHub Actions can hit YouTube's bot check; the workflow retries on fresh runner IPs (3 attempts) and posts a failure alert with a one-click re-run link.
- One stream at a time — if the channel runs concurrent streams, only the first detected one is handled.
- Streams with archiving disabled (rare) have no VOD to transcribe.
- Report summary and stock picks are in Traditional Chinese by design; the transcript stays in the original English.

## Contributing

Issues and PRs are welcome. Before submitting, make sure `pnpm test` and `pnpm typecheck` pass; CI runs both on every PR.

## License

[MIT](LICENSE)
