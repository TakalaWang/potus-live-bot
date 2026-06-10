import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { captureLive, type CaptureDeps } from '../src/audio/ingest.js';
import type { LiveCheck } from '../src/types.js';

/** fake ffmpeg：emit 指定的 PCM 後以 code 0 結束 */
function fakeFfmpeg(pcmChunks: Buffer[] = []) {
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
    for (const c of pcmChunks) proc.stdout.write(c);
    proc.stdout.end();
    setImmediate(() => proc.emit('close', 0));
  });
  return proc;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnPcm: (() => {
        calls.spawns++;
        return fakeFfmpeg([Buffer.alloc(2048)]);
      }) as any,
      sleep: async () => {},
    },
  };
}

const LIVE: LiveCheck = { state: 'live', videoId: 'vid1', title: 'T' };
const OFFLINE: LiveCheck = { state: 'offline' };
const ERROR: LiveCheck = { state: 'error', message: '429 rate limited' };

describe('captureLive supervisor loop', () => {
  it('ffmpeg 退出後 offline → 正常結束（ended）', async () => {
    const { deps, calls } = makeDeps([OFFLINE]); // 第一輪跳過 checkLive，ffmpeg 退出後查到 offline
    const received: Buffer[] = [];
    const handle = captureLive('url', 'vid1', (c) => {
      received.push(c);
    }, deps);
    expect(await handle.done).toBe('ended');
    expect(received.length).toBeGreaterThan(0);
    expect(calls.spawns).toBe(1);
  });

  it('暫時性 error 不會結束場次：退避重試後仍在直播 → 繼續抓流', async () => {
    // ffmpeg 退出 → checkLive 回 error、error → 重試後回 live → 再抓一輪 → offline 結束
    const { deps, calls } = makeDeps([ERROR, ERROR, LIVE, OFFLINE]);
    const handle = captureLive('url', 'vid1', () => {}, deps);
    expect(await handle.done).toBe('ended');
    expect(calls.spawns).toBe(2); // 第一輪 + error 重試成功後的第二輪
    expect(calls.checkLive).toBe(4);
  });

  it('連續 error 達上限（5 次）才放棄', async () => {
    const { deps, calls } = makeDeps([ERROR]); // 永遠 error
    const handle = captureLive('url', 'vid1', () => {}, deps);
    expect(await handle.done).toBe('ended');
    expect(calls.checkLive).toBe(5);
    expect(calls.spawns).toBe(1); // 只有第一輪抓到流
  });

  it('取 URL 暫時性失敗會重試而非放棄', async () => {
    // 每次 URL 失敗後 supervisor 會先重新確認直播狀態，再重試取 URL
    const { deps, calls } = makeDeps([LIVE, LIVE, OFFLINE], { urlFail: 2 });
    const handle = captureLive('url', 'vid1', () => {}, deps);
    expect(await handle.done).toBe('ended');
    expect(calls.getUrl).toBe(3); // 失敗 2 次 + 成功 1 次
    expect(calls.spawns).toBe(1);
  });

  it('換場（不同 videoId 在直播）視為本場結束', async () => {
    const { deps, calls } = makeDeps([{ state: 'live', videoId: 'OTHER', title: 'X' }]);
    const handle = captureLive('url', 'vid1', () => {}, deps);
    expect(await handle.done).toBe('ended');
    expect(calls.spawns).toBe(1);
  });

  it('abort → done resolve aborted', async () => {
    // 永遠 live：沒有 abort 的話 loop 不會結束
    const { deps } = makeDeps([LIVE]);
    const handle = captureLive('url', 'vid1', () => {}, deps);
    setTimeout(() => handle.abort(), 20);
    expect(await handle.done).toBe('aborted');
  });
});
