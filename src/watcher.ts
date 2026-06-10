import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LiveCheck } from './types.js';

const execFileP = promisify(execFile);

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = (cmd, args) =>
  execFileP(cmd, args, { timeout: 60_000 });

export async function checkLive(
  channelLiveUrl: string,
  exec: ExecFn = defaultExec,
): Promise<LiveCheck> {
  try {
    const { stdout } = await exec('yt-dlp', [

      '--ignore-no-formats-error',
      '--no-warnings',
      '--print',
      '%(id)s|%(live_status)s|%(title)s',
      channelLiveUrl,
    ]);
    const [videoId, liveStatus, ...rest] = stdout.trim().split('|');
    const title = rest.join('|');
    if (liveStatus === 'is_live') return { state: 'live', videoId, title };
    if (liveStatus === 'is_upcoming') return { state: 'upcoming', videoId, title };
    return { state: 'offline' };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('The channel is not currently live')) return { state: 'offline' };
    return { state: 'error', message: stderr.trim() || String(err) };
  }
}
