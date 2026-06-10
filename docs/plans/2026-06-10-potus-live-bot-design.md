# potus-live-bot Design Document

Date: 2026-06-10
Status: Approved

## Goal

A Discord bot that monitors the White House YouTube channel:

1. **Live detection**: push a Discord notification the moment the channel goes live.
2. **Background transcription**: pull the live audio, filter silence with VAD, transcribe speech segments with Gemini, persist the transcript to disk (no messages during the stream).
3. **Post-stream report**: after the stream ends, use Gemini to produce a Traditional Chinese summary and stock suggestions (combined with live quotes from yahoo-finance2), pushed to Discord together with the English transcript as a `.txt` attachment.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Stack | Node.js / TypeScript |
| Discord | discord.js v14 full bot (not a webhook), push-only, no slash commands |
| Live detection | yt-dlp polling `youtube.com/@WhiteHouse/live` (every 60s) |
| Transcript delivery | background transcription, single report after the stream |
| Speaker identification | no diarization — full transcript is sufficient |
| ASR | Gemini (`gemini-2.5-flash`), WAV inline data |
| VAD | silero-vad (onnxruntime-node, CPU) |
| Stock suggestions | Gemini structured output analysis + yahoo-finance2 live quotes |
| Report language | Traditional Chinese (transcript stays in original English) |
| Deployment | multi-stage Docker build + single-replica k8s Deployment |

## Architecture

A single long-running Node.js process; four modules chained along the stream lifecycle:

```
Watcher (yt-dlp polling) ──live detected──▶ AudioIngest (yt-dlp+ffmpeg → 16kHz PCM)
   │                                              │
   │ live notification                            ▼
   ▼                                        VAD (silero) ──speech──▶ Chunker ──WAV──▶ Gemini ASR
Discord push                                                                            │
   ▲                                                                                    ▼
   │                                                                          transcript JSONL (disk)
   └──post-stream report (summary+stocks+transcript)── PostAnalysis (Gemini + yahoo-finance2) ◀──stream end
```

## Data flow details

- **Audio**: ffmpeg outputs 16kHz / 16-bit / mono PCM.
- **VAD**: silero-vad scores 512-sample (32ms) frames; 300ms padding around speech segments; gaps < 1s merge into the same segment.
- **Chunk flush**: pack accumulated speech into a WAV and send to Gemini once 45 seconds of speech accumulate, or 3 minutes have passed since the last flush.
- **Timestamps**: derived from PCM byte offsets, relative to the stream.
- **Persistence**: transcription results append to a JSONL file (`{start, end, text}`) immediately; a crash loses no transcribed content.

## Stream-end detection

When the ffmpeg stream ends, retry the reconnect (transient HLS drops are common); the stream is declared over only when `/live` definitively no longer lists this video ID. Transient query errors are retried with backoff and never treated as stream end.

## Error handling

- **Gemini failure**: exponential backoff retries; if a chunk still fails it is dropped with a `[轉錄失敗 mm:ss–mm:ss]` marker in the transcript — the pipeline never stops.
- **Process restart**: notified video IDs persist; no duplicate notification after restart; if the stream is still live the bot reattaches (the gap is lost and noted in the report).
- **Discord send failure**: 3 retries; final failure is logged, not fatal.

## PostAnalysis, two stages

1. Full transcript → Gemini (structured output) → zh-TW summary, key points, affected tickers (ticker, bullish/bearish, reason, confidence).
2. `yahoo-finance2` quote lookup for each ticker (price, day change) merged into the report.

The report is sent as Discord embeds, the transcript as a `.txt` attachment, with a fixed investment-risk disclaimer at the end.

## Project structure

```
src/
├── index.ts             # entry point: load config, start watcher
├── config.ts            # env var validation
├── watcher.ts           # yt-dlp live detection polling
├── pipeline.ts          # per-stream lifecycle orchestrator
├── audio/
│   ├── ingest.ts        # spawn yt-dlp+ffmpeg → PCM stream
│   ├── vad.ts           # silero-vad (onnxruntime-node)
│   └── chunker.ts       # speech segment accumulation, WAV packing
├── asr/gemini.ts        # Gemini ASR
├── analysis/
│   ├── analyzer.ts      # Gemini summary + stock analysis (structured output)
│   └── quotes.ts        # yahoo-finance2 quotes
├── discord/notifier.ts  # discord.js push, embed assembly
└── state.ts             # video ID dedup, transcript JSONL persistence
```

## Configuration (env vars)

`DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `GEMINI_API_KEY`, `YOUTUBE_CHANNEL_URL` (defaults to the White House channel), `POLL_INTERVAL_SEC` (default 60), `DATA_DIR` (default `./data`).

## Test strategy

- **Unit tests** (vitest): chunker segmentation/merge/flush rules (synthetic PCM), transcript persistence, report formatting, analysis schema validation (mocked Gemini).
- **Replay mode**: `--replay <file or YouTube URL>` feeds a past video through the full pipeline as a fake livestream, verifying VAD→ASR→analysis→Discord end to end without waiting for a real broadcast.

## Deployment

Multi-stage Dockerfile (`node:22-bookworm-slim` + ffmpeg + standalone yt-dlp binary); k8s single-replica Deployment + Secret (tokens) + PVC mounted at `DATA_DIR`.
