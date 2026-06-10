import { describe, expect, it } from 'vitest';
import { pcmToWav } from '../src/audio/wav.js';

describe('pcmToWav', () => {
  const pcm = Buffer.alloc(32000);
  const wav = pcmToWav(pcm);

  it('產生 44 byte header + data', () => {
    expect(wav.length).toBe(44 + pcm.length);
  });

  it('RIFF/WAVE/fmt/data 魔術字節正確', () => {
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
  });

  it('長度欄位正確', () => {
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
  });

  it('格式欄位：PCM/mono/16kHz/16-bit', () => {
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(28)).toBe(32000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it('保留 PCM 內容', () => {
    const data = Buffer.from([1, 2, 3, 4]);
    expect(pcmToWav(data).subarray(44)).toEqual(data);
  });
});
