import { describe, expect, it } from 'vitest';
import { checkLive, type ExecFn } from '../src/watcher.js';

const ok = (stdout: string): ExecFn => async () => ({ stdout });
const fail = (stderr: string): ExecFn => async () => {
  const err = new Error('exit 1') as Error & { stderr: string };
  err.stderr = stderr;
  throw err;
};

describe('checkLive', () => {
  it('is_live → live 並解析 id 與標題', async () => {
    const result = await checkLive('url', ok('X4Vbdwhk|is_live|President Delivers Remarks\n'));
    expect(result).toEqual({ state: 'live', videoId: 'X4Vbdwhk', title: 'President Delivers Remarks' });
  });

  it('標題含 | 時不會被切壞', async () => {
    const result = await checkLive('url', ok('abc|is_live|Title | With Pipe'));
    expect(result).toEqual({ state: 'live', videoId: 'abc', title: 'Title | With Pipe' });
  });

  it('is_upcoming → upcoming', async () => {
    const result = await checkLive('url', ok('abc|is_upcoming|Scheduled Event'));
    expect(result.state).toBe('upcoming');
  });

  it('post_live → offline（直播剛結束）', async () => {
    const result = await checkLive('url', ok('abc|post_live|Just Ended'));
    expect(result.state).toBe('offline');
  });

  it('exit 1 + not currently live → offline', async () => {
    const result = await checkLive(
      'url',
      fail('ERROR: [youtube:tab] @WhiteHouse: The channel is not currently live'),
    );
    expect(result.state).toBe('offline');
  });

  it('exit 1 + 其他錯誤 → error 帶訊息', async () => {
    const result = await checkLive('url', fail('ERROR: network unreachable'));
    expect(result).toEqual({ state: 'error', message: 'ERROR: network unreachable' });
  });
});
