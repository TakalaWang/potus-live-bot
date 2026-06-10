# potus-live-bot

A public Discord bot that monitors the White House YouTube channel. Any server admin can invite it and pick a channel:

1. **Live notification** — pushes a message the moment a livestream starts
2. **Transcription** — silero-VAD filters silence, Gemini transcribes the speech to an English transcript
3. **Post-stream report** — a Traditional Chinese summary, key points, and stock watch suggestions (with live quotes from Yahoo Finance), delivered with the full transcript attached as `.txt`

> ⚠️ Stock suggestions are AI-generated, for reference only, and do not constitute investment advice.

## Using the bot (server admins)

1. Invite the bot to your server (link in the repo description; requires Manage Server).
2. Run **`/subscribe channel:#your-channel`** anywhere in the server (requires Manage Server).
3. That's it. `/unsubscribe` stops notifications for the server.

## Architecture (free serverless deployment)

```
┌─ Detection + subscriptions (24/7, free) ────────────────────────┐
│ Cloudflare Worker                                                │
│  · 1-min cron polls YouTube Data API (official; no IP bot-check)│
│  · /interactions — Discord slash commands (/subscribe), Ed25519 │
│  · subscriptions stored in KV per guild                          │
│  · live start → REST fan-out notification to subscribed channels│
│  · stream end (actualEndTime) → GitHub repository_dispatch      │
└──────────────────────────────────────────────────────────────────┘
                              ↓ once per stream
┌─ Report (one-shot job, free on public repos) ────────────────────┐
│ GitHub Actions: yt-dlp downloads the VOD audio → replay pipeline │
│ (VAD → Gemini ASR → analysis → quotes) → report fan-out to all   │
│ subscribed channels. 3 attempts, each on a fresh runner IP.      │
└──────────────────────────────────────────────────────────────────┘
```

Setup guide: **[docs/free-deployment.md](docs/free-deployment.md)**.

There is also a legacy 24/7 single-process mode (live ingestion with real-time transcription) for self-hosting on a machine with a residential IP — see below.

## Development

Requirements: Node ≥ 20, pnpm, `yt-dlp`, `ffmpeg` (macOS: `brew install yt-dlp ffmpeg deno`).

```bash
pnpm install
pnpm download-model      # silero-vad v6.2 ONNX (2.3MB)
pnpm build
pnpm test                # 54 tests
pnpm typecheck
```

### Replay mode (end-to-end verification)

Feed a past video or local file through the full pipeline as a fake stream:

```bash
# report printed to stdout; needs GEMINI_API_KEY only
node dist/index.js --replay path/to/video.mp4 --no-discord

# send to all subscribed channels (multi-server mode)
SUBSCRIPTIONS_URL=https://your-worker.workers.dev/subscriptions \
SUBSCRIPTIONS_SECRET=... DISCORD_BOT_TOKEN=... \
node dist/index.js --replay 'https://www.youtube.com/watch?v=XXXX' --title '...' --url '...'
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | — | Discord bot token |
| `GEMINI_API_KEY` | ✅ | — | Google AI Studio API key |
| `SUBSCRIPTIONS_URL` | multi-server mode | — | Worker `/subscriptions` endpoint |
| `SUBSCRIPTIONS_SECRET` | with the above | — | shared secret for the endpoint |
| `DISCORD_CHANNEL_ID` | single-channel mode | — | legacy fixed-channel alternative |
| `YOUTUBE_CHANNEL_URL` | | `https://www.youtube.com/@WhiteHouse/live` | 24/7 mode polling target |
| `POLL_INTERVAL_SEC` | | `60` | 24/7 mode poll interval (≥30) |
| `DATA_DIR` | | `./data` | dedup state and transcripts |
| `GEMINI_TRANSCRIBE_MODEL` | | `gemini-3.1-flash-lite` | ASR model |
| `GEMINI_ANALYZE_MODEL` | | `gemini-3.5-flash` | analysis model |
| `VAD_MODEL_PATH` | | `models/silero_vad.onnx` | silero VAD model path |

## Legacy 24/7 self-host mode

Runs detection, live audio capture, and real-time background transcription in one long-running process (report ~2 min after stream end instead of ~10–30 min). Needs an always-on machine — **with a residential IP**: YouTube aggressively bot-checks datacenter IPs for yt-dlp traffic (the serverless mode avoids this by using the official Data API for detection and fresh-runner retries for the one-shot VOD download).

```bash
set -a && source .env && set +a
node dist/index.js
```

Behavior details (both modes): notified video IDs persist for dedup; transcripts append to JSONL as they are produced; failed ASR chunks leave `[轉錄失敗 mm:ss–mm:ss]` markers and are listed in the report; SIGTERM flushes transcripts and reattaches after restart; orphaned transcripts (crash between stream end and report) are recovered at startup.

## Known limitations

- The VOD download on GitHub Actions can hit YouTube's bot check; the workflow retries on fresh runners and alerts on final failure.
- One stream at a time; if the channel runs concurrent streams, only the first detected one is handled.
- Report summary and stock suggestions are in Traditional Chinese by design (the transcript stays in the original English).
