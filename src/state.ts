import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptSegment } from './types.js';

/** 已通知過的 video ID，JSON 檔持久化（重啟後不重複通知） */
export class SeenStore {
  private readonly filePath: string;
  private seen: Set<string>;

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
    writeFileSync(this.filePath, JSON.stringify([...this.seen]));
  }

  private load(): Set<string> {
    if (!existsSync(this.filePath)) return new Set();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }
}

/** 單場直播的逐字稿，JSONL 即寫即存（程序掛掉不丟已轉錄內容） */
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
        // 損毀行（寫到一半被殺）直接略過
      }
    }
    return segments;
  }

  /** `[mm:ss] text` 格式全文（給 Gemini 分析與 .txt 附件） */
  toText(): string {
    return this.readAll()
      .map((s) => `[${formatTime(s.start)}] ${s.text}`)
      .join('\n');
  }

  toTxtBuffer(): Buffer {
    return Buffer.from(this.toText(), 'utf8');
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
