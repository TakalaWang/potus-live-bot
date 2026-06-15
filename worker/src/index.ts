export interface Env {
  STATE: KVNamespace;
  YOUTUBE_API_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  SUBSCRIPTIONS_SECRET: string;
  CHANNEL_ID: string;
  X_BEARER_TOKEN?: string;
  X_USERNAMES?: string;
}

interface LiveVideo {
  videoId: string;
  title: string;
}

interface PendingVideo extends LiveVideo {
  kind: 'video';
  pendingId: string;
  videoUrl: string;
}

interface PendingXPost {
  kind: 'x-post';
  pendingId: string;
  postId: string;
  username: string;
  text: string;
  createdAt: string;
  url: string;
}

type PendingItem = PendingVideo | PendingXPost;

const PENDING_PREFIX = 'pending:';
const DEFAULT_X_USERNAMES = ['realDonaldTrump', 'WhiteHouse', 'POTUS'] as const;

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
    const route = await handleAuthedRoute(req, url, env);
    if (route) return route;
    return new Response('president-signal-bot worker', { status: 200 });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      tick(env).catch((err) => {
        console.error('tick failed:', err instanceof Error ? err.message : String(err));
      }),
    );
  },
};

type RouteHandler = (req: Request, env: Env) => Promise<Response>;

const AUTHED_ROUTES: readonly { method: string; path: string; handler: RouteHandler }[] = [
  { method: 'GET', path: '/subscriptions', handler: handleSubscriptions },
  { method: 'GET', path: '/pending', handler: handlePendingList },
  { method: 'POST', path: '/pending/done', handler: handlePendingDone },
  { method: 'POST', path: '/pending', handler: handlePendingCreate },
  { method: 'GET', path: '/debug-tick', handler: handleDebugTick },
  { method: 'GET', path: '/debug', handler: handleDebug },
];

