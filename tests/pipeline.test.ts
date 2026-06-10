import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import { SpeechChunker } from '../src/audio/chunker.js';
import { runLiveSession } from '../src/pipeline.js';
import { TranscriptStore } from '../src/state.js';
import type { AnalysisResult, VadFrame } from '../src/types.js';

const FRAME_BYTES = 1024;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'potus-pipe-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** fake VAD：frame 第一個 byte 為 1 → 語音 (0.9)，否則靜音 (0.1)。維持與真 VAD 相同的 frame 切割行為 */
function makeFakeVad() {
  let residual = Buffer.alloc(0);
  let samplesSeen = 0;
  return {
    async process(pcm: Buffer): Promise<VadFrame[]> {
      residual = Buffer.concat([residual, pcm]);
      const frames: VadFrame[] = [];
      while (residual.length >= FRAME_BYTES) {
        frames.push({
          probability: residual[0] === 1 ? 0.9 : 0.1,
          startSample: samplesSeen,
        });
        samplesSeen += 512;
        residual = residual.subarray(FRAME_BYTES);
      }
      return frames;
    },
    reset() {},
  };
}

function speechFrames(n: number): Buffer {
  return Buffer.alloc(n * FRAME_BYTES, 1);
}
function silenceFrames(n: number): Buffer {
  return Buffer.alloc(n * FRAME_BYTES, 0);
}

const CHUNKER_OPTS = {
  threshold: 0.5,
  prePadSec: 0.096,
  postPadSec: 0.096,
  closeGapSec: 0.192,
  maxSpeechSec: 1000,
  maxIntervalSec: 10000,
};

