import type { EmbedBuilder } from 'discord.js';
import type { CaptureHandle, PcmHandler } from './audio/ingest.js';
import { pcmToWav } from './audio/wav.js';
import { buildReport } from './report.js';
import { formatTime, type TranscriptStore } from './state.js';
import type { AnalysisResult, SpeechChunk, StockQuote, VadFrame } from './types.js';

const FRAME_BYTES = 1024; // 512 samples * 2 bytes
const PCM_BYTES_PER_SEC = 32000; // 16kHz * 2 bytes * mono
// ASR queue 深度上限：Gemini 持續逾時時（最壞 ~8 分鐘/chunk）不讓 PCM 無上限堆積
const MAX_ASR_PENDING = 20;

export interface SessionMeta {
  videoId: string;
  title: string;
  videoUrl: string;
}

export interface VadLike {
  process(pcm: Buffer): Promise<VadFrame[]>;
  reset(): void;
}
export interface ChunkerLike {
  pushFrame(probability: number, framePcm: Buffer): SpeechChunk[];
  flushAll(): SpeechChunk | null;
}
export interface TranscriberLike {
  transcribe(wav: Buffer): Promise<string>;
}
export interface AnalyzerLike {
  analyze(text: string): Promise<AnalysisResult>;
}
export interface ReportSink {
  sendReport(embeds: EmbedBuilder[], transcriptTxt: Buffer, filename: string): Promise<void>;
}

export interface PipelineDeps {
  vad: VadLike;
  chunker: ChunkerLike;
  transcript: TranscriptStore;
  transcriber: TranscriberLike;
  analyzer: AnalyzerLike;
  getQuotes: (symbols: string[]) => Promise<StockQuote[]>;
  notifier: ReportSink;
  startCapture: (onPcm: PcmHandler) => CaptureHandle;
}

export type SessionResult = 'completed' | 'aborted';

/**
 * 一場直播的完整生命週期：
 * PCM → VAD → chunker → Gemini ASR（序列化 queue）→ 逐字稿；
 * 串流結束 → Gemini 分析 → 行情 → Discord 報告。
 * 被 abort（優雅關閉）時：flush 已捕獲的語音並排空 ASR queue（逐字稿保全），
 * 但不做分析與報告——直播還沒結束，重啟後 reattach 續抓。
 */
