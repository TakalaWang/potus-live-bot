import { InferenceSession, Tensor } from 'onnxruntime-node';
import type { VadFrame } from '../types.js';

const SAMPLE_RATE = 16_000;
export const FRAME_SAMPLES = 512;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

const CONTEXT_SAMPLES = 64;
const STATE_DIMS: readonly number[] = [2, 1, 128];

export class SileroVad {
  private readonly session: InferenceSession;
  private state: Tensor;
  private readonly sr = new Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  private pcmResidual: Buffer = Buffer.alloc(0);
  private samples = new Float32Array(0);
  private context = new Float32Array(CONTEXT_SAMPLES);
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
      intraOpNumThreads: 1,
      logSeverityLevel: 3,
    });
    return new SileroVad(session);
  }

  reset(): void {
    this.state = SileroVad.zeroState();
    this.pcmResidual = Buffer.alloc(0);
    this.samples = new Float32Array(0);
    this.context = new Float32Array(CONTEXT_SAMPLES);
    this.samplesSeen = 0;
  }

  async process(pcm: Buffer): Promise<VadFrame[]> {
    const bytes = this.pcmResidual.length > 0 ? Buffer.concat([this.pcmResidual, pcm]) : pcm;
    const wholeSamples = bytes.length >> 1;
    this.pcmResidual = bytes.subarray(wholeSamples << 1);

    const merged = new Float32Array(this.samples.length + wholeSamples);
    merged.set(this.samples, 0);
    for (let i = 0; i < wholeSamples; i++) {
      merged[this.samples.length + i] = bytes.readInt16LE(i << 1) / 32768;
    }

    const frames: VadFrame[] = [];
    let offset = 0;
    for (; offset + FRAME_SAMPLES <= merged.length; offset += FRAME_SAMPLES) {
      const windowed = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
      windowed.set(this.context, 0);
      windowed.set(merged.subarray(offset, offset + FRAME_SAMPLES), CONTEXT_SAMPLES);
      const input = new Tensor('float32', windowed, [1, CONTEXT_SAMPLES + FRAME_SAMPLES]);

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
