# potus-live-bot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 監測白宮 YouTube 直播的 Discord bot：開播通知、背景 VAD+Gemini 轉錄、結束後繁中摘要與股票建議（含即時行情）。

**Architecture:** 單一 Node.js 長駐程序。Watcher 輪詢 → AudioIngest（yt-dlp+ffmpeg → 16kHz PCM）→ SileroVad → Chunker → Gemini ASR → JSONL 逐字稿；直播結束 → Gemini 分析（structured output）+ yahoo-finance2 行情 → Discord embed 報告。

**Tech Stack:**（全部於 2026-06-10 查證）
- TypeScript 5 / Node ≥ 20、ESM、vitest
- `discord.js@^14.26.4`（v15 僅 nightly，勿用）
- `@google/genai@^2.8.0`（勿用已棄用的 @google/generative-ai）
- `yahoo-finance2@^3.15.2`（v3：default export 是 class，要 `new YahooFinance()`）
- `onnxruntime-node@^1.26.0` + silero_vad.onnx v6.2（自 snakers4/silero-vad v6.2 tag 下載）
- 系統工具：yt-dlp（≥2026.03）、ffmpeg、deno（yt-dlp 解 YouTube JS challenge 所需）

---

## 查證過的關鍵事實（實作必須遵守）

### yt-dlp / ffmpeg
- 偵測：`yt-dlp --ignore-no-formats-error --no-warnings --print "%(id)s|%(live_status)s|%(title)s" <channel>/live`
  - exit 0 + `is_live` → 開播；exit 0 + `is_upcoming` → 已排程，繼續輪詢
  - exit 1 + stderr 含 `The channel is not currently live` → 沒開播；其他 exit 1 → 暫時性錯誤
- **`-f bestaudio` 在 live 必失敗**（live 只有混流 itag 91–96）。用 `-f "bestaudio/worst[acodec!=none]"`（→ itag 91, 144p, 最省頻寬）。
- `yt-dlp -g` 拿到的 HLS URL **6 小時過期**；ffmpeg 結束（過期/斷線）→ supervisor loop 重新偵測＋拿新 URL 續抓。
- ffmpeg 參數（已實測）：`-nostdin -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 30 -rw_timeout 15000000 -live_start_index -1 -i <url> -vn -f s16le -ar 16000 -ac 1 pipe:1`
- 輪詢間隔 ≥ 30–60s，太密會被 YouTube 限流。16kHz s16le mono = 32000 bytes/sec（管線健康檢查用）。

### silero-vad（onnxruntime-node）
- 模型：`curl -L -o models/silero_vad.onnx https://raw.githubusercontent.com/snakers4/silero-vad/v6.2/src/silero_vad/data/silero_vad.onnx`
- 輸入嚴格 512 samples/frame @16kHz（32ms），Float32 [-1,1]（int16/32768）。
- Stateful：`state` float32 [2,1,128] 餵回 `stateN`，串流間 reset，不可並行。
- `sr` 是 int64 tensor（BigInt64Array）。閾值 0.5。Alpine/musl 不支援（glibc only）。

### @google/genai
- 模型：轉錄 `gemini-3.1-flash-lite`（stable、最便宜 multimodal）；分析 `gemini-3.5-flash`（stable、1M context）。做成 env 可換（gemini-2.5 系列 2026-10-16 關閉）。
- retry 是 opt-in：`new GoogleGenAI({ apiKey, httpOptions: { timeout: 120_000, retryOptions: { attempts: 5 } } })`。
- 音訊 inline：`{ inlineData: { data: base64, mimeType: 'audio/wav' } }`，整個 request ≤ 20MB。
- structured output：`responseMimeType: 'application/json'` + `responseSchema`（Type enum）+ `propertyOrdering`。`response.text` 是 `string | undefined`。
- 錯誤：`ApiError`（`.status` 數字）。

### yahoo-finance2 v3
- `const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })`；`Quote` 型別從 `yahoo-finance2/modules/quote` import。
- `quote(symbols, { return: 'map' })` → `Map<string, Quote>`；**無效 ticker 不丟錯、默默缺席**，要 diff 輸入。
- `regularMarketChangePercent` 已是百分比單位。需 `skipLibCheck: true`。

### discord.js v14
- 純推播只需 `GatewayIntentBits.Guilds`；`login()` 後要等 `Events.ClientReady`。
- `channels.fetch()` 後用 `channel.isSendable()` 收窄到 `SendableChannels`。
- Embed 限制：description 4096、field value 1024、25 fields、單訊息全部 embed 總長 6000；附件用 `AttachmentBuilder(buffer, { name: 'transcript.txt' })`。
- 結束時 `await client.destroy()` 否則程序不會退出。

---

## Tasks

每個 task：寫失敗測試 → 跑確認失敗 → 最小實作 → 跑確認通過 → commit。
驗證指令：`npx vitest run`、`npx tsc --noEmit`。

### Task 1: 專案基礎
- `package.json`（ESM, scripts: build/test/start/replay）、安裝上列依賴 + dev: typescript vitest @types/node、`vitest.config.ts`、`scripts/download-model.sh` 下載 VAD 模型到 `models/`（gitignore models/）。
- 驗證：`npx tsc --noEmit` 與 `npx vitest run` 跑得動（零測試）。Commit。