export async function runLiveSession(meta: SessionMeta, deps: PipelineDeps): Promise<SessionResult> {
  // 重啟 reattach 時既有逐字稿非空：新段落時間戳接續舊時間軸，並在報告註明中斷
  const priorSegments = deps.transcript.readAll();
  const timeOffset = priorSegments.reduce((max, s) => Math.max(max, s.end), 0);
  const failedRanges: string[] = [];
  if (timeOffset > 0) {
    failedRanges.push(`${formatTime(timeOffset)} 前後（程序重啟，中斷期間未轉錄）`);
  }

  let pcmBacklog: Buffer = Buffer.alloc(0); // 尚未配對到 VAD frame 的原始 bytes（與 VAD 內部緩衝對齊）
  let bytesSeen = 0;
  let asrQueue: Promise<void> = Promise.resolve();
  let asrPending = 0;

  const enqueueAsr = (chunk: SpeechChunk): void => {
    const start = timeOffset + chunk.startSec;
    const end = timeOffset + chunk.endSec;
    const range = `${formatTime(start)}–${formatTime(end)}`;
    if (asrPending >= MAX_ASR_PENDING) {
      // ASR 嚴重落後（Gemini 長時間故障）：丟棄而非無上限堆積記憶體
      failedRanges.push(range);
      deps.transcript.append({ start, end, text: `[轉錄失敗 ${range}]` });
      console.error(`[asr] queue 滿（${MAX_ASR_PENDING}），丟棄 chunk ${range}`);
      return;
    }
    asrPending++;
    asrQueue = asrQueue.then(async () => {
      try {
        const text = await deps.transcriber.transcribe(pcmToWav(chunk.pcm));
        if (text) deps.transcript.append({ start, end, text });
      } catch (err) {
        failedRanges.push(range);
        deps.transcript.append({ start, end, text: `[轉錄失敗 ${range}]` });
        console.error(`[asr] chunk ${range} 轉錄失敗：${(err as Error).message}`);
      } finally {
        asrPending--;
      }
    });
  };

  // VAD 是 stateful 的；capture 會 await onPcm 才讀下一個 chunk（序列化 + backpressure）。
  // frames 與 backlog 從串流起點即 byte 對齊。
  const handlePcm = async (chunk: Buffer): Promise<void> => {
    bytesSeen += chunk.length;
    pcmBacklog = pcmBacklog.length > 0 ? Buffer.concat([pcmBacklog, chunk]) : chunk;
    const frames = await deps.vad.process(chunk);
    for (let i = 0; i < frames.length; i++) {
      const framePcm = pcmBacklog.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);
      for (const speechChunk of deps.chunker.pushFrame(frames[i].probability, framePcm)) {
        enqueueAsr(speechChunk);
      }
    }
    pcmBacklog = pcmBacklog.subarray(frames.length * FRAME_BYTES);
  };

  const onPcm: PcmHandler = async (chunk) => {
    try {
      await handlePcm(chunk);
    } catch (err) {
      // VAD 中途失敗會讓內部緩衝與 backlog 錯位 → 硬重置兩側，犧牲小段音訊換取對齊
      console.error('[pipeline] PCM 處理錯誤，重置 VAD 對齊：', (err as Error).message);
      deps.vad.reset();
      pcmBacklog = Buffer.alloc(0);
    }
  };

  const capture = deps.startCapture(onPcm);
  const endReason = await capture.done;

  const remaining = deps.chunker.flushAll();
  if (remaining) enqueueAsr(remaining);
  await asrQueue; // 排空：逐字稿全部落盤

  if (endReason === 'aborted') {
    console.log('[pipeline] 場次被中止，逐字稿已保全，跳過分析與報告');
    return 'aborted';
  }

  const durationSec = timeOffset + bytesSeen / PCM_BYTES_PER_SEC;
  await runPostAnalysis(meta, deps, deps.transcript, durationSec, failedRanges);
  return 'completed';
}

export interface PostAnalysisDeps {
  analyzer: AnalyzerLike;
  getQuotes: (symbols: string[]) => Promise<StockQuote[]>;
  notifier: ReportSink;
}

/**
 * 直播結束後的分析與報告。獨立匯出：程序在「直播結束 → 報告送出」之間 crash 時，
 * index.ts 的孤兒回收會直接對磁碟上的逐字稿呼叫這裡補發報告。
 */
export async function runPostAnalysis(
  meta: SessionMeta,
  deps: PostAnalysisDeps,
  transcript: TranscriptStore,
  durationSec: number,
  failedRanges: string[],
): Promise<void> {
  const text = transcript.toText();

  let analysis: AnalysisResult;
  if (!text.trim()) {
    analysis = { summaryZh: '（整場直播未偵測到語音內容）', keyPoints: [], stockPicks: [] };
  } else {
    try {
      analysis = await deps.analyzer.analyze(text);
    } catch (err) {
      console.error('[pipeline] 分析失敗：', err);
      analysis = {
        summaryZh: `（AI 分析失敗：${(err as Error).message}）完整逐字稿見附件。`,
        keyPoints: [],
        stockPicks: [],
      };
    }
  }

  // ticker 統一正規化：Gemini 輸出（'nvda'）與 Yahoo canonical（'NVDA'）才對得上
  for (const pick of analysis.stockPicks) {
    pick.ticker = pick.ticker.trim().toUpperCase();
  }

  let quotes: StockQuote[] = [];
  if (analysis.stockPicks.length > 0) {
    try {
      quotes = await deps.getQuotes([...new Set(analysis.stockPicks.map((p) => p.ticker))]);
    } catch (err) {
      console.warn('[pipeline] 行情查詢失敗：', err);
    }
  }

  const embeds = buildReport(analysis, quotes, {
    title: meta.title,
    videoUrl: meta.videoUrl,
    durationSec,
    failedRanges,
  });
  await deps.notifier.sendReport(embeds, transcript.toTxtBuffer(), `transcript-${meta.videoId}.txt`);
}
