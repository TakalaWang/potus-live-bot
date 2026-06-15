import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  captureFile,
  captureLive,
  ytDlpAudioArgs,
  type CaptureDeps,
  type CaptureFileDeps,
} from '../src/audio/ingest.js';
import type { LiveCheck } from '../src/types.js';

type FakeFfmpegProcess = ReturnType<CaptureFileDeps['spawnPcm']>;

function fakeFfmpeg(
  pcmChunks: Buffer[] = [],
  closeCode: number | null = 0,
  stderrChunks: string[] = [],
): FakeFfmpegProcess {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (sig?: string) => void;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => {
    proc.stdout.end();
    setImmediate(() => proc.emit('close', null));
  };
  setImmediate(() => {
    for (const c of stderrChunks) proc.stderr.write(c);
    for (const c of pcmChunks) proc.stdout.write(c);
    proc.stdout.end();
    proc.stderr.end();
    setImmediate(() => proc.emit('close', closeCode));
  });
  return proc as unknown as FakeFfmpegProcess;
}

function makeDeps(liveSequence: LiveCheck[], opts: { urlFail?: number } = {}): {
  deps: Partial<CaptureDeps>;
  calls: { checkLive: number; getUrl: number; spawns: number };
} {
  const calls = { checkLive: 0, getUrl: 0, spawns: 0 };
  let urlFailures = opts.urlFail ?? 0;
  return {
    calls,
    deps: {
      checkLive: async () => {
        const next = liveSequence[Math.min(calls.checkLive, liveSequence.length - 1)];
        calls.checkLive++;
        return next;
      },
      getStreamUrl: async () => {
        calls.getUrl++;
        if (urlFailures > 0) {
          urlFailures--;
          throw new Error('yt-dlp transient failure');
        }
        return 'https://fake-hls/playlist.m3u8';
      },

      spawnPcm: () => {
        calls.spawns++;
        return fakeFfmpeg([Buffer.alloc(2048)]);
      },
      sleep: async () => {},
    },
  };
}

const LIVE: LiveCheck = { state: 'live', videoId: 'vid1', title: 'T' };
const OFFLINE: LiveCheck = { state: 'offline' };
const ERROR: LiveCheck = { state: 'error', message: '429 rate limited' };

describe('captureLive supervisor loop', () => {
  it('ffmpeg 退出後 offline → 正常結束（ended）', async () => {
    const { deps, calls } = makeDeps([OFFLINE]);
    const received: Buffer[] = [];
    const handle = captureLive('url', 'vid1', (c) => {
      received.push(c);
    }, deps);
    expect(await handle.done).toBe('ended');
    expect(received.length).toBeGreaterThan(0);
    expect(calls.spawns).toBe(1);
  });

  it('暫時性 error 不會結束場次：退避重試後仍在直播 → 繼續抓流', async () => {
    const { deps, calls } = makeDeps([ERROR, ERROR, LIVE, OFFLINE]);
    const handle = captureLive('url', 'vid1', () => {}, deps);
    expect(await handle.done).toBe('ended');
    expect(calls.spawns).toBe(2);
    expect(calls.checkLive).toBe(4);
  });

  it('連續 error 達上限（5 次）才放棄', async () => {
    const { deps, calls } = makeDeps([ERROR]);
    const handle = captureLive('url', 'vid1', () => {}, deps);
    expect(await handle.done).toBe('ended');
    expect(calls.checkLive).toBe(5);
    expect(calls.spawns).toBe(1);
  });

  it('取 URL 暫時性失敗會重試而非放棄', async () => {
    const { deps, calls } = makeDeps([LIVE, LIVE, OFFLINE], { urlFail: 2 });
    const handle = captureLive('url', 'vid1', () => {}, deps);
    expect(await handle.done).toBe('ended');
    expect(calls.getUrl).toBe(3);
    expect(calls.spawns).toBe(1);
  });

  it('換場（不同 videoId 在直播）視為本場結束', async () => {
    const { deps, calls } = makeDeps([{ state: 'live', videoId: 'OTHER', title: 'X' }]);
    const handle = captureLive('url', 'vid1', () => {}, deps);
    expect(await handle.done).toBe('ended');
    expect(calls.spawns).toBe(1);
  });

  it('abort → done resolve aborted', async () => {
    const { deps } = makeDeps([LIVE]);
    const handle = captureLive('url', 'vid1', () => {}, deps);
    setTimeout(() => handle.abort(), 20);
    expect(await handle.done).toBe('aborted');
  });
});

describe('captureFile', () => {
  it('YouTube URL 解析只選擇 HLS 音訊來源，避免 DASH 首段壞 fragment 造成空轉錄', () => {
    expect(ytDlpAudioArgs('https://www.youtube.com/watch?v=vid1')).toEqual([
      '-g',
      '-f',
      'worst[protocol^=m3u8][acodec!=none]',
      'https://www.youtube.com/watch?v=vid1',
    ]);
  });

  it('ffmpeg non-zero exit 會讓 capture 失敗，而不是產生空報告', async () => {
    const handle = captureFile('bad-input', () => {}, {
      spawnPcm: () => fakeFfmpeg([], 1, ['Invalid data found when processing input']),
    });

    await expect(handle.done).rejects.toThrow(/ffmpeg.*exit code 1.*Invalid data found/);
  });

  it('ffmpeg 成功但沒有輸出任何 PCM 時也視為失敗', async () => {
    const handle = captureFile('silent-output', () => {}, {
      spawnPcm: () => fakeFfmpeg([], 0),
    });

    await expect(handle.done).rejects.toThrow(/no PCM/i);
  });
});
