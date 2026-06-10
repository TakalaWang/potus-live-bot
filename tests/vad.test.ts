import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SileroVad } from '../src/audio/vad.js';

const MODEL_PATH = 'models/silero_vad.onnx';

describe.skipIf(!existsSync(MODEL_PATH))('SileroVad（真模型）', () => {
  it('靜音 PCM 的語音機率極低', async () => {
    const vad = await SileroVad.create(MODEL_PATH);
    const silence = Buffer.alloc(16000 * 2);
    const frames = await vad.process(silence);
    expect(frames).toHaveLength(31);
    for (const f of frames) {
      expect(f.probability).toBeLessThan(0.1);
    }
  });

  it('跨 chunk 的不完整 frame 會被緩衝，startSample 連續', async () => {
    const vad = await SileroVad.create(MODEL_PATH);

    const a = await vad.process(Buffer.alloc(1023));
    const b = await vad.process(Buffer.alloc(1025));
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(2);
    expect(b[0].startSample).toBe(0);
    expect(b[1].startSample).toBe(512);
  });

  it('真實語音的機率要高（迴歸：模型輸入需含 64 樣本 context，餵 512 會默默輸出垃圾）', async () => {
    const vad = await SileroVad.create(MODEL_PATH);

    const wav = readFileSync('tests/fixtures/speech.wav');
    const pcm = wav.subarray(44);
    const frames = await vad.process(pcm);
    const maxProb = Math.max(...frames.map((f) => f.probability));
    expect(maxProb).toBeGreaterThan(0.9);

    const speechFrames = frames.filter((f) => f.probability >= 0.5).length;
    expect(speechFrames / frames.length).toBeGreaterThan(0.3);
  });

  it('白噪音的機率不會是 NaN 且在 [0,1]', async () => {
    const vad = await SileroVad.create(MODEL_PATH);
    const noise = Buffer.alloc(512 * 2 * 10);
    for (let i = 0; i < noise.length; i += 2) {
      noise.writeInt16LE(Math.floor((Math.random() - 0.5) * 20000), i);
    }
    const frames = await vad.process(noise);
    expect(frames).toHaveLength(10);
    for (const f of frames) {
      expect(f.probability).toBeGreaterThanOrEqual(0);
      expect(f.probability).toBeLessThanOrEqual(1);
    }
  });
});
