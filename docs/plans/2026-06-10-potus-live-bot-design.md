# potus-live-bot 設計文件

日期：2026-06-10
狀態：已確認

## 目標

一個 Discord bot，監測白宮 YouTube 頻道：

1. **開播偵測**：頻道開直播時立即發 Discord 通知。
2. **背景轉錄**：直播期間拉取音訊，VAD 過濾靜音，有聲段落用 Gemini 做 ASR，逐字稿持久化於磁碟（直播中不發訊息）。
3. **結束後報告**：直播結束後，用 Gemini 對全文產出繁體中文摘要與股票購買建議（結合 yahoo-finance2 即時行情），連同英文逐字稿 `.txt` 附件推播到 Discord。

## 已確認的決策

| 決策 | 選擇 |
|---|---|
| 技術棧 | Node.js / TypeScript |
| Discord | discord.js v14 完整 bot（非 webhook），純推播、無 slash commands |
| 開播偵測 | yt-dlp 輪詢 `youtube.com/@WhiteHouse/live`（每 60 秒） |
| 轉錄呈現 | 背景轉錄，結束後一次發報告 |
| 講者辨識 | 不做 speaker diarization，完整逐字稿即可 |
| ASR | Gemini（`gemini-2.5-flash`），WAV inline data |
| VAD | silero-vad（onnxruntime-node，CPU） |
| 股票建議 | Gemini structured output 分析 + yahoo-finance2 即時行情 |
| 報告語言 | 繁體中文（逐字稿保留英文原文） |
| 部署 | Docker 多階段建置 + k8s 單 replica Deployment |

## 架構

單一 Node.js 長駐程序，四個模組依直播生命週期串接：

```
Watcher (yt-dlp 輪詢) ──偵測到直播──▶ AudioIngest (yt-dlp+ffmpeg → 16kHz PCM)
   │                                        │
   │ 開播通知                                ▼
   ▼                                  VAD (silero) ──有聲段──▶ Chunker ──WAV──▶ Gemini ASR
Discord 推播                                                                       │
   ▲                                                                              ▼
   │                                                                      逐字稿 JSONL（磁碟）
   └──結束後報告（摘要+股票建議+逐字稿附件）── PostAnalysis (Gemini + yahoo-finance2) ◀──直播結束
```

## 資料流細節

- **音訊**：ffmpeg 輸出 16kHz / 16-bit / mono PCM。
- **VAD**：silero-vad 以 512 樣本（32ms）為單位；語音段前後各 300ms padding；間隔 < 1 秒合併為同段。
- **Chunk flush**：累積滿 45 秒語音量，或距上次送出超過 3 分鐘，打包 WAV 丟 Gemini。
- **時間戳**：由 PCM byte offset 推算直播相對時間。
- **持久化**：轉錄結果即時 append 至 JSONL（`{start, end, text}`），程序掛掉不丟已轉錄內容。

## 直播結束偵測

ffmpeg 串流結束後重試重連 3 次（共約 2 分鐘）；若重連失敗且 `/live` 已查不到該 video ID，判定結束，觸發 PostAnalysis。

## 錯誤處理

- **Gemini 失敗**：指數退避重試 3 次；仍失敗則丟棄該 chunk，逐字稿留 `[轉錄失敗 mm:ss–mm:ss]` 標記，不中斷管線。
- **程序重啟**：已通知的 video ID 持久化；重啟後不重複通知；直播仍進行中則重新接上（中斷期間內容遺失，報告註明）。
- **Discord 發送失敗**：重試 3 次，最終失敗記 log、不致命。

## PostAnalysis 兩階段

1. 全文丟 Gemini（structured output）→ 繁中摘要、重點條列、受影響標的清單（ticker、看多/看空、理由、信心度）。
2. `yahoo-finance2` 查每個 ticker 現價與當日漲跌幅，組進報告。

報告以 Discord embed 發送，逐字稿 `.txt` 附件，結尾固定附投資風險免責聲明。

## 專案結構

```
src/
├── index.ts             # 進入點：載入設定、啟動 Watcher
├── config.ts            # 環境變數驗證
├── watcher.ts           # yt-dlp 輪詢偵測開播
├── pipeline.ts          # 單場直播生命週期協調器
├── audio/
│   ├── ingest.ts        # spawn yt-dlp+ffmpeg → PCM stream
│   ├── vad.ts           # silero-vad（onnxruntime-node）
│   └── chunker.ts       # 語音段累積、打包 WAV
├── asr/gemini.ts        # Gemini ASR
├── analysis/
│   ├── analyzer.ts      # Gemini 摘要+股票分析（structured output）
│   └── quotes.ts        # yahoo-finance2 行情
├── discord/notifier.ts  # discord.js 推播、embed 組裝
└── state.ts             # video ID 去重、逐字稿 JSONL 持久化
```

## 設定（環境變數）

`DISCORD_BOT_TOKEN`、`DISCORD_CHANNEL_ID`、`GEMINI_API_KEY`、`YOUTUBE_CHANNEL_URL`（預設白宮頻道）、`POLL_INTERVAL_SEC`（預設 60）、`DATA_DIR`（預設 `./data`）。

## 測試策略

- **單元測試**（vitest）：chunker 切段/合併/flush 規則（合成 PCM）、逐字稿持久化、報告排版、分析 schema 驗證（mock Gemini）。
- **Replay 模式**：`--replay <影片檔或YouTube網址>` 把歷史影片當假直播灌入完整管線，端到端驗證 VAD→ASR→分析→Discord，不需等真直播。

## 部署

多階段 Dockerfile（`node:22-slim` + ffmpeg + yt-dlp standalone binary）；k8s 單 replica Deployment + Secret（tokens）+ PVC 掛 `DATA_DIR`。
