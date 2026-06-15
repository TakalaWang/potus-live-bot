import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptSegment } from './types.js';

export class SeenStore {
  private readonly filePath: string;
  private readonly seen: Set<string>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'seen.json');
    this.seen = this.load();
  }

  isSeen(videoId: string): boolean {
    return this.seen.has(videoId);
  }

  markSeen(videoId: string): void {
    this.seen.add(videoId);
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify([...this.seen]));
    renameSync(tmpPath, this.filePath);
  }

  private load(): Set<string> {
    if (!existsSync(this.filePath)) return new Set();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
    } catch (err) {
      console.warn(`[state] ${this.filePath} 損毀，視為空（可能重複通知一次）：${(err as Error).message}`);
      return new Set();
    }
  }
}

export class TranscriptStore {
  private readonly filePath: string;

  constructor(dataDir: string, videoId: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, `transcript-${videoId}.jsonl`);
  }

  append(segment: TranscriptSegment): void {
    appendFileSync(this.filePath, `${JSON.stringify(segment)}\n`);
  }

  readAll(): TranscriptSegment[] {
    if (!existsSync(this.filePath)) return [];
    const segments: TranscriptSegment[] = [];
    for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as TranscriptSegment;
        if (typeof parsed.start === 'number' && typeof parsed.text === 'string') {
          segments.push(parsed);
        }
      } catch {
      }
    }
    return segments;
  }

  toText(): string {
    return this.readAll()
      .map((s) => `[${formatTime(s.start)}] ${s.text}`)
      .join('\n');
  }

  toTxtBuffer(): Buffer {
    return Buffer.from(this.toText(), 'utf8');
  }
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
