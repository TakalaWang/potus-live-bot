import { existsSync, readdirSync } from 'node:fs';
import { runAgentPass, WorkerAgentClient } from './agent.js';
import { Analyzer } from './analysis/analyzer.js';
import { getQuotes } from './analysis/quotes.js';
import { Transcriber } from './asr/gemini.js';
import { SpeechChunker } from './audio/chunker.js';
import { captureFile, captureLive, resolveReplaySource, type CaptureHandle } from './audio/ingest.js';
import { SileroVad } from './audio/vad.js';
import { loadConfig, type Config } from './config.js';
import { ConsoleNotifier } from './discord/console-notifier.js';
import { Notifier, type NotifierLike } from './discord/notifier.js';
import { RestNotifier } from './discord/rest-notifier.js';
import { createGenAI } from './genai.js';
import {
  runLiveSession,
  runPostAnalysis,
  type PipelineDeps,
  type PostAnalysisDeps,
  type SessionMeta,
} from './pipeline.js';
import { SeenStore, TranscriptStore } from './state.js';
import { checkLive } from './watcher.js';

let shuttingDown = false;
let activeCapture: CaptureHandle | null = null;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const replayIdx = argv.indexOf('--replay');
  const agentMode = argv.includes('--agent');
  const noDiscord = argv.includes('--no-discord');

  const env: Record<string, string | undefined> = { ...process.env };
  if (noDiscord) {
    env.DISCORD_BOT_TOKEN ??= '-';
  }
  const config = loadConfig(env);

  if (!existsSync(config.vadModelPath)) {
    throw new Error(`找不到 VAD 模型 ${config.vadModelPath}，請先執行 npm run download-model`);
  }

  const ai = createGenAI(config.geminiApiKey);
  const transcriber = new Transcriber(ai, config.transcribeModel);
  const analyzer = new Analyzer(ai, config.analyzeModel);
  const vad = await SileroVad.create(config.vadModelPath);
  const notifier = await buildNotifier(config, noDiscord);
  await notifier.start();

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      console.log(`[main] 收到 ${sig}，優雅關閉中（flush 逐字稿後退出）`);
      shuttingDown = true;
      if (activeCapture) {
        activeCapture.abort();
      } else {
        void notifier.stop().finally(() => process.exit(0));
      }
    });
  }

  const sessionDeps = (videoId: string, startCapture: PipelineDeps['startCapture']): PipelineDeps => ({
    vad,
    chunker: new SpeechChunker(),
    transcript: new TranscriptStore(config.dataDir, videoId),
    transcriber,
    analyzer,
    getQuotes,
    notifier,
    startCapture: (onPcm) => {
      const handle = startCapture(onPcm);
      activeCapture = handle;
      return handle;
    },
  });
  const postDeps: PostAnalysisDeps = { analyzer, getQuotes, notifier };

  if (replayIdx !== -1) {
    const source = argv[replayIdx + 1];
    if (!source) throw new Error('--replay 需要本地影片檔路徑或 YouTube 網址');
    await runReplay(
      source,
      { title: argValue(argv, '--title'), url: argValue(argv, '--url') },
      sessionDeps,
    );
    await notifier.stop();
    return;
  }

  if (agentMode) {
    await runAgent(config, sessionDeps);
    await notifier.stop();
    return;
  }

  console.log(`[main] 開始監測 ${config.youtubeChannelUrl}（每 ${config.pollIntervalSec}s 輪詢）`);
  const seen = new SeenStore(config.dataDir);
  await recoverOrphans(config, seen, postDeps);

  while (!shuttingDown) {
    try {
      await pollOnce(config, seen, notifier, vad, sessionDeps);
    } catch (err) {
      console.error('[main] 主迴圈錯誤：', err);
    }
    if (shuttingDown) break;
    await sleep(config.pollIntervalSec * 1000);
  }
  await notifier.stop();
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
    console.log(`[main] 重新接上進行中的直播：${videoId}`);
  }

  vad.reset();
  const meta: SessionMeta = { videoId, title, videoUrl };
  const result = await runLiveSession(
    meta,
    sessionDeps(videoId, (onPcm) => captureLive(config.youtubeChannelUrl, videoId, onPcm)),
  );
  activeCapture = null;
  if (result === 'completed') {
    seen.markSeen(`done:${videoId}`);
    console.log(`[main] 場次處理完成：${videoId}`);
  } else {
    console.log(`[main] 場次被中止（優雅關閉），重啟後將 reattach：${videoId}`);
  }
}

