import { describe, expect, it, vi } from 'vitest';
import { runAgentPass, type AgentClient, type PendingStream } from '../src/agent.js';
import type { SessionMeta } from '../src/pipeline.js';

function fakeClient(pending: PendingStream[]): AgentClient & { doneCalls: string[] } {
  const doneCalls: string[] = [];
  return {
    doneCalls,
    listPending: async () => pending,
    markDone: async (videoId: string) => {
      doneCalls.push(videoId);
    },
  };
}

describe('runAgentPass', () => {
  it('processes each pending stream, marks done locally and on the worker', async () => {
    const client = fakeClient([
      { videoId: 'aaa', title: 'Stream A' },
      { videoId: 'bbb', title: 'Stream B' },
    ]);
    const processed: SessionMeta[] = [];
    const markedLocal: string[] = [];

    await runAgentPass({
      client,
      isDone: () => false,
      process: async (meta) => {
        processed.push(meta);
      },
      markDone: (id) => markedLocal.push(id),
    });

    expect(processed.map((m) => m.videoId)).toEqual(['aaa', 'bbb']);
    expect(processed[0].videoUrl).toBe('https://www.youtube.com/watch?v=aaa');
    expect(markedLocal).toEqual(['aaa', 'bbb']);
    expect(client.doneCalls).toEqual(['aaa', 'bbb']);
  });

  it('skips already-done streams but still clears them from the queue', async () => {
    const client = fakeClient([{ videoId: 'aaa', title: 'A' }]);
    const process = vi.fn();

    await runAgentPass({
      client,
      isDone: () => true,
      process,
      markDone: () => {},
    });

    expect(process).not.toHaveBeenCalled();
    expect(client.doneCalls).toEqual(['aaa']);
  });

  it('leaves a stream queued when processing throws (retried next pass)', async () => {
    const client = fakeClient([{ videoId: 'aaa', title: 'A' }]);
    const markedLocal: string[] = [];

    await runAgentPass({
      client,
      isDone: () => false,
      process: async () => {
        throw new Error('yt-dlp failed');
      },
      markDone: (id) => markedLocal.push(id),
    });

    expect(markedLocal).toEqual([]);
    expect(client.doneCalls).toEqual([]);
  });

  it('one stream failing does not block the others', async () => {
    const client = fakeClient([
      { videoId: 'aaa', title: 'A' },
      { videoId: 'bbb', title: 'B' },
    ]);

    await runAgentPass({
      client,
      isDone: () => false,
      process: async (meta) => {
        if (meta.videoId === 'aaa') throw new Error('boom');
      },
      markDone: () => {},
    });

    expect(client.doneCalls).toEqual(['bbb']);
  });
});
