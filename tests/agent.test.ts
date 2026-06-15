import { describe, expect, it, vi } from 'vitest';
import { runAgentPass, type AgentClient } from '../src/agent.js';
import type { PendingItem } from '../src/types.js';

function fakeClient(pending: PendingItem[]): AgentClient & { doneCalls: string[] } {
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
      { kind: 'video', pendingId: 'video:aaa', videoId: 'aaa', title: 'Stream A', videoUrl: 'https://youtu.be/aaa' },
      { kind: 'video', pendingId: 'video:bbb', videoId: 'bbb', title: 'Stream B', videoUrl: 'https://youtu.be/bbb' },
    ]);
    const processed: PendingItem[] = [];
    const markedLocal: string[] = [];

    await runAgentPass({
      client,
      isDone: () => false,
      process: async (meta) => {
        processed.push(meta);
      },
      markDone: (id) => markedLocal.push(id),
    });

    expect(processed.map((m) => m.pendingId)).toEqual(['video:aaa', 'video:bbb']);
    expect(processed[0].kind).toBe('video');
    expect(markedLocal).toEqual(['video:aaa', 'video:bbb']);
    expect(client.doneCalls).toEqual(['video:aaa', 'video:bbb']);
  });

  it('skips already-done streams but still clears them from the queue', async () => {
    const client = fakeClient([
      { kind: 'video', pendingId: 'video:aaa', videoId: 'aaa', title: 'A', videoUrl: 'https://youtu.be/aaa' },
    ]);
    const process = vi.fn();

    await runAgentPass({
      client,
      isDone: () => true,
      process,
      markDone: () => {},
    });

    expect(process).not.toHaveBeenCalled();
    expect(client.doneCalls).toEqual(['video:aaa']);
  });

  it('leaves a stream queued when processing throws (retried next pass)', async () => {
    const client = fakeClient([
      { kind: 'video', pendingId: 'video:aaa', videoId: 'aaa', title: 'A', videoUrl: 'https://youtu.be/aaa' },
    ]);
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
      { kind: 'video', pendingId: 'video:aaa', videoId: 'aaa', title: 'A', videoUrl: 'https://youtu.be/aaa' },
      { kind: 'video', pendingId: 'video:bbb', videoId: 'bbb', title: 'B', videoUrl: 'https://youtu.be/bbb' },
    ]);

    await runAgentPass({
      client,
      isDone: () => false,
      process: async (item) => {
        if (item.pendingId === 'video:aaa') throw new Error('boom');
      },
      markDone: () => {},
    });

    expect(client.doneCalls).toEqual(['video:bbb']);
  });

  it('processes X posts through the same pending queue', async () => {
    const client = fakeClient([
      {
        kind: 'x-post',
        pendingId: 'x:123',
        postId: '123',
        username: 'realDonaldTrump',
        text: 'Tariffs are coming.',
        createdAt: '2026-06-12T00:00:00Z',
        url: 'https://x.com/realDonaldTrump/status/123',
      },
    ]);
    const processed: PendingItem[] = [];

    await runAgentPass({
      client,
      isDone: () => false,
      process: async (item) => {
        processed.push(item);
      },
      markDone: () => {},
    });

    expect(processed[0].kind).toBe('x-post');
    expect(client.doneCalls).toEqual(['x:123']);
  });
});