async function recoverOrphans(config: Config, seen: SeenStore, postDeps: PostAnalysisDeps): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(config.dataDir);
  } catch {
    return;
  }
  const orphanIds = files
    .map((f) => /^transcript-(.+)\.jsonl$/.exec(f)?.[1])
    .filter((id): id is string => !!id && !id.startsWith('replay-'))
    .filter((id) => seen.isSeen(id) && !seen.isSeen(`done:${id}`));
  if (orphanIds.length === 0) return;

  const status = await checkLive(config.youtubeChannelUrl);
  const liveId = status.state === 'live' ? status.videoId : null;

  for (const videoId of orphanIds) {
    if (videoId === liveId) continue;
    console.log(`[main] 回收孤兒場次（crash 後未發報告）：${videoId}`);
    const transcript = new TranscriptStore(config.dataDir, videoId);
    const durationSec = transcript.readAll().reduce((max, s) => Math.max(max, s.end), 0);
    try {
      await runPostAnalysis(
        {
          videoId,
          title: `白宮直播（${videoId}，程序中斷後恢復）`,
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        },
        postDeps,
        transcript,
        durationSec,
        ['（程序曾中斷，尾段可能缺漏）'],
      );
      seen.markSeen(`done:${videoId}`);
    } catch (err) {
      console.error(`[main] 孤兒場次 ${videoId} 回收失敗，下次啟動再試：`, err);
    }
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

async function buildNotifier(config: Config, noDiscord: boolean): Promise<NotifierLike> {
  if (noDiscord) return new ConsoleNotifier();
  if (config.subscriptionsUrl) {
    const channels = await fetchSubscribedChannels(config.subscriptionsUrl, config.subscriptionsSecret!);
    console.log(`[main] 多群組模式：${channels.length} 個訂閱頻道`);
    return new RestNotifier(config.discordBotToken, channels);
  }
  if (config.discordChannelId) {
    return new Notifier(config.discordBotToken, config.discordChannelId);
  }
  throw new Error(
    '需要 SUBSCRIPTIONS_URL + SUBSCRIPTIONS_SECRET（多群組模式）或 DISCORD_CHANNEL_ID（單頻道模式），或加 --no-discord',
  );
}

async function fetchSubscribedChannels(url: string, secret: string): Promise<string[]> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`訂閱清單取得失敗：${res.status} ${await res.text()}`);
  const subs = (await res.json()) as { channelId: string }[];
  return [...new Set(subs.map((s) => s.channelId))];
}

async function runReplay(
  source: string,
  meta: { title?: string; url?: string },
  sessionDeps: (videoId: string, startCapture: PipelineDeps['startCapture']) => PipelineDeps,
): Promise<void> {
  const videoId = `replay-${source.replace(/[^A-Za-z0-9_-]/g, '').slice(-20) || 'local'}`;
  console.log(`[replay] 來源：${source}（session：${videoId}）`);
  const input = await resolveReplaySource(source);
  await runLiveSession(
    { videoId, title: meta.title ?? `Replay：${source}`, videoUrl: meta.url ?? source },
    sessionDeps(videoId, (onPcm) => captureFile(input, onPcm)),
  );
}

async function runAgent(
  config: Config,
  sessionDeps: (videoId: string, startCapture: PipelineDeps['startCapture']) => PipelineDeps,
): Promise<void> {
  if (!config.subscriptionsUrl || !config.subscriptionsSecret) {
    throw new Error('--agent 需要 SUBSCRIPTIONS_URL + SUBSCRIPTIONS_SECRET');
  }
  const client = new WorkerAgentClient(config.subscriptionsUrl, config.subscriptionsSecret);
  const seen = new SeenStore(config.dataDir);
  console.log(`[agent] 啟動：每 ${config.pollIntervalSec}s 向 Worker 領取待辦場次`);

  const processStream = async (meta: SessionMeta): Promise<void> => {
    const input = await resolveReplaySource(meta.videoUrl);
    const result = await runLiveSession(
      meta,
      sessionDeps(meta.videoId, (onPcm) => captureFile(input, onPcm)),
    );
    if (result !== 'completed') throw new Error('session aborted');
  };

  while (!shuttingDown) {
    try {
      await runAgentPass({
        client,
        isDone: (id) => seen.isSeen(`done:${id}`),
        process: processStream,
        markDone: (id) => seen.markSeen(`done:${id}`),
      });
    } catch (err) {
      console.error('[agent] 領取待辦失敗：', err);
    }
    if (shuttingDown) break;
    await sleep(config.pollIntervalSec * 1000);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
