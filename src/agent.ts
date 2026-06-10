import type { SessionMeta } from './pipeline.js';

export interface PendingStream {
  videoId: string;
  title: string;
}

export interface AgentClient {
  listPending(): Promise<PendingStream[]>;
  markDone(videoId: string): Promise<void>;
}

/** Talks to the Worker's /pending and /pending/done endpoints. */
export class WorkerAgentClient implements AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async listPending(): Promise<PendingStream[]> {
    const res = await fetch(new URL('/pending', this.baseUrl), {
      headers: { authorization: `Bearer ${this.secret}` },
    });
    if (!res.ok) throw new Error(`/pending ${res.status}: ${await res.text()}`);
    return (await res.json()) as PendingStream[];
  }

  async markDone(videoId: string): Promise<void> {
    const res = await fetch(new URL('/pending/done', this.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ videoId }),
    });
    if (!res.ok) throw new Error(`/pending/done ${res.status}: ${await res.text()}`);
  }
}

export interface AgentDeps {
  client: AgentClient;
  isDone: (videoId: string) => boolean;
  process: (meta: SessionMeta) => Promise<void>;
  markDone: (videoId: string) => void;
}

/**
 * One polling pass: fetch pending streams, process any not already done
 * (download VOD on this machine's residential IP, run the pipeline, fan out
 * the report), then tell the Worker to drop it from the queue.
 */
export async function runAgentPass(deps: AgentDeps): Promise<void> {
  const pending = await deps.client.listPending();
  for (const stream of pending) {
    if (deps.isDone(stream.videoId)) {
      await deps.client.markDone(stream.videoId);
      continue;
    }
    const videoUrl = `https://www.youtube.com/watch?v=${stream.videoId}`;
    console.log(`[agent] 處理待辦場次：${stream.videoId} ${stream.title}`);
    try {
      await deps.process({ videoId: stream.videoId, title: stream.title, videoUrl });
      deps.markDone(stream.videoId);
      await deps.client.markDone(stream.videoId);
      console.log(`[agent] 完成並回報：${stream.videoId}`);
    } catch (err) {
      // leave it queued; next pass retries (e.g. transient YouTube/network failure)
      console.error(`[agent] 場次 ${stream.videoId} 處理失敗，保留待辦下次重試：`, err);
    }
  }
}
