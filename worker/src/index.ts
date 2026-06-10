export interface Env {
  STATE: KVNamespace;
  YOUTUBE_API_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  SUBSCRIPTIONS_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  CHANNEL_ID: string;
}

interface LiveVideo {
  videoId: string;
  title: string;
}

interface Subscription {
  guildId: string;
  channelId: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/interactions') {
      return handleInteraction(req, env);
    }
    if (req.method === 'GET' && url.pathname === '/subscriptions') {
      if (req.headers.get('authorization') !== `Bearer ${env.SUBSCRIPTIONS_SECRET}`) {
        return new Response('unauthorized', { status: 401 });
      }
      return Response.json(await listSubscriptions(env));
    }
    if (req.method === 'GET' && url.pathname === '/debug') {
      if (req.headers.get('authorization') !== `Bearer ${env.SUBSCRIPTIONS_SECRET}`) {
        return new Response('unauthorized', { status: 401 });
      }
      try {
        return Response.json({ live: await findLiveVideo(env) });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }
    return new Response('potus-live-bot worker', { status: 200 });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      tick(env).catch((err) => {
        console.error('tick failed:', err instanceof Error ? err.message : String(err));
      }),
    );
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

async function handleInteraction(req: Request, env: Env): Promise<Response> {
  const signature = req.headers.get('x-signature-ed25519');
  const timestamp = req.headers.get('x-signature-timestamp');
  const body = await req.text();
  if (!signature || !timestamp || !(await verifySignature(env, signature, timestamp, body))) {
    return new Response('invalid signature', { status: 401 });
  }

  const interaction = JSON.parse(body) as {
    type: number;
    guild_id?: string;
    channel_id?: string;
    data?: { name?: string; options?: { name: string; value: string }[] };
  };

  if (interaction.type === 1) {
    return Response.json({ type: 1 });
  }

  if (interaction.type === 2) {
    const name = interaction.data?.name;
    const guildId = interaction.guild_id;
    if (!guildId) {
      return ephemeral('這個指令只能在伺服器中使用。');
    }
    if (name === 'subscribe') {
      const channelId =
        interaction.data?.options?.find((o) => o.name === 'channel')?.value ?? interaction.channel_id;
      if (!channelId) {
        return ephemeral('請用 channel 參數指定要接收通知的頻道。');
      }
      await env.STATE.put(`sub:${guildId}`, JSON.stringify({ channelId }));
      return ephemeral(
        `✅ 已訂閱！白宮開直播時會在 <#${channelId}> 通知，直播結束後送出分析報告。\n` +
          '請確認機器人在該頻道有「檢視頻道」「發送訊息」「嵌入連結」「附加檔案」權限。\n用 /unsubscribe 可取消。',
      );
    }
    if (name === 'unsubscribe') {
      await env.STATE.delete(`sub:${guildId}`);
      return ephemeral('已取消訂閱，本伺服器不會再收到通知。');
    }
  }

  return new Response('unhandled interaction', { status: 400 });
}

function ephemeral(content: string): Response {
  return Response.json({ type: 4, data: { content, flags: 64 } });
}

async function verifySignature(env: Env, signature: string, timestamp: string, body: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(env.DISCORD_PUBLIC_KEY),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function listSubscriptions(env: Env): Promise<Subscription[]> {
  const subs: Subscription[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE.list({ prefix: 'sub:', cursor });
    for (const key of page.keys) {
      const raw = await env.STATE.get(key.name);
      if (!raw) continue;
      const { channelId } = JSON.parse(raw) as { channelId: string };
      subs.push({ guildId: key.name.slice(4), channelId });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subs;
}

async function notifyLiveStart(env: Env, live: LiveVideo): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${live.videoId}`;
  const payload = {
    embeds: [
      {
        color: 0xed4245,
        title: `🔴 直播開始：${live.title}`.slice(0, 256),
        url,
        description: `白宮頻道正在直播，結束後將自動送出分析報告。\n${url}`,
        timestamp: new Date().toISOString(),
      },
    ],
  };
  for (const sub of await listSubscriptions(env)) {
    await sendToChannel(env, sub, payload);
  }
}

async function sendToChannel(env: Env, sub: Subscription, payload: unknown): Promise<void> {
  const res = await fetch(`https://discord.com/api/v10/channels/${sub.channelId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 403 || res.status === 404) {
    await env.STATE.delete(`sub:${sub.guildId}`);
    return;
  }
  if (res.status === 429) {
    const retryAfter = Number((await res.json<{ retry_after?: number }>()).retry_after ?? 1);
    await new Promise((r) => setTimeout(r, retryAfter * 1000 + 100));
    await sendToChannel(env, sub, payload);
  }
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
    } catch (err) {
      console.warn(`playlist ${playlistId}: ${err instanceof Error ? err.message : String(err)}`);
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
