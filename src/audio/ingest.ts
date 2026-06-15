import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { checkLive as defaultCheckLive } from '../watcher.js';

const execFileP = promisify(execFile);

const MAX_CONSECUTIVE_ERRORS = 5;
const ERROR_RETRY_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;
export const YOUTUBE_AUDIO_FORMAT = 'worst[protocol^=m3u8][acodec!=none]';

export function ytDlpAudioArgs(source: string): string[] {
  return ['-g', '-f', YOUTUBE_AUDIO_FORMAT, source];
}

export async function getStreamUrl(videoId: string): Promise<string> {
  const { stdout } = await execFileP(
    'yt-dlp',
    ytDlpAudioArgs(`https://www.youtube.com/watch?v=${videoId}`),
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

export function spawnFilePcmProcess(input: string) {
  return spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-i', input, '-vn', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
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

export interface CaptureFileDeps {
  spawnPcm: typeof spawnFilePcmProcess;
}

type PcmProcess = ReturnType<typeof spawnPcmProcess>;
type LiveLoopDecision =
  | { status: 'continue'; consecutiveErrors: number }
  | { status: 'retry'; consecutiveErrors: number }
  | { status: CaptureEndReason; consecutiveErrors: number };
type StreamUrlDecision =
  | { status: 'continue'; consecutiveErrors: number; url: string }
  | { status: 'retry'; consecutiveErrors: number }
  | { status: CaptureEndReason; consecutiveErrors: number };
type RecoverableFailureDecision =
  | { status: 'retry'; consecutiveErrors: number }
  | { status: 'ended'; consecutiveErrors: number };

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
  let current: PcmProcess | null = null;

  const done = runLiveCaptureLoop(channelLiveUrl, videoId, onPcm, d, {
    isAborted: () => aborted,
    setCurrent: (ff) => {
      current = ff;
    },
  });

  return {
    done,
    abort: () => {
      aborted = true;
      current?.kill('SIGTERM');
    },
  };
}

async function runLiveCaptureLoop(
  channelLiveUrl: string,
  videoId: string,
  onPcm: PcmHandler,
  d: CaptureDeps,
  state: { isAborted: () => boolean; setCurrent: (ff: PcmProcess | null) => void },
): Promise<CaptureEndReason> {
  let consecutiveErrors = 0;
  let shouldCheckLive = false;
  while (!state.isAborted()) {
    if (shouldCheckLive) {
      const live = await confirmLiveOrEnd(channelLiveUrl, videoId, d, state.isAborted, consecutiveErrors);
      consecutiveErrors = live.consecutiveErrors;
      if (live.status === 'retry') continue;
      if (live.status !== 'continue') return live.status;
    }
    shouldCheckLive = true;

    const stream = await resolveLiveStreamUrl(videoId, d, state.isAborted, consecutiveErrors);
    consecutiveErrors = stream.consecutiveErrors;
    if (stream.status === 'retry') continue;
    if (stream.status !== 'continue') return stream.status;

    consecutiveErrors = 0;
    const capture = await pumpLiveStream(stream.url, onPcm, d, state);
    if (capture === 'aborted') return capture;
    await d.sleep(RECONNECT_DELAY_MS);
  }
  return 'aborted';
}

async function confirmLiveOrEnd(
  channelLiveUrl: string,
  videoId: string,
  d: CaptureDeps,
  isAborted: () => boolean,
  consecutiveErrors: number,
): Promise<LiveLoopDecision> {
  const status = await d.checkLive(channelLiveUrl);
  if (isAborted()) return { status: 'aborted', consecutiveErrors };
  if (status.state === 'error') {
    const decision = recoverableFailure(
      consecutiveErrors,
      `直播狀態查詢失敗：${status.message}`,
      '連續查詢失敗，放棄本場直播',
    );
    if (decision.status === 'retry') await d.sleep(ERROR_RETRY_MS);
    return decision;
  }
  if (status.state !== 'live' || status.videoId !== videoId) return { status: 'ended', consecutiveErrors };
  return { status: 'continue', consecutiveErrors };
}

async function resolveLiveStreamUrl(
  videoId: string,
  d: CaptureDeps,
  isAborted: () => boolean,
  consecutiveErrors: number,
): Promise<StreamUrlDecision> {
  try {
    const url = await d.getStreamUrl(videoId);
    return isAborted() ? { status: 'aborted', consecutiveErrors } : { status: 'continue', consecutiveErrors, url };
  } catch (err) {
    if (isAborted()) return { status: 'aborted', consecutiveErrors };
    const decision = recoverableFailure(
      consecutiveErrors,
      `取串流 URL 失敗：${(err as Error).message}`,
      '連續取 URL 失敗，放棄本場直播',
    );
    if (decision.status === 'retry') await d.sleep(ERROR_RETRY_MS);
    return decision;
  }
}

function recoverableFailure(
  consecutiveErrors: number,
  message: string,
  giveUpMessage: string,
): RecoverableFailureDecision {
  const nextErrors = consecutiveErrors + 1;
  console.warn(`[ingest] ${message}（${nextErrors}/${MAX_CONSECUTIVE_ERRORS}）`);
  if (nextErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.error(`[ingest] ${giveUpMessage}`);
    return { status: 'ended', consecutiveErrors: nextErrors };
  }
  return { status: 'retry', consecutiveErrors: nextErrors };
}

async function pumpLiveStream(
  url: string,
  onPcm: PcmHandler,
  d: CaptureDeps,
  state: { isAborted: () => boolean; setCurrent: (ff: PcmProcess | null) => void },
): Promise<'continue' | 'aborted'> {
  const result = await pumpPcm(d.spawnPcm(url), onPcm, (ff) => {
    state.setCurrent(ff);
    if (state.isAborted()) ff.kill('SIGTERM');
  });
  state.setCurrent(null);
  if (state.isAborted()) return 'aborted';
  console.log(`[ingest] ffmpeg 退出（code ${result.exitCode}，PCM ${result.bytes} bytes），重新確認直播狀態`);
  return 'continue';
}

export async function resolveReplaySource(source: string): Promise<string> {
  if (!/^https?:\/\//.test(source)) return source;
  const { stdout } = await execFileP(
    'yt-dlp',
    ytDlpAudioArgs(source),
    { timeout: 60_000 },
  );
  return stdout.trim().split('\n')[0];
}

export function captureFile(
  input: string,
  onPcm: PcmHandler,
  overrides: Partial<CaptureFileDeps> = {},
): CaptureHandle {
  const d: CaptureFileDeps = { spawnPcm: spawnFilePcmProcess, ...overrides };
  const ff = d.spawnPcm(input);
  let aborted = false;
  const done: Promise<CaptureEndReason> = (async () => {
    const result = await pumpPcm(ff, onPcm, () => {});
    if (aborted) return 'aborted';
    if (result.processError) {
      throw new Error(`ffmpeg failed to start for ${input}: ${result.processError.message}`);
    }
    if (result.exitCode !== 0) {
      throw new Error(formatFfmpegFailure(input, result));
    }
    if (result.bytes === 0) {
      throw new Error(`ffmpeg produced no PCM for ${input}${result.stderr ? `: ${result.stderr}` : ''}`);
    }
    return 'ended';
  })();
  return {
    done,
    abort: () => {
      aborted = true;
      ff.kill('SIGTERM');
    },
  };
}

interface PumpResult {
  exitCode: number | null;
  bytes: number;
  stderr: string;
  processError: Error | null;
}

const STDERR_LIMIT = 8192;

async function pumpPcm(
  ff: ReturnType<typeof spawnPcmProcess>,
  onPcm: PcmHandler,
  onSpawned: (ff: ReturnType<typeof spawnPcmProcess>) => void,
): Promise<PumpResult> {
  let bytes = 0;
  let stderr = '';
  let processError: Error | null = null;
  const closed = new Promise<number | null>((resolve) => ff.on('close', resolve));
  ff.on('error', (err) => {
    processError = err;
    console.error('[ffmpeg] spawn/process 錯誤：', err.message);
  });
  ff.stderr.on('data', (d: Buffer) => {
    const text = d.toString().trim();
    if (text) {
      stderr = `${stderr}${text}\n`.slice(-STDERR_LIMIT);
      console.warn(`[ffmpeg] ${text}`);
    }
  });
  onSpawned(ff);
  try {
    for await (const chunk of ff.stdout) {
      const pcm = chunk as Buffer;
      bytes += pcm.length;
      await onPcm(pcm);
    }
  } catch (err) {
    console.warn('[ingest] PCM stream 讀取中斷：', (err as Error).message);
  }
  const exitCode = await closed;
  return { exitCode, bytes, stderr: stderr.trim(), processError };
}

function formatFfmpegFailure(input: string, result: PumpResult): string {
  const exit = result.exitCode === null ? 'without an exit code' : `with exit code ${result.exitCode}`;
  const stderr = result.stderr ? `: ${result.stderr}` : '';
  return `ffmpeg failed for ${input} ${exit} after ${result.bytes} PCM bytes${stderr}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
