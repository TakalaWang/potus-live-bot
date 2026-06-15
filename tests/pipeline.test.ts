import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import { SpeechChunker } from '../src/audio/chunker.js';
import { runLiveSession, runSocialPostReport } from '../src/pipeline.js';
import { TranscriptStore } from '../src/state.js';
import type { AnalysisResult, PendingXPost, VadFrame } from '../src/types.js';

const FRAME_BYTES = 1024;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'potus-pipe-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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
      marketImpacts: [
        {
          theme: '半導體',
          direction: 'bullish',
          quote: 'chips',
          reason: '理由',
          exampleTickers: ['NVDA'],
          confidence: 'high',
        },
      ],
    };

    await runLiveSession(
      { videoId: 'vid1', title: 'Test Stream', videoUrl: 'https://youtu.be/vid1' },
      {
        vad: makeFakeVad(),

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
            await onPcm(silenceFrames(10));
            await onPcm(speechFrames(10));
            await onPcm(silenceFrames(10));

            await onPcm(speechFrames(10));
            return 'ended' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    expect(transcribed).toHaveLength(2);

    const segments = transcript.readAll();
    expect(segments.map((s) => s.text)).toEqual(['transcribed-1', 'transcribed-2']);
    expect(segments[0].start).toBeLessThan(segments[1].start);

    expect(analyzedText).toContain('transcribed-1');

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
            return { summaryZh: 's', keyPoints: [], marketImpacts: [] };
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
            await onPcm(silenceFrames(10));
            await onPcm(speechFrames(10));
            return 'ended' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    const texts = transcript.readAll().map((s) => s.text);
    expect(texts[0]).toBe('ok-1');
    expect(texts[1]).toMatch(/\[轉錄失敗 \d{2}:\d{2}–\d{2}:\d{2}\]/);

    expect(JSON.stringify(sent!.embeds.map((e) => e.toJSON()))).toContain('轉錄缺漏');
  });

  it('VOD 讀取快於 ASR 時會 backpressure，不丟棄 chunk', async () => {
    const transcript = new TranscriptStore(dir, 'vid-backpressure');
    let calls = 0;

    await runLiveSession(
      { videoId: 'vid-backpressure', title: 'T', videoUrl: 'https://youtu.be/vid-backpressure' },
      {
        vad: makeFakeVad(),
        chunker: new SpeechChunker({ ...CHUNKER_OPTS, maxSpeechSec: 0.2 }),
        transcript,
        transcriber: {
          async transcribe() {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 1));
            return `ok-${calls}`;
          },
        },
        analyzer: {
          async analyze() {
            return { summaryZh: 's', keyPoints: [], marketImpacts: [] };
          },
        },
        getQuotes: async () => [],
        notifier: {
          async sendReport() {},
        },
        startCapture: (onPcm) => {
          const done = (async () => {
            for (let i = 0; i < 30; i++) {
              await onPcm(speechFrames(8));
              await onPcm(silenceFrames(8));
            }
            return 'ended' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    expect(calls).toBeGreaterThan(20);
    expect(transcript.readAll().map((s) => s.text)).toHaveLength(calls);
    expect(transcript.toText()).not.toContain('轉錄失敗');
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
            return { summaryZh: '', keyPoints: [], marketImpacts: [] };
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

  it('capture 沒有收到任何 PCM 時失敗，不送出無語音報告', async () => {
    const transcript = new TranscriptStore(dir, 'vid-empty-capture');
    let analyzerCalled = false;
    let reportSent = false;

    await expect(
      runLiveSession(
        { videoId: 'vid-empty-capture', title: 'T', videoUrl: 'https://youtu.be/vid-empty-capture' },
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
              return { summaryZh: '', keyPoints: [], marketImpacts: [] };
            },
          },
          getQuotes: async () => [],
          notifier: {
            async sendReport() {
              reportSent = true;
            },
          },
          startCapture: () => ({ done: Promise.resolve('ended' as const), abort: () => {} }),
        },
      ),
    ).rejects.toThrow(/no PCM/i);

    expect(transcript.readAll()).toEqual([]);
    expect(analyzerCalled).toBe(false);
    expect(reportSent).toBe(false);
  });

  it('重啟 reattach：時間戳接續舊時間軸、報告註明中斷、長度含重啟前', async () => {
    const transcript = new TranscriptStore(dir, 'vid5');

    transcript.append({ start: 90, end: 100, text: 'before crash' });
    let sent: { embeds: EmbedBuilder[] } | null = null;

    const result = await runLiveSession(
      { videoId: 'vid5', title: 'T', videoUrl: 'https://youtu.be/vid5' },
      {
        vad: makeFakeVad(),
        chunker: new SpeechChunker(CHUNKER_OPTS),
        transcript,
        transcriber: { transcribe: async () => 'after restart' },
        analyzer: { analyze: async () => ({ summaryZh: 's', keyPoints: [], marketImpacts: [] }) },
        getQuotes: async () => [],
        notifier: {
          async sendReport(embeds) {
            sent = { embeds };
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

    expect(result).toBe('completed');
    const segments = transcript.readAll();
    expect(segments).toHaveLength(2);

    expect(segments[1].start).toBeGreaterThanOrEqual(100);
    expect(segments[1].text).toBe('after restart');

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
            return { summaryZh: 's', keyPoints: [], marketImpacts: [] };
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
            await onPcm(speechFrames(10));
            return 'aborted' as const;
          })();
          return { done, abort: () => {} };
        },
      },
    );

    expect(result).toBe('aborted');

    expect(transcript.readAll().map((s) => s.text)).toEqual(['partial speech']);

    expect(analyzerCalled).toBe(false);
    expect(reportSent).toBe(false);
  });

  it('分析失敗時丟錯且不送 fallback 報告，讓待辦下次重試', async () => {
    const transcript = new TranscriptStore(dir, 'vid4');
    let sent: { embeds: EmbedBuilder[]; txt: Buffer } | null = null;

    await expect(
      runLiveSession(
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
      ),
    ).rejects.toThrow('model overloaded');

    expect(sent).toBeNull();
    expect(transcript.toText()).toContain('some words');
  });
});

