import type { EmbedBuilder } from 'discord.js';
import type { CaptureHandle } from './audio/ingest.js';
import { pcmToWav } from './audio/wav.js';
import { buildReport } from './report.js';
import { formatTime, type TranscriptStore } from './state.js';
import type { AnalysisResult, SpeechChunk, StockQuote, VadFrame } from './types.js';

const FRAME_BYTES = 1024; // 512 samples * 2 bytes
const PCM_BYTES_PER_SEC = 32000; // 16kHz * 2 bytes * mono

export interface SessionMeta {
  videoId: string;
  title: string;
  videoUrl: string;
}

export interface VadLike {
  process(pcm: Buffer): Promise<VadFrame[]>;
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
  startCapture: (onPcm: (chunk: Buffer) => void) => CaptureHandle;
}

/**
 * 一場直播的完整生命週期：
 * PCM → VAD → chunker → Gemini ASR（序列化 queue）→ 逐字稿；
 * 串流結束 → Gemini 分析 → 行情 → Discord 報告。
 */
export async function runLiveSession(meta: SessionMeta, deps: PipelineDeps): Promise<void> {
  let pcmBacklog: Buffer = Buffer.alloc(0); // 尚未配對到 VAD frame 的原始 bytes（與 VAD 內部緩衝對齊）
  let bytesSeen = 0;
  let procQueue: Promise<void> = Promise.resolve();
  let asrQueue: Promise<void> = Promise.resolve();
  const failedRanges: string[] = [];

  const enqueueAsr = (chunk: SpeechChunk): void => {
    asrQueue = asrQueue.then(async () => {
      try {
        const text = await deps.transcriber.transcribe(pcmToWav(chunk.pcm));
        if (text) deps.transcript.append({ start: chunk.startSec, end: chunk.endSec, text });
      } catch (err) {
        const range = `${formatTime(chunk.startSec)}–${formatTime(chunk.endSec)}`;
        failedRanges.push(range);
        deps.transcript.append({ start: chunk.startSec, end: chunk.endSec, text: `[轉錄失敗 ${range}]` });
        console.error(`[asr] chunk ${range} 轉錄失敗：${(err as Error).message}`);
      }
    });
  };

  // VAD 是 stateful 的，PCM 必須序列化處理；frames 與 backlog 從串流起點即 byte 對齊
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

  const capture = deps.startCapture((chunk) => {
    procQueue = procQueue
      .then(() => handlePcm(chunk))
      .catch((err) => console.error('[pipeline] PCM 處理錯誤：', err));
  });

  await capture.done;
  await procQueue;
  const remaining = deps.chunker.flushAll();
  if (remaining) enqueueAsr(remaining);
  await asrQueue;

  const durationSec = bytesSeen / PCM_BYTES_PER_SEC;
  const text = deps.transcript.toText();

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
  await deps.notifier.sendReport(embeds, deps.transcript.toTxtBuffer(), `transcript-${meta.videoId}.txt`);
}