### Task 2: `src/types.ts` + `src/config.ts`（TDD）
- types：`TranscriptSegment {start,end,text}`、`SpeechChunk {pcm:Buffer,startSec,endSec}`、`AnalysisResult {summaryZh, keyPoints[], stockPicks[{ticker, direction:'bullish'|'bearish', reason, confidence:'high'|'medium'|'low'}]}`、`StockQuote`、`LiveCheck`。
- config：從 env 讀取並驗證必填（DISCORD_BOT_TOKEN、DISCORD_CHANNEL_ID、GEMINI_API_KEY），預設值（YOUTUBE_CHANNEL_URL、POLL_INTERVAL_SEC=60、DATA_DIR=./data、GEMINI_TRANSCRIBE_MODEL=gemini-3.1-flash-lite、GEMINI_ANALYZE_MODEL=gemini-3.5-flash）。
- 測試：缺必填丟錯（列出缺哪些）、預設值正確、數字解析。

### Task 3: `src/audio/wav.ts`（TDD）
- `pcmToWav(pcm: Buffer, sampleRate=16000): Buffer` — 44-byte RIFF header + data。
- 測試：header 魔術字節（RIFF/WAVE/fmt /data）、長度欄位、16kHz/mono/16-bit 欄位值。

### Task 4: `src/audio/chunker.ts`（TDD，核心純邏輯）
- 輸入：每 32ms frame 的 `{probability, startSample}` + 對應 PCM。維護狀態機：
  - prob ≥ 0.5 → speech；語音段前後各 300ms padding；間隔 < 1s 合併。
  - 累積語音 ≥ 45s 或距上次 flush > 180s（且有內容）→ emit `SpeechChunk`。
  - `flushAll()`（直播結束時取出殘餘）。
- 測試（合成資料）：全靜音不產生 chunk、單一語音段含 padding、近距離兩段合併、超過 45s 切割、時間戳正確。

### Task 5: `src/state.ts`（TDD）
- `SeenStore`：`isSeen(videoId)` / `markSeen(videoId)`，JSON 檔持久化。
- `TranscriptStore`：`append(segment)`（JSONL 即寫即 flush）、`readAll()`、`toText()`（`[mm:ss] text` 格式）、`toTxtBuffer()`。
- 測試：暫存目錄讀寫往返、JSONL 格式、損毀行容忍。

### Task 6: `src/report.ts`（TDD）
- `buildReport(analysis, quotes, meta): { embeds, transcriptFilename }` — 繁中報告 embed fields：摘要、重點、每檔股票（方向 emoji、現價、漲跌幅、理由）、免責聲明 footer、轉錄缺漏註記。
- 處理 embed 限制：field value 1024 截斷、fields ≤ 25、總長 ≤ 6000。
- 測試：正常組裝、超長截斷、查無行情的 ticker 顯示「行情查詢失敗」、免責聲明必在。

### Task 7: `src/audio/vad.ts`
- 研究查證過的 `SileroVad` class（process(Buffer)→VadFrame[]、reset()）。
- 測試（需 models/silero_vad.onnx，CI 可 skip）：載入模型、靜音 PCM → prob < 0.1、輸出 frame 數正確。

### Task 8: 外部整合（薄層，邏輯測試、API 呼叫不測）
- `src/asr/gemini.ts`：`transcribeAudio(wav)`（>19MB 丟錯）、空結果回 ''。
- `src/analysis/analyzer.ts`：`analyzeTranscript(text)` → responseSchema 對應 `AnalysisResult`，prompt 要求繁中、聚焦川普/官員發言的市場影響。
- `src/analysis/quotes.ts`：`getQuotes(symbols)` 批次查詢 + 個別 fallback + 無效 ticker diff。
- `src/discord/notifier.ts`：`start()/notifyLiveStart()/sendReport()/stop()`。
- `src/watcher.ts`：`checkLive()`（stderr 判讀）+ `pollUntilLive()`。
- `src/audio/ingest.ts`：`getStreamUrl(videoId)`、`spawnPcmProcess(url)`、supervisor loop `captureLive(videoId, onPcm)`（URL 過期重連、結束判定：ffmpeg 退出且 checkLive 非 live）。

### Task 9: `src/pipeline.ts` + `src/index.ts`
- pipeline：`runLiveSession(videoId, title, deps)` — 串 ingest→vad→chunker→（序列化 ASR queue）→transcript；結束→analyzer→quotes→report→notifier。ASR 失敗 chunk 記 `[轉錄失敗 mm:ss–mm:ss]`。
- index：主迴圈（watcher → 去重 → notifyLiveStart → runLiveSession → 標記 seen）；`--replay <path|url>`：本地檔/歷史影片以 ffmpeg 全速灌入同一條 pipeline（不經 watcher）、結束走同樣的報告流程。
- 測試：pipeline 以 mock deps 驗證串接順序、ASR 失敗標記、結束觸發分析。

### Task 10: Dockerfile + k8s
- 多階段：builder（npm ci + tsc）→ runtime（`node:22-bookworm-slim` + ffmpeg(apt) + yt-dlp standalone binary + deno + models/）。
- `k8s/`：Namespace、Deployment（1 replica、resources、PVC mount DATA_DIR）、Secret 範本、PVC。
- 驗證：`docker build` 成功（本機有 docker 才跑）。

### Task 11: 最終驗證
- `npx vitest run` 全綠、`npx tsc --noEmit` 乾淨。
- `--replay` 端到端：下載一段歷史白宮影片音訊跑完整管線（需 GEMINI_API_KEY；Discord 可用 dry-run 印出報告）。
- ultracode 多維度 code review workflow（正確性/併發/資源洩漏/錯誤處理）→ 修正確認問題。
- README.md（設定、本機執行、replay、Docker/k8s 部署、已知限制：datacenter IP 需 cookies）。
