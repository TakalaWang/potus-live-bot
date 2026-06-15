export interface Config {
  discordBotToken: string;
  discordChannelId?: string;
  subscriptionsUrl?: string;
  subscriptionsSecret?: string;
  geminiApiKey: string;
  youtubeChannelUrl: string;
  pollIntervalSec: number;
  dataDir: string;
  transcribeModel: string;
  analyzeModel: string;
  vadModelPath: string;
}

const REQUIRED_KEYS = ['DISCORD_BOT_TOKEN', 'GEMINI_API_KEY'] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`缺少必要環境變數：${missing.join(', ')}`);
  }

  const pollRaw = env.POLL_INTERVAL_SEC ?? '60';
  const pollIntervalSec = Number(pollRaw);
  if (!Number.isFinite(pollIntervalSec) || pollIntervalSec <= 0) {
    throw new Error(`POLL_INTERVAL_SEC 必須是正數，收到：${pollRaw}`);
  }

  if (env.SUBSCRIPTIONS_URL && !env.SUBSCRIPTIONS_SECRET) {
    throw new Error('設定 SUBSCRIPTIONS_URL 時必須同時設定 SUBSCRIPTIONS_SECRET');
  }

  return {
    discordBotToken: env.DISCORD_BOT_TOKEN!,
    discordChannelId: env.DISCORD_CHANNEL_ID || undefined,
    subscriptionsUrl: env.SUBSCRIPTIONS_URL || undefined,
    subscriptionsSecret: env.SUBSCRIPTIONS_SECRET || undefined,
    geminiApiKey: env.GEMINI_API_KEY!,
    youtubeChannelUrl: env.YOUTUBE_CHANNEL_URL ?? 'https://www.youtube.com/@WhiteHouse/live',
    pollIntervalSec,
    dataDir: env.DATA_DIR ?? './data',
    transcribeModel: env.GEMINI_TRANSCRIBE_MODEL ?? 'gemini-3.1-flash-lite',
    analyzeModel: env.GEMINI_ANALYZE_MODEL ?? 'gemini-3.1-flash-lite',
    vadModelPath: env.VAD_MODEL_PATH ?? 'models/silero_vad.onnx',
  };
}
