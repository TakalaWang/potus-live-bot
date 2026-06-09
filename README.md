# potus-live-bot

監測白宮 YouTube 頻道的 Discord bot：

1. **開播通知**——頻道開直播時立即推播到指定 Discord 頻道
2. **背景轉錄**——直播期間拉取音訊，silero-VAD 過濾靜音，有聲段落用 Gemini 轉錄成英文逐字稿（即寫即存，不發訊息）
3. **結束後報告**——直播結束後用 Gemini 產出繁體中文摘要、重點與股票觀察建議（含 Yahoo Finance 即時行情），連同逐字稿 `.txt` 附件發到 Discord

> ⚠️ 股票建議由 AI 自動生成，僅供參考，不構成投資建議。

## 架構

```
Watcher（yt-dlp 每 60s 輪詢 /live）
  └─ 偵測到直播 → Discord 開播通知
       └─ AudioIngest（yt-dlp -g → ffmpeg → 16kHz mono PCM，HLS URL 6h 過期自動重連）
            └─ SileroVad（onnxruntime，逐 32ms frame 算語音機率）
                 └─ SpeechChunker（前後 300ms padding、<1s 間隔合併、滿 45s 語音或 3 分鐘 flush）
                      └─ Gemini ASR（WAV inline）→ 逐字稿 JSONL（data/）
直播結束
  └─ Gemini 分析（structured output：繁中摘要＋股票標的）
       └─ yahoo-finance2 行情 → Discord embed 報告 + 逐字稿附件
```

## 需求

- Node.js ≥ 20
- 系統工具：`yt-dlp`、`ffmpeg`（macOS：`brew install yt-dlp ffmpeg deno`；yt-dlp 需要 deno 解 YouTube JS challenge）
- Discord bot token（[Developer Portal](https://discord.com/developers/applications)，邀請時勾 `bot` scope，頻道權限需 View Channel / Send Messages / Embed Links / Attach Files；純推播，不需任何 privileged intent）
- Gemini API key（[AI Studio](https://aistudio.google.com)）

## 本機執行

```bash
npm install
npm run download-model        # 下載 silero-vad v6.2 ONNX（2.3MB）
cp .env.example .env          # 填入 token / channel id / API key
npm run build
set -a && source .env && set +a
node dist/index.js
```

## Replay 模式（端到端驗證）

不用等白宮真的開播，把歷史影片或本地音檔當「假直播」灌入完整管線：

```bash
# 本地檔案，報告印到 stdout（不需要 Discord 設定，但需要 GEMINI_API_KEY）
node dist/index.js --replay path/to/video.mp4 --no-discord

# YouTube 歷史影片，真的發到 Discord
node dist/index.js --replay 'https://www.youtube.com/watch?v=XXXX'
```

## 測試

```bash
npm test            # vitest（43+ 測試；VAD 測試需先 download-model）
npm run typecheck
```

## Docker / k8s 部署

```bash
docker build -t your-registry/potus-live-bot .
docker run -e DISCORD_BOT_TOKEN=... -e DISCORD_CHANNEL_ID=... -e GEMINI_API_KEY=... \
  -v potus-data:/data your-registry/potus-live-bot
```

k8s（單 replica + PVC + Secret）：

```bash
kubectl apply -f k8s/namespace.yaml
cp k8s/secret.example.yaml k8s/secret.yaml   # 填入實際值，勿 commit
kubectl apply -f k8s/secret.yaml -f k8s/pvc.yaml -f k8s/deployment.yaml
```

## 環境變數

| 變數 | 必填 | 預設 | 說明 |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | — | Discord bot token |
| `DISCORD_CHANNEL_ID` | ✅ | — | 推播目標頻道 ID |
| `GEMINI_API_KEY` | ✅ | — | Google AI Studio API key |
| `YOUTUBE_CHANNEL_URL` | | `https://www.youtube.com/@WhiteHouse/live` | 監測的頻道 /live 網址 |
| `POLL_INTERVAL_SEC` | | `60` | 輪詢間隔（勿低於 30，YouTube 會限流） |
| `DATA_DIR` | | `./data` | 去重狀態與逐字稿目錄 |
| `GEMINI_TRANSCRIBE_MODEL` | | `gemini-3.1-flash-lite` | ASR 模型 |
| `GEMINI_ANALYZE_MODEL` | | `gemini-3.5-flash` | 分析模型 |
| `VAD_MODEL_PATH` | | `models/silero_vad.onnx` | silero VAD 模型路徑 |

## 行為細節

- **去重與重啟**：通知過的 video ID 持久化於 `DATA_DIR/seen.json`；程序重啟後若同場直播仍在進行，會重新接上續轉錄（不重複通知），中斷期間的內容遺失。
- **轉錄失敗**：單一 chunk 經 SDK 重試後仍失敗 → 逐字稿留 `[轉錄失敗 mm:ss–mm:ss]` 標記並列入報告的「轉錄缺漏」，不中斷管線。
- **HLS 過期**：yt-dlp 給的串流 URL 約 6 小時過期，supervisor loop 會自動拿新 URL 續抓。
- **成本**：Gemini 音訊計費 32 tokens/秒，VAD 已先剔除靜音；模型 ID 可由環境變數更換（gemini-2.5 系列 2026-10-16 關閉）。

## 已知限制

- **Datacenter IP**：雲端機房 IP 常被 YouTube 要求登入驗證（"Sign in to confirm you're not a bot"）。部署前先在目標網路實測 `yt-dlp https://www.youtube.com/@WhiteHouse/live --print "%(id)s"`；必要時需提供 cookies 或 PO-token plugin。
- **yt-dlp 更新**：YouTube 改版會讓舊版 yt-dlp 失效，建議定期 `yt-dlp -U` 或重建 image。
- 一次只處理一場直播；同頻道同時多場直播時只處理 `/live` 指到的那場。
