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
        stream end  ──► queued in the Worker's KV
                            │
Home agent (polls /pending): yt-dlp downloads the VOD audio → silero-VAD
→ Gemini ASR → Gemini analysis → yahoo-finance2 quotes → report fan-out
```

Detection, notifications, and subscriptions run on a free Cloudflare Worker via the official YouTube Data API, which is immune to IP bot-checks. The audio download and transcription run on a small **home agent** — any always-on machine on a residential network (a Raspberry Pi, an old laptop). This split exists because YouTube aggressively bot-checks datacenter IPs (GitHub Actions, AWS, etc.) when downloading video; a residential IP sails through. The agent is idle between streams and processes a VOD only after the stream ends, so it stays light, and the queue lives in the Worker's KV — it survives reboots.

A legacy all-in-one 24/7 mode with real-time transcription also exists (`node dist/index.js` with no flags) if you'd rather run the whole thing on one residential-IP machine.

## Deploy your own

You need four free accounts/keys — a [Discord application](https://discord.com/developers/applications), a YouTube Data API key ([Google Cloud](https://console.cloud.google.com), enable *YouTube Data API v3*), a [Cloudflare](https://dash.cloudflare.com) account, a Gemini API key ([AI Studio](https://aistudio.google.com)) — plus an always-on machine on a residential network for the agent.

**1. Discord app** — from the Developer Portal grab the **bot token**, **application id**, and **public key**, then register the slash commands:

```bash
DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... pnpm register-commands
```

**2. Deploy the Worker:**

```bash
cd worker
pnpm install
pnpm exec wrangler login
pnpm exec wrangler kv namespace create STATE    # paste the printed id into wrangler.toml
pnpm exec wrangler secret put YOUTUBE_API_KEY
pnpm exec wrangler secret put DISCORD_BOT_TOKEN
pnpm exec wrangler secret put DISCORD_PUBLIC_KEY
pnpm exec wrangler secret put SUBSCRIPTIONS_SECRET   # any long random string
pnpm exec wrangler deploy                            # prints your workers.dev URL
```

For a different channel, set `CHANNEL_ID` in `wrangler.toml`.

**3. Connect Discord** — Developer Portal → General Information → **Interactions Endpoint URL** → `https://<your-worker>.workers.dev/interactions`.

**4. Deploy the home agent** — on a Raspberry Pi, old laptop, or any always-on residential-IP machine. See **[deploy/README.md](deploy/README.md)** for the systemd setup; the agent needs `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, `SUBSCRIPTIONS_URL` (`https://<your-worker>.workers.dev/subscriptions`), and `SUBSCRIPTIONS_SECRET`.

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

- The agent needs a residential (or campus) IP. Datacenter IPs — GitHub Actions, AWS, Oracle, etc. — are bot-checked by YouTube and cannot download the VOD.
- One stream at a time — if the channel runs concurrent streams, only the first detected one is handled.
- Streams with archiving disabled (rare) have no VOD to transcribe.
- The report arrives once the agent next polls after the stream ends (within a minute or two if it's running); the queue waits in the Worker's KV if the agent is offline.
- Report summary and stock picks are in Traditional Chinese by design; the transcript stays in the original English.

## Contributing

Issues and PRs are welcome. Before submitting, make sure `pnpm test` and `pnpm typecheck` pass; CI runs both on every PR.

## License

[MIT](LICENSE)