async function handleAuthedRoute(req: Request, url: URL, env: Env): Promise<Response | null> {
  const route = AUTHED_ROUTES.find((r) => r.method === req.method && r.path === url.pathname);
  if (!route) return null;
  if (req.headers.get('authorization') !== `Bearer ${env.SUBSCRIPTIONS_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  return route.handler(req, env);
}

async function handleSubscriptions(_req: Request, env: Env): Promise<Response> {
  return Response.json(await listSubscriptions(env));
}

async function handlePendingList(_req: Request, env: Env): Promise<Response> {
  return Response.json(await listPending(env));
}

async function handlePendingDone(req: Request, env: Env): Promise<Response> {
  const { pendingId } = (await req.json()) as { pendingId?: string };
  if (!pendingId) return new Response('pendingId required', { status: 400 });
  await env.STATE.delete(`${PENDING_PREFIX}${pendingId}`);
  return Response.json({ ok: true });
}

async function handlePendingCreate(req: Request, env: Env): Promise<Response> {
  const { videoId, title } = (await req.json()) as { videoId?: string; title?: string };
  if (!videoId) return new Response('videoId required', { status: 400 });
  await putPending(env, pendingVideo({ videoId, title: title ?? videoId }));
  return Response.json({ ok: true });
}

async function handleDebugTick(_req: Request, env: Env): Promise<Response> {
  try {
    await tick(env);
    const keys = await env.STATE.list({ prefix: '' });
    return Response.json({ ok: true, kvKeys: keys.keys.map((k) => k.name) });
  } catch (err) {
    return errorResponse(err);
  }
}

async function handleDebug(_req: Request, env: Env): Promise<Response> {
  try {
    return Response.json({ live: await findLiveVideo(env) });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown): Response {
  return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
}

async function tick(env: Env): Promise<void> {
  const errors: string[] = [];
  for (const [name, fn] of [
    ['youtube', () => tickYoutube(env)],
    ['x', () => tickX(env)],
  ] as const) {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${name} tick failed: ${message}`);
      errors.push(`${name}: ${message}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
}

async function tickYoutube(env: Env): Promise<void> {
  const activeRaw = await env.STATE.get('active');
  if (activeRaw) {
    const active = JSON.parse(activeRaw) as LiveVideo;
    if (await hasEnded(env, active.videoId)) {
      console.log(`stream ended, queued for the home agent: ${active.videoId}`);
      await putPending(env, pendingVideo(active));
      await env.STATE.delete('active');
    }
    return;
  }

  const live = await findLiveVideo(env);
  if (!live) return;
  if (await env.STATE.get(`seen:${live.videoId}`)) return;

  console.log(`live detected: ${live.videoId} ${live.title}`);
  await env.STATE.put(`seen:${live.videoId}`, '1', { expirationTtl: 30 * 86400 });
  await env.STATE.put('active', JSON.stringify(live));
  await notifyLiveStart(env, live);
}

async function tickX(env: Env): Promise<void> {
  if (!env.X_BEARER_TOKEN) return;

  for (const username of xUsernames(env)) {
    await tickXUser(env, username);
  }
}

async function tickXUser(env: Env, username: string): Promise<void> {
  const userId = await xUserId(env, username);
  const seenKey = `x:last:${username.toLowerCase()}`;
  const sinceId = await env.STATE.get(seenKey);
  const posts = await xUserPosts(env, userId, sinceId ?? undefined);
  if (posts.length === 0) return;

  const ordered = posts.slice().reverse();
  const postsToQueue = sinceId ? ordered : ordered.slice(-1);
  for (const post of postsToQueue) {
    await putPending(env, pendingXPost(username, post));
  }
  await env.STATE.put(seenKey, posts[0].id);
}

function xUsernames(env: Env): string[] {
  return parseXUsernames(env.X_USERNAMES);
}

export function parseXUsernames(rawConfig: string | undefined): string[] {
  const raw = rawConfig?.trim();
  const usernames = raw ? raw.split(',') : [...DEFAULT_X_USERNAMES];
  const seen = new Set<string>();
  return usernames.flatMap((username) => {
    const normalized = normalizeXUsername(username);
    const key = normalized.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

function normalizeXUsername(username: string): string {
  const normalized = username.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(normalized)) {
    throw new Error(`invalid X username: ${username}`);
  }
  return normalized;
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
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
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
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`YouTube API ${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface XUserLookupResponse {
  data?: { id: string; username: string };
}

interface XPostsResponse {
  data?: XPost[];
}

interface XPost {
  id: string;
  text: string;
  created_at: string;
}

async function xApi<T>(env: Env, path: string, params: Record<string, string> = {}): Promise<T> {
  if (!env.X_BEARER_TOKEN) throw new Error('X_BEARER_TOKEN is not configured');
  const url = new URL(`https://api.x.com/2/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`X API ${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function xUserId(env: Env, username: string): Promise<string> {
  const cacheKey = `x:user:${username.toLowerCase()}`;
  const cached = await env.STATE.get(cacheKey);
  if (cached) return cached;

  const data = await xApi<XUserLookupResponse>(env, `users/by/username/${encodeURIComponent(username)}`);
  if (!data.data?.id) throw new Error(`X user not found: ${username}`);
  await env.STATE.put(cacheKey, data.data.id, { expirationTtl: 30 * 86400 });
  return data.data.id;
}

async function xUserPosts(env: Env, userId: string, sinceId?: string): Promise<XPost[]> {
  const params: Record<string, string> = {
    max_results: '5',
    exclude: 'retweets,replies',
    'tweet.fields': 'created_at',
  };
  if (sinceId) params.since_id = sinceId;
  const data = await xApi<XPostsResponse>(env, `users/${userId}/tweets`, params);
  return data.data ?? [];
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

async function listPending(env: Env): Promise<PendingItem[]> {
  const pending: PendingItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE.list({ prefix: PENDING_PREFIX, cursor });
    for (const key of page.keys) {
      const raw = await env.STATE.get(key.name);
      if (raw) pending.push(JSON.parse(raw) as PendingItem);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return pending;
}

function pendingVideo(video: LiveVideo): PendingVideo {
  return {
    kind: 'video',
    pendingId: `video:${video.videoId}`,
    videoId: video.videoId,
    title: video.title,
    videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
  };
}

function pendingXPost(username: string, post: XPost): PendingXPost {
  return {
    kind: 'x-post',
    pendingId: `x:${post.id}`,
    postId: post.id,
    username,
    text: post.text,
    createdAt: post.created_at,
    url: `https://x.com/${username}/status/${post.id}`,
  };
}

async function putPending(env: Env, item: PendingItem): Promise<void> {
  await env.STATE.put(`${PENDING_PREFIX}${item.pendingId}`, JSON.stringify(item), {
    expirationTtl: 14 * 86400,
  });
}
