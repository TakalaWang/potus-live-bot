import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { checkLive } from '../watcher.js';

const execFileP = promisify(execFile);

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

export interface CaptureHandle {
  /** 直播真正結束時 resolve */
  done: Promise<void>;
  /** 主動中止（如程序收到 SIGTERM） */
  abort: () => void;
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

/** replay 模式：把本地檔/串流 URL 當假直播全速灌入管線 */
export function captureFile(input: string, onPcm: (chunk: Buffer) => void): CaptureHandle {
  const ff = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-i', input, '-vn', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  ff.stdout.on('data', onPcm);
  ff.stderr.on('data', (d: Buffer) => console.warn(`[ffmpeg] ${d.toString().trim()}`));
  const done = new Promise<void>((resolve) => {
    ff.on('close', () => resolve());
  });
  return { done, abort: () => void ff.kill('SIGTERM') };
}

/**
 * Supervisor loop：直播期間持續拉 PCM。
 * ffmpeg 退出（HLS URL 過期、斷線）→ 重新確認直播狀態、拿新 URL 續抓；
 * 確認不再是 live 才結束。
 */
export function captureLive(
  channelLiveUrl: string,
  videoId: string,
  onPcm: (chunk: Buffer) => void,
): CaptureHandle {
  let aborted = false;
  let current: ReturnType<typeof spawnPcmProcess> | null = null;

  const done = (async () => {
    let consecutiveErrors = 0;
    while (!aborted) {
      let url: string;
      try {
        url = await getStreamUrl(videoId);
      } catch (err) {
        // 拿不到 URL：可能直播剛結束，確認狀態
        const status = await checkLive(channelLiveUrl);
        if (status.state !== 'live' || status.videoId !== videoId) return;
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          console.error('[ingest] 連續取 URL 失敗，放棄本場直播：', (err as Error).message);
          return;
        }
        await sleep(10_000);
        continue;
      }
      consecutiveErrors = 0;

      const ff = spawnPcmProcess(url);
      current = ff;
      ff.stdout.on('data', onPcm);
      ff.stderr.on('data', (d: Buffer) => console.warn(`[ffmpeg] ${d.toString().trim()}`));
      const code: number | null = await new Promise((resolve) => ff.on('close', resolve));
      current = null;
      if (aborted) return;

      console.log(`[ingest] ffmpeg 退出（code ${code}），重新確認直播狀態`);
      await sleep(5_000);
      const status = await checkLive(channelLiveUrl);
      if (status.state !== 'live' || status.videoId !== videoId) {
        return; // 直播結束（或換了另一場）→ 觸發後續分析
      }
      // 仍在直播（URL 過期或短暫斷線）→ 迴圈拿新 URL 續抓
    }
  })();

  return {
    done,
    abort: () => {
      aborted = true;
      current?.kill('SIGTERM');
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