describe('runSocialPostReport', () => {
  it('分析 X 發文、查行情、送出原文與近期脈絡附件', async () => {
    const post: PendingXPost = {
      kind: 'x-post',
      pendingId: 'x:123',
      postId: '123',
      username: 'realDonaldTrump',
      text: 'a twenty five percent tariff on all imported semiconductors',
      createdAt: '2026-06-12T00:00:00Z',
      url: 'https://x.com/realDonaldTrump/status/123',
    };
    const analysis: AnalysisResult = {
      summaryZh: 'X 發文提到半導體關稅。',
      keyPoints: ['提到進口半導體關稅'],
      marketImpacts: [
        {
          theme: '半導體',
          direction: 'bearish',
          quote: 'a twenty five percent tariff on all imported semiconductors',
          reason: '進口半導體關稅將影響相關供應鏈成本。',
          exampleTickers: ['soxx'],
          confidence: 'high',
        },
      ],
    };
    let contextSeen = '';
    let quoteSymbols: string[] = [];
    let sent: { embeds: EmbedBuilder[]; txt: Buffer; filename: string } | null = null;

    await runSocialPostReport(
      post,
      {
        analyzer: {
          async analyzePost(input, recentContext) {
            expect(input).toBe(post);
            contextSeen = recentContext;
            return analysis;
          },
        },
        getQuotes: async (symbols) => {
          quoteSymbols = symbols;
          return symbols.map((symbol) => ({
            symbol,
            name: symbol,
            price: 100,
            changePercent: -1.5,
            currency: 'USD',
            marketState: 'REGULAR',
          }));
        },
        notifier: {
          async sendReport(embeds, txt, filename) {
            sent = { embeds, txt, filename };
          },
        },
      },
      'recent transcript context',
    );

    expect(contextSeen).toBe('recent transcript context');
    expect(quoteSymbols).toEqual(['SOXX']);
    expect(sent).not.toBeNull();
    expect(sent!.filename).toBe('x-post-123.txt');
    expect(sent!.txt.toString()).toContain('recent transcript context');
    expect(sent!.txt.toString()).toContain(post.text);
    expect(JSON.stringify(sent!.embeds.map((e) => e.toJSON()))).toContain('投資留意方向');
  });

  it('X 發文分析失敗時丟錯且不送 fallback 報告', async () => {
    const post: PendingXPost = {
      kind: 'x-post',
      pendingId: 'x:123',
      postId: '123',
      username: 'realDonaldTrump',
      text: 'Tariffs are coming.',
      createdAt: '2026-06-12T00:00:00Z',
      url: 'https://x.com/realDonaldTrump/status/123',
    };
    let reportSent = false;

    await expect(
      runSocialPostReport(
        post,
        {
          analyzer: {
            async analyzePost() {
              throw new Error('gemini unavailable');
            },
          },
          getQuotes: async () => [],
          notifier: {
            async sendReport() {
              reportSent = true;
            },
          },
        },
        'recent context',
      ),
    ).rejects.toThrow('gemini unavailable');

    expect(reportSent).toBe(false);
  });
});
