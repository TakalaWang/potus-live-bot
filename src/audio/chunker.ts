import type { SpeechChunk } from '../types.js';

export interface ChunkerOptions {
  /** 語音機率閾值 */
  threshold?: number;
  /** 語音段前 padding 秒數 */
  prePadSec?: number;
  /** 語音段後 padding 秒數 */
  postPadSec?: number;
  /** 靜音超過此秒數才關閉段落（更短的間隔會併入同段） */
  closeGapSec?: number;
  /** 累積語音達此秒數即 flush */
  maxSpeechSec?: number;
  /** 距上次 flush 超過此秒數且有內容即 flush */
  maxIntervalSec?: number;
  sampleRate?: number;
  frameSamples?: number;
}

interface OpenSegment {
  startFrame: number;
  frames: Buffer[];
  silenceRun: number;
  lastSpeechFrame: number;
}

interface ClosedSegment {
  startFrame: number;
  endFrame: number; // inclusive
  frames: Buffer[];
}

/**
 * 把逐 frame 的 VAD 機率與 PCM 組成語音 chunk 的狀態機。
 * 每次 pushFrame 對應一個 512-sample frame（32ms @16kHz）。
 */
export class SpeechChunker {
  private readonly threshold: number;
  private readonly prePadFrames: number;
  private readonly postPadFrames: number;
  private readonly closeGapFrames: number;
  private readonly maxSpeechSec: number;
  private readonly maxIntervalSec: number;
  private readonly frameSec: number;

  private frameIndex = 0;
  private ring: Buffer[] = [];
  private open: OpenSegment | null = null;
  private pending: ClosedSegment[] = [];
  private pendingFrameCount = 0;
  private lastFlushSec = 0;

  constructor(opts: ChunkerOptions = {}) {
    const sampleRate = opts.sampleRate ?? 16000;
    const frameSamples = opts.frameSamples ?? 512;
    this.frameSec = frameSamples / sampleRate;
    this.threshold = opts.threshold ?? 0.5;
    this.prePadFrames = Math.round((opts.prePadSec ?? 0.3) / this.frameSec);
    this.postPadFrames = Math.round((opts.postPadSec ?? 0.3) / this.frameSec);
    this.closeGapFrames = Math.round((opts.closeGapSec ?? 1.0) / this.frameSec);
    this.maxSpeechSec = opts.maxSpeechSec ?? 45;
    this.maxIntervalSec = opts.maxIntervalSec ?? 180;

    if (this.closeGapFrames < this.prePadFrames + this.postPadFrames) {
      throw new Error('closeGapSec 必須 >= prePadSec + postPadSec，否則段落音訊會重複');
    }
  }

  pushFrame(probability: number, framePcm: Buffer): SpeechChunk[] {
    const isSpeech = probability >= this.threshold;
    const out: SpeechChunk[] = [];

    if (this.open === null) {
      if (isSpeech) {
        const pre = this.prePadFrames > 0 ? this.ring.slice(-this.prePadFrames) : [];
        this.open = {
          startFrame: this.frameIndex - pre.length,
          frames: [...pre, framePcm],
          silenceRun: 0,
          lastSpeechFrame: this.frameIndex,
        };
      }
    } else {
      this.open.frames.push(framePcm);
      if (isSpeech) {
        this.open.silenceRun = 0;
        this.open.lastSpeechFrame = this.frameIndex;
      } else {
        this.open.silenceRun++;
        if (this.open.silenceRun >= this.closeGapFrames) {
          this.closeOpenSegment();
        }
      }
    }

    if (this.prePadFrames > 0) {
      this.ring.push(framePcm);
      if (this.ring.length > this.prePadFrames) this.ring.shift();
    }

    this.frameIndex++;
    const now = this.frameIndex * this.frameSec;

    const bufferedFrames = this.pendingFrameCount + (this.open?.frames.length ?? 0);
    if (bufferedFrames === 0 && this.open === null) {
      // 沒有任何內容時讓 interval 計時器滑動，避免久未開口時一開口就 flush 小段落
      this.lastFlushSec = now;
    } else if (
      bufferedFrames * this.frameSec >= this.maxSpeechSec ||
      (now - this.lastFlushSec >= this.maxIntervalSec && bufferedFrames > 0)
    ) {
      const chunk = this.emitAll();
      if (chunk) out.push(chunk);
    }

    return out;
  }

  /** 串流結束時取出殘餘內容 */
  flushAll(): SpeechChunk | null {
    return this.emitAll();
  }

  /** 關閉 open 段落：修剪尾端靜音至 postPad，無語音內容則丟棄 */
  private closeOpenSegment(): void {
    const seg = this.open;
    if (!seg) return;
    this.open = null;

    if (seg.lastSpeechFrame < seg.startFrame) return; // 純靜音（forced reopen 後沒再說話）

    const drop = Math.min(Math.max(0, seg.silenceRun - this.postPadFrames), seg.frames.length);
    const frames = drop > 0 ? seg.frames.slice(0, -drop) : seg.frames;
    if (frames.length === 0) return;

    this.pending.push({
      startFrame: seg.startFrame,
      endFrame: seg.startFrame + frames.length - 1,
      frames,
    });
    this.pendingFrameCount += frames.length;
  }

  /** flush 全部 pending（必要時強制關閉 open），合併為單一 chunk */
  private emitAll(): SpeechChunk | null {
    if (this.open) {
      const wasOpen = this.open;
      this.closeOpenSegment();
      // 強制切割時若仍在說話，立刻接續新段落（無 pre-pad，避免重複音訊）
      if (wasOpen.silenceRun < this.closeGapFrames) {
        this.open = {
          startFrame: this.frameIndex,
          frames: [],
          silenceRun: wasOpen.silenceRun,
          lastSpeechFrame: wasOpen.lastSpeechFrame,
        };
      }
    }

    this.lastFlushSec = this.frameIndex * this.frameSec;
    if (this.pending.length === 0) return null;

    const first = this.pending[0];
    const last = this.pending[this.pending.length - 1];
    const chunk: SpeechChunk = {
      pcm: Buffer.concat(this.pending.flatMap((s) => s.frames)),
      startSec: first.startFrame * this.frameSec,
      endSec: (last.endFrame + 1) * this.frameSec,
    };
    this.pending = [];
    this.pendingFrameCount = 0;
    return chunk;
  }
}
