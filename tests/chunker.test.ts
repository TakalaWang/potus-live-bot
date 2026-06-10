import { describe, expect, it } from 'vitest';
import { SpeechChunker } from '../src/audio/chunker.js';
import type { SpeechChunk } from '../src/types.js';

const OPTS = {
  threshold: 0.5,
  prePadSec: 0.096,
  postPadSec: 0.096,
  closeGapSec: 0.192,
  maxSpeechSec: 1000,
  maxIntervalSec: 10000,
};

const FRAME_BYTES = 1024;
const FRAME_SEC = 0.032;

function frame(index: number): Buffer {
  return Buffer.alloc(FRAME_BYTES, index % 256);
}

function push(chunker: SpeechChunker, startIndex: number, n: number, prob: number): SpeechChunk[] {
  const out: SpeechChunk[] = [];
  for (let i = 0; i < n; i++) {
    out.push(...chunker.pushFrame(prob, frame(startIndex + i)));
  }
  return out;
}

describe('SpeechChunker', () => {
  it('全靜音不產生 chunk', () => {
    const c = new SpeechChunker(OPTS);
    expect(push(c, 0, 100, 0.1)).toEqual([]);
    expect(c.flushAll()).toBeNull();
  });

  it('單一語音段含前後 padding 與靜音修剪', () => {
    const c = new SpeechChunker(OPTS);

    expect(push(c, 0, 20, 0.1)).toEqual([]);
    expect(push(c, 20, 10, 0.9)).toEqual([]);
    expect(push(c, 30, 20, 0.1)).toEqual([]);

    const chunk = c.flushAll();
    expect(chunk).not.toBeNull();

    expect(chunk!.pcm.length).toBe(16 * FRAME_BYTES);
    expect(chunk!.startSec).toBeCloseTo(17 * FRAME_SEC, 5);
    expect(chunk!.endSec).toBeCloseTo(33 * FRAME_SEC, 5);

    expect(chunk!.pcm[0]).toBe(17);
    expect(chunk!.pcm[chunk!.pcm.length - 1]).toBe(32);
  });

  it('間隔小於 closeGap 的兩段語音合併', () => {
    const c = new SpeechChunker(OPTS);

    push(c, 0, 10, 0.1);
    push(c, 10, 5, 0.9);
    push(c, 15, 3, 0.1);
    push(c, 18, 5, 0.9);
    push(c, 23, 10, 0.1);

    const chunk = c.flushAll();

    expect(chunk!.pcm.length).toBe(19 * FRAME_BYTES);
    expect(chunk!.startSec).toBeCloseTo(7 * FRAME_SEC, 5);
    expect(chunk!.endSec).toBeCloseTo(26 * FRAME_SEC, 5);
  });

  it('間隔大於 closeGap 的兩段語音分為兩段、靜音被剔除', () => {
    const c = new SpeechChunker(OPTS);

    push(c, 0, 10, 0.1);
    push(c, 10, 5, 0.9);
    push(c, 15, 8, 0.1);
    push(c, 23, 5, 0.9);
    push(c, 28, 10, 0.1);

    const chunk = c.flushAll();

    expect(chunk!.pcm.length).toBe(22 * FRAME_BYTES);
    expect(chunk!.startSec).toBeCloseTo(7 * FRAME_SEC, 5);
    expect(chunk!.endSec).toBeCloseTo(31 * FRAME_SEC, 5);

    expect(chunk!.pcm[0]).toBe(7);
    expect(chunk!.pcm[10 * FRAME_BYTES + FRAME_BYTES - 1]).toBe(17);
    expect(chunk!.pcm[11 * FRAME_BYTES]).toBe(20);
  });

  it('連續語音超過 maxSpeechSec 時切割成多個 chunk', () => {
    const c = new SpeechChunker({ ...OPTS, maxSpeechSec: 0.32 });
    const chunks = push(c, 0, 30, 0.9);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].startSec).toBeCloseTo(0, 5);
    expect(chunks[0].endSec).toBeCloseTo(10 * FRAME_SEC, 5);
    expect(chunks[0].pcm.length).toBe(10 * FRAME_BYTES);
    expect(chunks[1].startSec).toBeCloseTo(10 * FRAME_SEC, 5);
    expect(chunks[2].endSec).toBeCloseTo(30 * FRAME_SEC, 5);
    expect(c.flushAll()).toBeNull();
  });

  it('距上次 flush 超過 maxIntervalSec 且有內容時 flush', () => {
    const c = new SpeechChunker({ ...OPTS, maxIntervalSec: 1.0 });

    push(c, 0, 5, 0.9);
    const chunks = push(c, 5, 40, 0.1);
    expect(chunks).toHaveLength(1);

    expect(chunks[0].pcm.length).toBe(8 * FRAME_BYTES);
    expect(chunks[0].startSec).toBeCloseTo(0, 5);
    expect(chunks[0].endSec).toBeCloseTo(8 * FRAME_SEC, 5);
    expect(c.flushAll()).toBeNull();
  });

  it('長時間靜音後才開始說話，不會因 maxIntervalSec 立刻 flush 小段落', () => {
    const c = new SpeechChunker({ ...OPTS, maxIntervalSec: 1.0 });

    push(c, 0, 60, 0.1);
    const during = push(c, 60, 5, 0.9);
    expect(during).toEqual([]);
  });
});
