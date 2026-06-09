import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED = {
  DISCORD_BOT_TOKEN: 'token',
  DISCORD_CHANNEL_ID: '123456789',
  GEMINI_API_KEY: 'key',
};

describe('loadConfig', () => {
  it('缺必填變數時丟錯並列出缺哪些', () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_BOT_TOKEN.*DISCORD_CHANNEL_ID.*GEMINI_API_KEY/s);
  });

  it('只缺一個時只列那一個', () => {
    const env = { ...REQUIRED } as Record<string, string>;
    delete env.GEMINI_API_KEY;
    expect(() => loadConfig(env)).toThrow(/GEMINI_API_KEY/);
    expect(() => loadConfig(env)).not.toThrow(/DISCORD_BOT_TOKEN/);
  });

  it('套用預設值', () => {
    const cfg = loadConfig({ ...REQUIRED });
    expect(cfg.youtubeChannelUrl).toBe('https://www.youtube.com/@WhiteHouse/live');
    expect(cfg.pollIntervalSec).toBe(60);
    expect(cfg.dataDir).toBe('./data');
    expect(cfg.transcribeModel).toBe('gemini-3.1-flash-lite');
    expect(cfg.analyzeModel).toBe('gemini-3.5-flash');
  });

  it('覆寫預設值並解析數字', () => {
    const cfg = loadConfig({
      ...REQUIRED,
      POLL_INTERVAL_SEC: '30',
      YOUTUBE_CHANNEL_URL: 'https://www.youtube.com/@foo/live',
      DATA_DIR: '/var/data',
      GEMINI_TRANSCRIBE_MODEL: 'gemini-3.5-flash',
    });
    expect(cfg.pollIntervalSec).toBe(30);
    expect(cfg.youtubeChannelUrl).toBe('https://www.youtube.com/@foo/live');
    expect(cfg.dataDir).toBe('/var/data');
    expect(cfg.transcribeModel).toBe('gemini-3.5-flash');
  });

  it('POLL_INTERVAL_SEC 不是數字時丟錯', () => {
    expect(() => loadConfig({ ...REQUIRED, POLL_INTERVAL_SEC: 'abc' })).toThrow(/POLL_INTERVAL_SEC/);
  });
});
