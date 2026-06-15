import { describe, expect, it } from 'vitest';
import { workerRouteUrl } from '../src/worker-url.js';

describe('workerRouteUrl', () => {
  it('builds Worker routes from a base URL', () => {
    expect(workerRouteUrl('https://example.workers.dev', '/pending')).toBe('https://example.workers.dev/pending');
  });

  it('replaces an existing Worker route with the requested route', () => {
    expect(workerRouteUrl('https://example.workers.dev/subscriptions', '/pending')).toBe('https://example.workers.dev/pending');
  });
});
