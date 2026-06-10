import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { checkLive as defaultCheckLive } from '../watcher.js';

const execFileP = promisify(execFile);

const MAX_CONSECUTIVE_ERRORS = 5;
const ERROR_RETRY_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

export async function getStreamUrl(videoId: string): Promise<string> {
  const { stdout } = await execFileP(
    'yt-dlp',
    ['-g', '-f', 'bestaudio/worst[acodec!=none]', `https://www.youtube.com/watch?v=${videoId}`],
    { timeout: 60_000 },
  );
  return stdout.trim().split('\n')[0];
}

export function spawnPcmProcess(hlsUrl: string) {
  return spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'warning', '-nostdin',

      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
      '-rw_timeout', '15000000',
      '-live_start_index', '-1',
      '-i', hlsUrl,
      '-vn',
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

export type CaptureEndReason = 'ended' | 'aborted';

export interface CaptureHandle {
  done: Promise<CaptureEndReason>;

  abort: () => void;
}

export type PcmHandler = (chunk: Buffer) => void | Promise<void>;

export interface CaptureDeps {
  checkLive: typeof defaultCheckLive;
  getStreamUrl: typeof getStreamUrl;
  spawnPcm: typeof spawnPcmProcess;
  sleep: (ms: number) => Promise<void>;
}

export function captureLive(
  channelLiveUrl: string,
  videoId: string,
  onPcm: PcmHandler,
  overrides: Partial<CaptureDeps> = {},
): CaptureHandle {
  const d: CaptureDeps = {
    checkLive: defaultCheckLive,
    getStreamUrl,
    spawnPcm: spawnPcmProcess,
    sleep,
    ...overrides,
  };
  let aborted = false;
  let current: ReturnType<typeof spawnPcmProcess> | null = null;

  const done: Promise<CaptureEndReason> = (async () => {
    let consecutiveErrors = 0;
    let firstIteration = true;
    while (!aborted) {
      if (!firstIteration) {
        const status = await d.checkLive(channelLiveUrl);
        if (aborted) return 'aborted';
        if (status.state === 'error') {
          consecutiveErrors++;
          console.warn(`[ingest] 直播狀態查詢失敗（${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}）：${status.message}`);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.error('[ingest] 連續查詢失敗，放棄本場直播');
            return 'ended';
          }
          await d.sleep(ERROR_RETRY_MS);
          continue;
        }
        if (status.state !== 'live' || status.videoId !== videoId) {
          return 'ended';
        }
      }
      firstIteration = false;

      let url: string;
      try {
        url = await d.getStreamUrl(videoId);
      } catch (err) {
        if (aborted) return 'aborted';
        consecutiveErrors++;
        console.warn(`[ingest] 取串流 URL 失敗（${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}）：${(err as Error).message}`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error('[ingest] 連續取 URL 失敗，放棄本場直播');
          return 'ended';
        }
        await d.sleep(ERROR_RETRY_MS);
        continue;
      }
      if (aborted) return 'aborted';
      consecutiveErrors = 0;

      const code = await pumpPcm(d.spawnPcm(url), onPcm, (ff) => {
        current = ff;
        if (aborted) ff.kill('SIGTERM');
      });
      current = null;
      if (aborted) return 'aborted';

      console.log(`[ingest] ffmpeg 退出（code ${code}），重新確認直播狀態`);
      await d.sleep(RECONNECT_DELAY_MS);

    }
    return 'aborted';
  })();

  return {
    done,
    abort: () => {
      aborted = true;
      current?.kill('SIGTERM');
    },
  };
}

export async function resolveReplaySource(source: string): Promise<string> {
  if (!/^https?:\/\//.test(source)) return source;
  const { stdout } = await execFileP(
    'yt-dlp',
    ['-g', '-f', 'bestaudio/worst[acodec!=none]', source],
    { timeout: 60_000 },
  );
  return stdout.trim().split('\n')[0];
}

export function captureFile(input: string, onPcm: PcmHandler): CaptureHandle {
  const ff = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-i', input, '-vn', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let aborted = false;
  const done: Promise<CaptureEndReason> = pumpPcm(ff, onPcm, () => {}).then(() =>
    aborted ? 'aborted' : 'ended',
  );
  return {
    done,
    abort: () => {
      aborted = true;
      ff.kill('SIGTERM');
    },
  };
}

async function pumpPcm(
  ff: ReturnType<typeof spawnPcmProcess>,
  onPcm: PcmHandler,
  onSpawned: (ff: ReturnType<typeof spawnPcmProcess>) => void,
): Promise<number | null> {
  const closed = new Promise<number | null>((resolve) => ff.on('close', resolve));
  ff.on('error', (err) => console.error('[ffmpeg] spawn/process 錯誤：', err.message));
  ff.stderr.on('data', (d: Buffer) => console.warn(`[ffmpeg] ${d.toString().trim()}`));
  onSpawned(ff);
  try {
    for await (const chunk of ff.stdout) {
      await onPcm(chunk as Buffer);
    }
  } catch (err) {
    console.warn('[ingest] PCM stream 讀取中斷：', (err as Error).message);
  }
  return closed;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
