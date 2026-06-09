import { existsSync } from 'node:fs';
import { Analyzer } from './analysis/analyzer.js';
import { getQuotes } from './analysis/quotes.js';
import { Transcriber } from './asr/gemini.js';
import { SpeechChunker } from './audio/chunker.js';
import { captureFile, captureLive, resolveReplaySource } from './audio/ingest.js';
import { SileroVad } from './audio/vad.js';
import { loadConfig, type Config } from './config.js';
import { ConsoleNotifier } from './discord/console-notifier.js';
import { Notifier, type NotifierLike } from './discord/notifier.js';
import { createGenAI } from './genai.js';
import { runLiveSession, type PipelineDeps, type SessionMeta } from './pipeline.js';
import { SeenStore, TranscriptStore } from './state.js';
import { checkLive } from './watcher.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const replayIdx = argv.indexOf('--replay');
  const noDiscord = argv.includes('--no-discord');

  const env: Record<string, string | undefined> = { ...process.env };
  if (noDiscord) {
    env.DISCORD_BOT_TOKEN ??= '-';
    env.DISCORD_CHANNEL_ID ??= '-';
  }
  const config = loadConfig(env);

  if (!existsSync(config.vadModelPath)) {
    throw new Error(`找不到 VAD 模型 ${config.vadModelPath}，請先執行 npm run download-model`);
  }

  const ai = createGenAI(config.geminiApiKey);
  const transcriber = new Transcriber(ai, config.transcribeModel);
  const analyzer = new Analyzer(ai, config.analyzeModel);
  const vad = await SileroVad.create(config.vadModelPath);
  const notifier: NotifierLike = noDiscord
    ? new ConsoleNotifier()
    : new Notifier(config.discordBotToken, config.discordChannelId);
  await notifier.start();

  const sessionDeps = (videoId: string, startCapture: PipelineDeps['startCapture']): PipelineDeps => ({
    vad,
    chunker: new SpeechChunker(),
    transcript: new TranscriptStore(config.dataDir, videoId),
    transcriber,
    analyzer,
    getQuotes,
    notifier,
    startCapture,
  });

  if (replayIdx !== -1) {
    const source = argv[replayIdx + 1];
    if (!source) throw new Error('--replay 需要本地影片檔路徑或 YouTube 網址');
    await runReplay(source, config, sessionDeps);
    await notifier.stop();
    return;
  }

  console.log(`[main] 開始監測 ${config.youtubeChannelUrl}（每 ${config.pollIntervalSec}s 輪詢）`);
  const seen = new SeenStore(config.dataDir);
  for (;;) {
    try {
      await pollOnce(config, seen, notifier, vad, sessionDeps);
    } catch (err) {
      console.error('[main] 主迴圈錯誤：', err);
    }
    await sleep(config.pollIntervalSec * 1000);
  }
}

async function pollOnce(
  config: Config,
  seen: SeenStore,
  notifier: NotifierLike,
  vad: SileroVad,
  sessionDeps: (videoId: string, startCapture: PipelineDeps['startCapture']) => PipelineDeps,
): Promise<void> {
  const status = await checkLive(config.youtubeChannelUrl);
  if (status.state === 'error') {
    console.warn(`[main] 偵測錯誤：${status.message}`);
    return;
  }
  if (status.state !== 'live' || seen.isSeen(`done:${status.videoId}`)) return;

  const { videoId, title } = status;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  if (!seen.isSeen(videoId)) {
    seen.markSeen(videoId);
    await notifier.notifyLiveStart(title, videoUrl);
    console.log(`[main] 直播開始：${title}（${videoId}）`);
  } else {
    // 程序重啟後重新接上：不重複通知，續寫同一份逐字稿
    console.log(`[main] 重新接上進行中的直播：${videoId}`);
  }

  vad.reset();
  const meta: SessionMeta = { videoId, title, videoUrl };
  await runLiveSession(
    meta,
    sessionDeps(videoId, (onPcm) => captureLive(config.youtubeChannelUrl, videoId, onPcm)),
  );
  seen.markSeen(`done:${videoId}`);
  console.log(`[main] 場次處理完成：${videoId}`);
}

async function runReplay(
  source: string,
  config: Config,
  sessionDeps: (videoId: string, startCapture: PipelineDeps['startCapture']) => PipelineDeps,
): Promise<void> {
  const videoId = `replay-${source.replace(/[^A-Za-z0-9_-]/g, '').slice(-20) || 'local'}`;
  console.log(`[replay] 來源：${source}（session：${videoId}）`);
  const input = await resolveReplaySource(source);
  await runLiveSession(
    { videoId, title: `Replay：${source}`, videoUrl: source },
    sessionDeps(videoId, (onPcm) => captureFile(input, onPcm)),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
