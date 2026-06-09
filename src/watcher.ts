import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LiveCheck } from './types.js';

const execFileP = promisify(execFile);

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = (cmd, args) =>
  execFileP(cmd, args, { timeout: 60_000 });

/**
 * 偵測頻道是否在直播。
 * yt-dlp exit code 1 同時代表「沒開播」與真錯誤，必須解析 stderr 區分。
 */
export async function checkLive(
  channelLiveUrl: string,
  exec: ExecFn = defaultExec,
): Promise<LiveCheck> {
  try {
    const { stdout } = await exec('yt-dlp', [
      // 沒有這個 flag，已排程直播會 exit 1（'This live event will begin in ...'）
      '--ignore-no-formats-error',
      '--no-warnings',
      '--print',
      '%(id)s|%(live_status)s|%(title)s',
      channelLiveUrl,
    ]);
    const [videoId, liveStatus, ...rest] = stdout.trim().split('|');
    const title = rest.join('|'); // 標題本身可能含 '|'
    if (liveStatus === 'is_live') return { state: 'live', videoId, title };
    if (liveStatus === 'is_upcoming') return { state: 'upcoming', videoId, title };
    return { state: 'offline' }; // post_live / was_live：直播剛結束
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('The channel is not currently live')) return { state: 'offline' };
    return { state: 'error', message: stderr.trim() || String(err) };
  }
}