describe('runLiveSession', () => {
  it('完整流程：PCM→VAD→chunker→ASR→分析→報告', async () => {
    const transcript = new TranscriptStore(dir, 'vid1');
    const transcribed: number[] = [];
    let analyzedText = '';
    let sent: { embeds: EmbedBuilder[]; filename: string; txt: Buffer } | null = null;

    const analysis: AnalysisResult = {
      summaryZh: '測試摘要',
      keyPoints: ['重點'],
      stockPicks: [{ ticker: 'NVDA', direction: 'bullish', reason: '理由', confidence: 'high' }],
    };

    await runLiveSession(
      { videoId: 'vid1', title: 'Test Stream', videoUrl: 'https://youtu.be/vid1' },
      {
        vad: makeFakeVad(),
        // maxSpeechSec=0.4（13 frames）→ 段1 與段2 各自觸發切割，產生兩個 chunk
        chunker: new SpeechChunker({ ...CHUNKER_OPTS, maxSpeechSec: 0.4 }),
        transcript,
        transcriber: {
          async transcribe(wav: Buffer) {
            transcribed.push(wav.length);
            return `transcribed-${transcribed.length}`;
          },
        },
        analyzer: {
          async analyze(text: string) {
            analyzedText = text;
            return analysis;
          },
        },
        getQuotes: async (symbols) =>
          symbols.map((s) => ({
            symbol: s, name: s, price: 100, changePercent: 1.5, currency: 'USD', marketState: 'REGULAR',
          })),
        notifier: {
          async sendReport(embeds, txt, filename) {
            sent = { embeds, txt, filename };
          },
        },
        startCapture: (onPcm) => {
          const done = (async () => {
            // 段1：10 靜音、10 語音、10 靜音（closeGap=6 會關閉段落）
            await onPcm(silenceFrames(10));
            await onPcm(speechFrames(10));
            await onPcm(silenceFrames(10));
            // 段2：10 語音，直播結束（靠 flushAll 收尾）
            await onPcm(speechFrames(10));
            return 'ended' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    // 兩個 chunk 都被轉錄（段1 由 closeGap 關閉，段2 由 flushAll 收尾）
    expect(transcribed).toHaveLength(2);

    // 逐字稿依序寫入
    const segments = transcript.readAll();
    expect(segments.map((s) => s.text)).toEqual(['transcribed-1', 'transcribed-2']);
    expect(segments[0].start).toBeLessThan(segments[1].start);

    // 分析收到含逐字稿的全文
    expect(analyzedText).toContain('transcribed-1');

    // 報告送出：含股票 embed 與正確檔名
    expect(sent).not.toBeNull();
    expect(sent!.filename).toBe('transcript-vid1.txt');
    expect(sent!.txt.toString()).toContain('transcribed-1');
    expect(JSON.stringify(sent!.embeds.map((e) => e.toJSON()))).toContain('NVDA');
  });

  it('ASR 失敗的 chunk 留下標記並回報缺漏範圍', async () => {
    const transcript = new TranscriptStore(dir, 'vid2');
    let calls = 0;
    let sent: { embeds: EmbedBuilder[] } | null = null;

    await runLiveSession(
      { videoId: 'vid2', title: 'T', videoUrl: 'https://youtu.be/vid2' },
      {
        vad: makeFakeVad(),
        chunker: new SpeechChunker({ ...CHUNKER_OPTS, maxSpeechSec: 0.4 }),
        transcript,
        transcriber: {
          async transcribe() {
            calls++;
            if (calls === 2) throw new Error('quota exceeded');
            return `ok-${calls}`;
          },
        },
        analyzer: {
          async analyze() {
            return { summaryZh: 's', keyPoints: [], stockPicks: [] };
          },
        },
        getQuotes: async () => [],
        notifier: {
          async sendReport(embeds) {
            sent = { embeds };
          },
        },
        startCapture: (onPcm) => {
          const done = (async () => {
            await onPcm(speechFrames(10));
            await onPcm(silenceFrames(10)); // 關閉段1
            await onPcm(speechFrames(10)); // 段2 由 flushAll 收尾 → 第二次 transcribe 失敗
            return 'ended' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    const texts = transcript.readAll().map((s) => s.text);
    expect(texts[0]).toBe('ok-1');
    expect(texts[1]).toMatch(/\[轉錄失敗 \d{2}:\d{2}–\d{2}:\d{2}\]/);
    // 報告 embed 內有轉錄缺漏欄位
    expect(JSON.stringify(sent!.embeds.map((e) => e.toJSON()))).toContain('轉錄缺漏');
  });

  it('完全沒有語音時不呼叫分析、送出無語音報告', async () => {
    const transcript = new TranscriptStore(dir, 'vid3');
    let analyzerCalled = false;
    let sent: { embeds: EmbedBuilder[] } | null = null;

    await runLiveSession(
      { videoId: 'vid3', title: 'T', videoUrl: 'https://youtu.be/vid3' },
      {
        vad: makeFakeVad(),
        chunker: new SpeechChunker(CHUNKER_OPTS),
        transcript,
        transcriber: {
          async transcribe() {
            throw new Error('不應被呼叫');
          },
        },
        analyzer: {
          async analyze() {
            analyzerCalled = true;
            return { summaryZh: '', keyPoints: [], stockPicks: [] };
          },
        },
        getQuotes: async () => [],
        notifier: {
          async sendReport(embeds) {
            sent = { embeds };
          },
        },
        startCapture: (onPcm) => {
          const done = (async () => {
            await onPcm(silenceFrames(50));
            return 'ended' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    expect(analyzerCalled).toBe(false);
    expect(JSON.stringify(sent!.embeds.map((e) => e.toJSON()))).toContain('未偵測到語音');
  });

  it('重啟 reattach：時間戳接續舊時間軸、報告註明中斷、長度含重啟前', async () => {
    const transcript = new TranscriptStore(dir, 'vid5');
    // 模擬 crash 前已有逐字稿到 100 秒
    transcript.append({ start: 90, end: 100, text: 'before crash' });
    let sent: { embeds: EmbedBuilder[] } | null = null;

    const result = await runLiveSession(
      { videoId: 'vid5', title: 'T', videoUrl: 'https://youtu.be/vid5' },
      {
        vad: makeFakeVad(),
        chunker: new SpeechChunker(CHUNKER_OPTS),
        transcript,
        transcriber: { transcribe: async () => 'after restart' },
        analyzer: { analyze: async () => ({ summaryZh: 's', keyPoints: [], stockPicks: [] }) },
        getQuotes: async () => [],
        notifier: {
          async sendReport(embeds) {
            sent = { embeds };
          },
        },
        startCapture: (onPcm) => {
          const done = (async () => {
            await onPcm(speechFrames(10)); // 重啟後第一段語音
            return 'ended' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    expect(result).toBe('completed');
    const segments = transcript.readAll();
    expect(segments).toHaveLength(2);
    // 新段落時間戳 >= 100（接續），而非從 0 重算
    expect(segments[1].start).toBeGreaterThanOrEqual(100);
    expect(segments[1].text).toBe('after restart');
    // 報告註明中斷
    expect(JSON.stringify(sent!.embeds.map((e) => e.toJSON()))).toContain('程序重啟');
  });

  it('abort（優雅關閉）：flush 逐字稿但跳過分析與報告，回傳 aborted', async () => {
    const transcript = new TranscriptStore(dir, 'vid6');
    let analyzerCalled = false;
    let reportSent = false;

    const result = await runLiveSession(
      { videoId: 'vid6', title: 'T', videoUrl: 'https://youtu.be/vid6' },
      {
        vad: makeFakeVad(),
        chunker: new SpeechChunker(CHUNKER_OPTS),
        transcript,
        transcriber: { transcribe: async () => 'partial speech' },
        analyzer: {
          analyze: async () => {
            analyzerCalled = true;
            return { summaryZh: 's', keyPoints: [], stockPicks: [] };
          },
        },
        getQuotes: async () => [],
        notifier: {
          async sendReport() {
            reportSent = true;
          },
        },
        startCapture: (onPcm) => {
          const done = (async () => {
            await onPcm(speechFrames(10)); // 說到一半被 abort
            return 'aborted' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    expect(result).toBe('aborted');
    // flushAll 收尾的語音仍被轉錄、落盤
    expect(transcript.readAll().map((s) => s.text)).toEqual(['partial speech']);
    // 但不分析、不發報告（直播沒結束）
    expect(analyzerCalled).toBe(false);
    expect(reportSent).toBe(false);
  });

  it('分析失敗時仍送出報告（含逐字稿附件）', async () => {
    const transcript = new TranscriptStore(dir, 'vid4');
    let sent: { embeds: EmbedBuilder[]; txt: Buffer } | null = null;

    await runLiveSession(
      { videoId: 'vid4', title: 'T', videoUrl: 'https://youtu.be/vid4' },
      {
        vad: makeFakeVad(),
        chunker: new SpeechChunker(CHUNKER_OPTS),
        transcript,
        transcriber: { transcribe: async () => 'some words' },
        analyzer: {
          async analyze(): Promise<AnalysisResult> {
            throw new Error('model overloaded');
          },
        },
        getQuotes: async () => [],
        notifier: {
          async sendReport(embeds, txt) {
            sent = { embeds, txt };
          },
        },
        startCapture: (onPcm) => {
          const done = (async () => {
            await onPcm(speechFrames(10));
            return 'ended' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    expect(sent).not.toBeNull();
    expect(JSON.stringify(sent!.embeds.map((e) => e.toJSON()))).toContain('分析失敗');
    expect(sent!.txt.toString()).toContain('some words');
  });
});
