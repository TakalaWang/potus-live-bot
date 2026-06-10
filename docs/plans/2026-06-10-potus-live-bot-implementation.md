# potus-live-bot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Discord bot monitoring White House YouTube livestreams: live notification, background VAD+Gemini transcription, post-stream zh-TW summary and stock suggestions with live quotes.

**Architecture:** A single long-running Node.js process. Watcher polling → AudioIngest (yt-dlp+ffmpeg → 16kHz PCM) → SileroVad → Chunker → Gemini ASR → JSONL transcript; stream end → Gemini analysis (structured output) + yahoo-finance2 quotes → Discord embed report.

**Tech Stack:** (all verified on 2026-06-10)
- TypeScript 5 / Node ≥ 20, ESM, vitest
- `discord.js@^14.26.4` (v15 is nightly-only, do not use)
- `@google/genai@^2.8.0` (do not use the deprecated @google/generative-ai)
- `yahoo-finance2@^3.15.2` (v3: default export is a class, requires `new YahooFinance()`)
- `onnxruntime-node@^1.26.0` + silero_vad.onnx v6.2 (downloaded from the snakers4/silero-vad v6.2 tag)
- System tools: yt-dlp (≥2026.03), ffmpeg, deno (required by yt-dlp for YouTube JS challenges)

---

## Verified facts (implementation must follow these)

### yt-dlp / ffmpeg
- Detection: `yt-dlp --ignore-no-formats-error --no-warnings --print "%(id)s|%(live_status)s|%(title)s" <channel>/live`
  - exit 0 + `is_live` → live; exit 0 + `is_upcoming` → scheduled, keep polling
  - exit 1 + stderr contains `The channel is not currently live` → offline; any other exit 1 → transient error
- **`-f bestaudio` always fails on live** (live exposes only muxed itags 91–96). Use `-f "bestaudio/worst[acodec!=none]"` (→ itag 91, 144p, cheapest bandwidth).
- The HLS URL from `yt-dlp -g` **expires after 6 hours**; when ffmpeg exits (expiry/drop) the supervisor loop re-detects and resumes with a fresh URL.
- ffmpeg args (tested): `-nostdin -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 30 -rw_timeout 15000000 -live_start_index -1 -i <url> -vn -f s16le -ar 16000 -ac 1 pipe:1`
- Poll interval ≥ 30–60s; faster polling gets rate-limited by YouTube. 16kHz s16le mono = 32000 bytes/sec (pipeline health check).

### silero-vad (onnxruntime-node)
- Model: `curl -L -o models/silero_vad.onnx https://raw.githubusercontent.com/snakers4/silero-vad/v6.2/src/silero_vad/data/silero_vad.onnx`
- Input convention (from the official wrapper): **64-sample context from the previous frame + 512 new samples = 576 total**. The ONNX graph has dynamic shape — feeding bare [1,512] runs without error but outputs garbage probabilities (~0). Float32 in [-1,1] (int16/32768).
- Stateful: `state` float32 [2,1,128] fed back from `stateN`; reset between streams; never run concurrently.
- `sr` is an int64 tensor (BigInt64Array). Threshold 0.5. Alpine/musl unsupported (glibc only).

### @google/genai
- Models: transcription `gemini-3.1-flash-lite` (stable, cheapest multimodal); analysis `gemini-3.5-flash` (stable, 1M context). Configurable via env (the gemini-2.5 family shuts down 2026-10-16).
- Retry is opt-in: `new GoogleGenAI({ apiKey, httpOptions: { timeout: 120_000, retryOptions: { attempts: 5 } } })`.
- Inline audio: `{ inlineData: { data: base64, mimeType: 'audio/wav' } }`, whole request ≤ 20MB (base64 inflates 4/3 — cap raw WAV at 14MB).
- Structured output: `responseMimeType: 'application/json'` + `responseSchema` (Type enum) + `propertyOrdering`. `response.text` is `string | undefined`.
- Errors: `ApiError` (numeric `.status`).

### yahoo-finance2 v3
- `const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })`; the `Quote` type imports from `yahoo-finance2/modules/quote`.
- `quote(symbols, { return: 'map' })` → `Map<string, Quote>` keyed by Yahoo's **canonical** symbol; **invalid tickers don't throw, they're silently absent** — diff against the input.
- `regularMarketChangePercent` is already in percent units. Needs `skipLibCheck: true`.

### discord.js v14
- Push-only needs `GatewayIntentBits.Guilds` only; await `Events.ClientReady` after `login()`.
- After `channels.fetch()`, narrow with `channel.isSendable()` to `SendableChannels`.
- Embed limits: description 4096, field value 1024, 25 fields, 6000 total across all embeds per message; attachments via `AttachmentBuilder(buffer, { name: 'transcript.txt' })`.
- Call `await client.destroy()` on exit or the process never terminates.

---

## Tasks

Each task: write failing test → run to confirm failure → minimal implementation → run to confirm pass → commit.
Verification commands: `npx vitest run`, `npx tsc --noEmit`.

### Task 1: Project foundation
- `package.json` (ESM, scripts: build/test/start/replay), install deps above + dev: typescript vitest @types/node, `vitest.config.ts`, `scripts/download-model.sh` fetching the VAD model into `models/` (gitignored).
- Verify: `npx tsc --noEmit` and `npx vitest run` work (zero tests). Commit.

