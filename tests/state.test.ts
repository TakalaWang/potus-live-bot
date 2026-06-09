import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SeenStore, TranscriptStore } from '../src/state.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'potus-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SeenStore', () => {
  it('未標記的 videoId 回傳 false', () => {
    const store = new SeenStore(dir);
    expect(store.isSeen('abc')).toBe(false);
  });

  it('標記後跨實例持久化', () => {
    const a = new SeenStore(dir);
    a.markSeen('abc');
    const b = new SeenStore(dir);
    expect(b.isSeen('abc')).toBe(true);
    expect(b.isSeen('xyz')).toBe(false);
  });

  it('狀態檔損毀時視為空、不丟錯', () => {
    writeFileSync(join(dir, 'seen.json'), 'not json{');
    const store = new SeenStore(dir);
    expect(store.isSeen('abc')).toBe(false);
    store.markSeen('abc'); // 還能寫
    expect(new SeenStore(dir).isSeen('abc')).toBe(true);
  });
});

describe('TranscriptStore', () => {
  it('append 即寫入 JSONL，跨實例可讀回', () => {
    const a = new TranscriptStore(dir, 'video1');
    a.append({ start: 0, end: 5.2, text: 'hello world' });
    a.append({ start: 6, end: 10, text: 'second line' });

    const raw = readFileSync(join(dir, 'transcript-video1.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);

    const b = new TranscriptStore(dir, 'video1');
    const all = b.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual({ start: 0, end: 5.2, text: 'hello world' });
  });

  it('toText 以 [mm:ss] 前綴排版', () => {
    const store = new TranscriptStore(dir, 'video2');
    store.append({ start: 0, end: 5, text: 'first' });
    store.append({ start: 65.4, end: 70, text: 'second' });
    store.append({ start: 3661, end: 3700, text: 'hour later' });
    expect(store.toText()).toBe('[00:00] first\n[01:05] second\n[61:01] hour later');
  });

  it('損毀的 JSONL 行被略過', () => {
    writeFileSync(
      join(dir, 'transcript-video3.jsonl'),
      '{"start":0,"end":1,"text":"ok"}\nBROKEN LINE\n{"start":2,"end":3,"text":"also ok"}\n',
    );
    const store = new TranscriptStore(dir, 'video3');
    expect(store.readAll()).toHaveLength(2);
  });

  it('無逐字稿時 toText 回空字串', () => {
    const store = new TranscriptStore(dir, 'video4');
    expect(store.toText()).toBe('');
  });
});
