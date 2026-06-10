# potus-live-bot

A Discord bot that monitors the White House YouTube channel:

1. **Live notification** — pushes a message to a Discord channel the moment a livestream starts
2. **Background transcription** — pulls the live audio, filters silence with silero-VAD, and transcribes speech segments to an English transcript with Gemini (persisted as it goes; no messages during the stream)
3. **Post-stream report** — after the stream ends, generates a Traditional Chinese summary, key points, and stock watch suggestions (with live quotes from Yahoo Finance) via Gemini, posted to Discord with the full transcript attached as `.txt`

> ⚠️ Stock suggestions are AI-generated, for reference only, and do not constitute investment advice.

## Architecture

```
Watcher (yt-dlp polls /live every 60s)
  └─ stream detected → Discord live notification
       └─ AudioIngest (yt-dlp -g → ffmpeg → 16kHz mono PCM; auto-reconnects when the ~6h HLS URL expires)
            └─ SileroVad (onnxruntime, speech probability per 32ms frame)
                 └─ SpeechChunker (300ms padding, merges gaps <1s, flushes at 45s of speech or every 3 min)
                      └─ Gemini ASR (inline WAV) → transcript JSONL (data/)
stream ends
  └─ Gemini analysis (structured output: zh-TW summary + stock picks)
       └─ yahoo-finance2 quotes → Discord embed report + transcript attachment
```

## Requirements

- Node.js ≥ 20
- System tools: `yt-dlp`, `ffmpeg` (macOS: `brew install yt-dlp ffmpeg deno`; yt-dlp needs deno to solve YouTube JS challenges)
- Discord bot token ([Developer Portal](https://discord.com/developers/applications); invite with the `bot` scope, channel permissions View Channel / Send Messages / Embed Links / Attach Files; push-only, no privileged intents needed)
- Gemini API key ([AI Studio](https://aistudio.google.com))

## Run locally

```bash
npm install
npm run download-model        # silero-vad v6.2 ONNX (2.3MB)
cp .env.example .env          # fill in token / channel id / API key
npm run build
set -a && source .env && set +a
node dist/index.js
```

## Replay mode (end-to-end verification)

Feed a past video or local audio file through the full pipeline as a fake livestream — no need to wait for a real broadcast:

```bash
# Local file, report printed to stdout (no Discord config needed, GEMINI_API_KEY required)
node dist/index.js --replay path/to/video.mp4 --no-discord

# Past YouTube video, actually posted to Discord
node dist/index.js --replay 'https://www.youtube.com/watch?v=XXXX'
```

## Tests

```bash
npm test            # vitest (52 tests; VAD tests need download-model first)
npm run typecheck
```

## Docker / k8s deployment

```bash
docker build -t your-registry/potus-live-bot .
docker run -e DISCORD_BOT_TOKEN=... -e DISCORD_CHANNEL_ID=... -e GEMINI_API_KEY=... \
  -v potus-data:/data your-registry/potus-live-bot
```

k8s (single replica + PVC + Secret):

```bash
kubectl apply -f k8s/namespace.yaml
cp k8s/secret.example.yaml k8s/secret.yaml   # fill in real values, never commit
kubectl apply -f k8s/secret.yaml -f k8s/pvc.yaml -f k8s/deployment.yaml
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | — | Discord bot token |
| `DISCORD_CHANNEL_ID` | ✅ | — | Target channel ID |
| `GEMINI_API_KEY` | ✅ | — | Google AI Studio API key |
| `YOUTUBE_CHANNEL_URL` | | `https://www.youtube.com/@WhiteHouse/live` | Channel /live URL to monitor |
| `POLL_INTERVAL_SEC` | | `60` | Polling interval (don't go below 30 — YouTube rate-limits) |
| `DATA_DIR` | | `./data` | Dedup state and transcript directory |
| `GEMINI_TRANSCRIBE_MODEL` | | `gemini-3.1-flash-lite` | ASR model |
| `GEMINI_ANALYZE_MODEL` | | `gemini-3.5-flash` | Analysis model |
| `VAD_MODEL_PATH` | | `models/silero_vad.onnx` | silero VAD model path |

## Behavior details

- **Dedup and restarts**: notified video IDs persist in `DATA_DIR/seen.json`; if the process restarts while a stream is still live, it reattaches and continues transcribing (no duplicate notification), with timestamps continuing from the existing transcript. Content during the gap is lost and noted in the report.
- **Orphan recovery**: if the process crashes between stream end and report delivery, the next startup detects the orphaned transcript and sends the report from disk.
- **Graceful shutdown**: SIGTERM/SIGINT flushes captured speech and drains the ASR queue before exiting; analysis is skipped (the stream isn't over) and the next run reattaches.
- **Transcription failures**: a chunk that still fails after SDK retries leaves a `[轉錄失敗 mm:ss–mm:ss]` marker in the transcript and is listed in the report; the pipeline keeps going.
- **HLS expiry**: the stream URL from yt-dlp expires after ~6 hours; the supervisor loop fetches a fresh URL and resumes automatically. Transient errors (rate limiting, network blips) are retried with backoff — only a definitive "offline" ends the session.
- **Cost**: Gemini audio is billed at 32 tokens/sec; VAD strips silence before upload. Model IDs are configurable via env vars (the gemini-2.5 family shuts down 2026-10-16).

## Known limitations

- **Datacenter IPs**: cloud IPs often hit YouTube's "Sign in to confirm you're not a bot". Test `yt-dlp https://www.youtube.com/@WhiteHouse/live --print "%(id)s"` from the deployment network first; you may need cookies or a PO-token plugin.
- **yt-dlp updates**: YouTube changes break old yt-dlp versions within weeks; run `yt-dlp -U` periodically or rebuild the image.
- One stream at a time; if the channel runs concurrent streams, only the one `/live` points to is handled.
- Report summary and stock suggestions are in Traditional Chinese by design (the transcript stays in the original English).
