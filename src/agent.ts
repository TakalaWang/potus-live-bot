import type { PendingItem } from './types.js';
import { workerRouteUrl } from './worker-url.js';

export interface AgentClient {
  listPending(): Promise<PendingItem[]>;
  markDone(pendingId: string): Promise<void>;
}

/** Talks to the Worker's /pending and /pending/done endpoints. */
export class WorkerAgentClient implements AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async listPending(): Promise<PendingItem[]> {
    const res = await fetch(workerRouteUrl(this.baseUrl, '/pending'), {
      headers: { authorization: `Bearer ${this.secret}` },
    });
    if (!res.ok) throw new Error(`/pending ${res.status}: ${await res.text()}`);
    return (await res.json()) as PendingItem[];
  }

  async markDone(pendingId: string): Promise<void> {
    const res = await fetch(workerRouteUrl(this.baseUrl, '/pending/done'), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pendingId }),
    });
    if (!res.ok) throw new Error(`/pending/done ${res.status}: ${await res.text()}`);
  }
}

export interface AgentDeps {
  client: AgentClient;
  isDone: (pendingId: string) => boolean;
  process: (item: PendingItem) => Promise<void>;
  markDone: (pendingId: string) => void;
}

/**
 * One polling pass: fetch pending streams, process any not already done
 * (download VOD on this machine's residential IP, run the pipeline, fan out
 * the report), then tell the Worker to drop it from the queue.
 */
export async function runAgentPass(deps: AgentDeps): Promise<void> {
  const pending = await deps.client.listPending();
  for (const item of pending) {
    if (deps.isDone(item.pendingId)) {
      await deps.client.markDone(item.pendingId);
      continue;
    }
    console.log(`[agent] 處理待辦項目：${item.pendingId} ${pendingTitle(item)}`);
    try {
      await deps.process(item);
      deps.markDone(item.pendingId);
      await deps.client.markDone(item.pendingId);
      console.log(`[agent] 完成並回報：${item.pendingId}`);
    } catch (err) {
      // leave it queued; next pass retries (e.g. transient YouTube/network failure)
      console.error(`[agent] 待辦項目 ${item.pendingId} 處理失敗，保留待辦下次重試：`, err);
    }
  }
}

function pendingTitle(item: PendingItem): string {
  if (item.kind === 'video') return item.title;
  return `@${item.username}: ${item.text.slice(0, 80)}`;
}
