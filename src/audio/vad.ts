import { InferenceSession, Tensor } from 'onnxruntime-node';
import type { VadFrame } from '../types.js';

const SAMPLE_RATE = 16_000;
export const FRAME_SAMPLES = 512; // silero v5/v6 @16kHz 固定 512 samples（32ms）
export const FRAME_BYTES = FRAME_SAMPLES * 2;
// 官方 wrapper 的輸入是 64 樣本 context（前一 frame 的尾巴）+ 512 新樣本 = 576。
// ONNX 是動態 shape：只餵 512 不會報錯，但機率輸出是垃圾（全部趨近 0）。
const CONTEXT_SAMPLES = 64;
const STATE_DIMS: readonly number[] = [2, 1, 128];

/**
 * 串流式 Silero VAD（v5/v6 ONNX），輸入 16kHz 16-bit LE mono PCM。
 * 餵任意大小的 Buffer，每湊滿一個 512-sample frame 輸出一個語音機率。
 * 模型是 stateful 的：frame 必須依序處理，串流之間要 reset()。
 */
export class SileroVad {
  private readonly session: InferenceSession;
  private state: Tensor;
  private readonly sr = new Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  private pcmResidual: Buffer = Buffer.alloc(0); // <2 bytes：chunk 可能把一個 16-bit 樣本切成兩半
  private samples = new Float32Array(0); // <512 個未滿一個 frame 的樣本
  private context = new Float32Array(CONTEXT_SAMPLES); // 前一 frame 的最後 64 樣本
  private samplesSeen = 0;

  private constructor(session: InferenceSession) {
    this.session = session;
    this.state = SileroVad.zeroState();
  }

  private static zeroState(): Tensor {
    return new Tensor('float32', new Float32Array(2 * 1 * 128), [...STATE_DIMS]);
  }

  static async create(modelPath: string): Promise<SileroVad> {
    const session = await InferenceSession.create(modelPath, {
      interOpNumThreads: 1,
      intraOpNumThreads: 1, // 模型極小，單執行緒最快
      logSeverityLevel: 3,
    });
    return new SileroVad(session);
  }

  /** 串流之間呼叫（模型有內部狀態） */
  reset(): void {
    this.state = SileroVad.zeroState();
    this.pcmResidual = Buffer.alloc(0);
    this.samples = new Float32Array(0);
    this.context = new Float32Array(CONTEXT_SAMPLES);
    this.samplesSeen = 0;
  }

  /** 餵入一段 16-bit LE mono PCM，回傳每個完整 frame 的語音機率 */
  async process(pcm: Buffer): Promise<VadFrame[]> {
    const bytes = this.pcmResidual.length > 0 ? Buffer.concat([this.pcmResidual, pcm]) : pcm;
    const wholeSamples = bytes.length >> 1;
    this.pcmResidual = bytes.subarray(wholeSamples << 1);

    // Int16 → Float32 [-1, 1]（餵原始 Int16 會得到無意義的機率）
    const merged = new Float32Array(this.samples.length + wholeSamples);
    merged.set(this.samples, 0);
    for (let i = 0; i < wholeSamples; i++) {
      merged[this.samples.length + i] = bytes.readInt16LE(i << 1) / 32768;
    }

    const frames: VadFrame[] = [];
    let offset = 0;
    for (; offset + FRAME_SAMPLES <= merged.length; offset += FRAME_SAMPLES) {
      // 官方輸入慣例：[context(64) + frame(512)] = 576 樣本
      const windowed = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
      windowed.set(this.context, 0);
      windowed.set(merged.subarray(offset, offset + FRAME_SAMPLES), CONTEXT_SAMPLES);
      const input = new Tensor('float32', windowed, [1, CONTEXT_SAMPLES + FRAME_SAMPLES]);
      // 依序執行：每次 run 消耗上一次的 stateN
      const out = await this.session.run({ input, state: this.state, sr: this.sr });
      this.state = out.stateN as Tensor;
      this.context = windowed.slice(windowed.length - CONTEXT_SAMPLES);
      frames.push({
        probability: (out.output.data as Float32Array)[0],
        startSample: this.samplesSeen + offset,
      });
    }
    this.samplesSeen += offset;
    this.samples = merged.slice(offset);
    return frames;
  }
}
