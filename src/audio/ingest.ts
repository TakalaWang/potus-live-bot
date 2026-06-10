import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { checkLive as defaultCheckLive } from '../watcher.js';

const execFileP = promisify(execFile);

// 暫時性錯誤（yt-dlp 失敗、429 限流）的重試上限與間隔：
// 連續 5 次（約 3 分鐘）都失敗才放棄本場直播
const MAX_CONSECUTIVE_ERRORS = 5;
const ERROR_RETRY_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

/**
 * 取得直播音訊串流 URL。
 * 注意：live 沒有 audio-only 格式（-f bestaudio 必失敗），
 * fallback 到最低畫質混流（itag 91, 144p）省頻寬，ffmpeg 再丟棄視訊。
 * 回傳的 HLS URL 約 6 小時過期。
 */
export async function getStreamUrl(videoId: string): Promise<string> {
  const { stdout } = await execFileP(
    'yt-dlp',
    ['-g', '-f', 'bestaudio/worst[acodec!=none]', `https://www.youtube.com/watch?v=${videoId}`],
    { timeout: 60_000 },
  );
  return stdout.trim().split('\n')[0];
}

/** ffmpeg：live HLS → 16kHz 16-bit mono PCM stdout */
export function spawnPcmProcess(hlsUrl: string) {
  return spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'warning', '-nostdin',
      // http reconnect 選項（hls demuxer 會轉發到每個 segment request）
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
      '-rw_timeout', '15000000', // 15s（微秒）：串流卡住直接報錯，讓 supervisor 重啟
      '-live_start_index', '-1', // 從最新 segment 開始（最低延遲）
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
  /** 直播真正結束（或被 abort）時 resolve */
  done: Promise<CaptureEndReason>;
  /** 主動中止（程序收到 SIGTERM/SIGINT 時由 index.ts 呼叫） */
  abort: () => void;
}

/** onPcm 回傳 Promise 時 capture 會等它處理完才讀下一個 chunk（backpressure） */
export type PcmHandler = (chunk: Buffer) => void | Promise<void>;

/** 測試注入點 */
export interface CaptureDeps {
  checkLive: typeof defaultCheckLive;
  getStreamUrl: typeof getStreamUrl;
  spawnPcm: typeof spawnPcmProcess;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Supervisor loop：直播期間持續拉 PCM。
 * - ffmpeg 退出（HLS URL 過期、斷線）→ 重新確認直播狀態、拿新 URL 續抓。
 * - checkLive 回 'error'（暫時性失敗，如限流）→ 退避重試，連續超過上限才放棄；
 *   只有明確 offline / 換場才視為直播結束。
 */
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
      // 1) 確認直播狀態（第一輪由呼叫端確認過，跳過以免重複打 YouTube）
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
          return 'ended'; // 明確結束（offline / post_live / 換了另一場）
        }
      }
      firstIteration = false;

      // 2) 取串流 URL（失敗同樣視為暫時性）
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

      // 3) 抓流直到 ffmpeg 退出
      const code = await pumpPcm(d.spawnPcm(url), onPcm, (ff) => {
        current = ff;
        if (aborted) ff.kill('SIGTERM'); // abort 落在 spawn 之前的空窗
      });
      current = null;
      if (aborted) return 'aborted';

      console.log(`[ingest] ffmpeg 退出（code ${code}），重新確認直播狀態`);
      await d.sleep(RECONNECT_DELAY_MS);
      // 迴圈頂端重新 checkLive：仍在直播 → 新 URL 續抓；offline → 結束；error → 退避重試
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

/** replay 來源：本地檔直接用，YouTube 網址先解析出串流 URL */
export async function resolveReplaySource(source: string): Promise<string> {
  if (!/^https?:\/\//.test(source)) return source;
  const { stdout } = await execFileP(
    'yt-dlp',
    ['-g', '-f', 'bestaudio/worst[acodec!=none]', source],
    { timeout: 60_000 },
  );
  return stdout.trim().split('\n')[0];
}

/** replay 模式：把本地檔/串流 URL 當假直播灌入管線（onPcm 的 await 提供 backpressure） */
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

/**
 * 消費一個 ffmpeg process 的 stdout 直到結束，回傳 exit code。
 * 用 for-await 消費：onPcm 處理完才讀下一個 chunk，replay 全速解碼時不會堆積記憶體。
 * 'error' listener 必掛：spawn 失敗（ENOENT、EMFILE）沒掛會直接 crash 整個程序。
 */
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