### Task 2: `src/types.ts` + `src/config.ts` (TDD)
- types: `TranscriptSegment {start,end,text}`, `SpeechChunk {pcm:Buffer,startSec,endSec}`, `AnalysisResult {summaryZh, keyPoints[], stockPicks[{ticker, direction:'bullish'|'bearish', reason, confidence:'high'|'medium'|'low'}]}`, `StockQuote`, `LiveCheck`.
- config: read env, validate required keys (DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, GEMINI_API_KEY), defaults (YOUTUBE_CHANNEL_URL, POLL_INTERVAL_SEC=60, DATA_DIR=./data, GEMINI_TRANSCRIBE_MODEL=gemini-3.1-flash-lite, GEMINI_ANALYZE_MODEL=gemini-3.5-flash).
- Tests: missing keys throw (listing which), defaults applied, number parsing.

### Task 3: `src/audio/wav.ts` (TDD)
- `pcmToWav(pcm: Buffer, sampleRate=16000): Buffer` — 44-byte RIFF header + data.
- Tests: magic bytes (RIFF/WAVE/fmt /data), length fields, 16kHz/mono/16-bit fields.

### Task 4: `src/audio/chunker.ts` (TDD, core pure logic)
- Input: per-32ms-frame `{probability, startSample}` + matching PCM. State machine:
  - prob ≥ 0.5 → speech; 300ms padding before/after; gaps < 1s merge.
  - accumulated speech ≥ 45s, or > 180s since last flush (with content) → emit `SpeechChunk`.
  - `flushAll()` (drain at stream end).
- Tests (synthetic data): pure silence produces nothing, single segment with padding, nearby segments merge, 45s splitting, correct timestamps.

### Task 5: `src/state.ts` (TDD)
- `SeenStore`: `isSeen(videoId)` / `markSeen(videoId)`, JSON file persistence.
- `TranscriptStore`: `append(segment)` (JSONL, flushed per write), `readAll()`, `toText()` (`[mm:ss] text` format), `toTxtBuffer()`.
- Tests: roundtrip in temp dir, JSONL format, corrupted-line tolerance.

### Task 6: `src/report.ts` (TDD)
- `buildReport(analysis, quotes, meta): EmbedBuilder[]` — zh-TW report embeds: summary, key points, each stock pick (direction emoji, price, change, reason), disclaimer footer, transcription-gap notes.
- Handle embed limits: 1024 field truncation, ≤ 25 fields, ≤ 6000 total.
- Tests: normal assembly, over-length truncation, ticker with no quote shows lookup failure, disclaimer always present.

### Task 7: `src/audio/vad.ts`
- The verified `SileroVad` class (process(Buffer)→VadFrame[], reset()).
- Tests (need models/silero_vad.onnx, skipped if absent): model loads, silence → prob < 0.1, real speech → max prob > 0.9 (regression for the 64-sample context requirement), frame counts correct.

### Task 8: External integrations (thin layers; logic tested, API calls not)
- `src/asr/gemini.ts`: `transcribeAudio(wav)` (raw > 14MB throws), empty result → ''.
- `src/analysis/analyzer.ts`: `analyzeTranscript(text)` → responseSchema matching `AnalysisResult`; prompt requires zh-TW and focuses on market impact of Trump/officials' remarks.
- `src/analysis/quotes.ts`: `getQuotes(symbols)` batch + per-symbol fallback + invalid-ticker diff + symbol normalization.
- `src/discord/notifier.ts`: `start()/notifyLiveStart()/sendReport()/stop()`.
- `src/watcher.ts`: `checkLive()` (stderr parsing, injectable exec for tests).
- `src/audio/ingest.ts`: `getStreamUrl(videoId)`, `spawnPcmProcess(url)`, supervisor loop `captureLive(...)` (URL expiry reconnect; transient errors retried with backoff; end declared only on definitive offline/channel switch). All spawned processes get an 'error' listener.

### Task 9: `src/pipeline.ts` + `src/index.ts`
- pipeline: `runLiveSession(meta, deps)` — chains ingest→vad→chunker→(serialized ASR queue)→transcript; end→analyzer→quotes→report→notifier. Failed chunks marked `[轉錄失敗 mm:ss–mm:ss]`. Restart reattach continues the prior timeline (offset from existing transcript). Abort (graceful shutdown) flushes transcripts but skips analysis. `runPostAnalysis` is exported separately for orphan recovery.
- index: main loop (watcher → dedup → notifyLiveStart → runLiveSession → mark done on completion); SIGTERM/SIGINT graceful shutdown; orphan recovery at startup; `--replay <path|url>` feeds a file/past video through the same pipeline at full speed (with backpressure); `--no-discord` prints the report to stdout.
- Tests: pipeline with mocked deps verifies ordering, ASR failure markers, end triggers analysis, reattach offsets, abort semantics.

### Task 10: Dockerfile + k8s
- Multi-stage: builder (npm ci + tsc) → runtime (`node:22-bookworm-slim` + ffmpeg(apt) + standalone yt-dlp binary + deno + models/).
- `k8s/`: Namespace, Deployment (1 replica, Recreate, resources, PVC mount, terminationGracePeriodSeconds), Secret template, PVC.
- Verify: `docker build` succeeds.

### Task 11: Final verification
- `npx vitest run` all green, `npx tsc --noEmit` clean.
- `--replay` end to end against real audio (needs GEMINI_API_KEY; Discord can be dry-run via `--no-discord`).
- Multi-dimension code review workflow (correctness/concurrency/resources/robustness/api-usage) → fix confirmed findings.
- README.md (setup, local run, replay, Docker/k8s, known limitations: datacenter IPs may need cookies).
