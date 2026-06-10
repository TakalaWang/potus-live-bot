export interface Env {
  STATE: KVNamespace;
  YOUTUBE_API_KEY: string;
  DISCORD_WEBHOOK_URL: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  CHANNEL_ID: string;
}

interface LiveVideo {
  videoId: string;
  title: string;
}

export default {
  async fetch(): Promise<Response> {
    return new Response('potus-live-bot worker', { status: 200 });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env));
  },
};

async function tick(env: Env): Promise<void> {
  const activeRaw = await env.STATE.get('active');
  if (activeRaw) {
    const active = JSON.parse(activeRaw) as LiveVideo;
    if (await hasEnded(env, active.videoId)) {
      await dispatchReport(env, active);
      await env.STATE.delete('active');
    }
    return;
  }

  const live = await findLiveVideo(env);
  if (!live) return;
  if (await env.STATE.get(`seen:${live.videoId}`)) return;

  await env.STATE.put(`seen:${live.videoId}`, '1', { expirationTtl: 30 * 86400 });
  await env.STATE.put('active', JSON.stringify(live));
  await notifyLiveStart(env, live);
}

interface PlaylistItemsResponse {
  items?: { contentDetails: { videoId: string } }[];
}

interface VideosResponse {
  items?: {
    id: string;
    snippet?: { title: string; liveBroadcastContent: string };
    liveStreamingDetails?: { actualEndTime?: string };
  }[];
}

async function ytApi<T>(env: Env, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('key', env.YOUTUBE_API_KEY);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API ${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function recentVideoIds(env: Env): Promise<string[]> {
  const channelSuffix = env.CHANNEL_ID.slice(2);
  for (const playlistId of [`UULV${channelSuffix}`, `UU${channelSuffix}`]) {
    try {
      const data = await ytApi<PlaylistItemsResponse>(env, 'playlistItems', {
        part: 'contentDetails',
        playlistId,
        maxResults: '5',
      });
      const ids = (data.items ?? []).map((item) => item.contentDetails.videoId);
      if (ids.length > 0) return ids;
    } catch {
      continue;
    }
  }
  return [];
}

async function findLiveVideo(env: Env): Promise<LiveVideo | null> {
  const ids = await recentVideoIds(env);
  if (ids.length === 0) return null;
  const videos = await ytApi<VideosResponse>(env, 'videos', {
    part: 'snippet,liveStreamingDetails',
    id: ids.join(','),
  });
  for (const video of videos.items ?? []) {
    if (video.snippet?.liveBroadcastContent === 'live') {
      return { videoId: video.id, title: video.snippet.title };
    }
  }
  return null;
}

async function hasEnded(env: Env, videoId: string): Promise<boolean> {
  const data = await ytApi<VideosResponse>(env, 'videos', {
    part: 'liveStreamingDetails',
    id: videoId,
  });
  const video = data.items?.[0];
  if (!video) return true;
  return Boolean(video.liveStreamingDetails?.actualEndTime);
}

async function notifyLiveStart(env: Env, live: LiveVideo): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${live.videoId}`;
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      embeds: [
        {
          color: 0xed4245,
          title: `🔴 直播開始：${live.title}`.slice(0, 256),
          url,
          description: `白宮頻道正在直播，結束後將自動產生分析報告。\n${url}`,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${await res.text()}`);
}

async function dispatchReport(env: Env, live: LiveVideo): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'potus-live-bot-worker',
    },
    body: JSON.stringify({
      event_type: 'stream-ended',
      client_payload: { video_id: live.videoId, title: live.title },
    }),
  });
  if (!res.ok) throw new Error(`repository_dispatch ${res.status}: ${await res.text()}`);
}
