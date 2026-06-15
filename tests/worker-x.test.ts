import { describe, expect, it } from 'vitest';
import { parseXUsernames } from '../worker/src/index.js';

describe('parseXUsernames', () => {
  it('defaults to the tracked official accounts', () => {
    expect(parseXUsernames(undefined)).toEqual(['realDonaldTrump', 'WhiteHouse', 'POTUS']);
  });

  it('normalizes @ prefixes and de-duplicates case-insensitively', () => {
    expect(parseXUsernames('@realDonaldTrump, WhiteHouse, @POTUS, whitehouse')).toEqual([
      'realDonaldTrump',
      'WhiteHouse',
      'POTUS',
    ]);
  });

  it('rejects invalid usernames instead of silently skipping them', () => {
    expect(() => parseXUsernames('realDonaldTrump, bad account')).toThrow(/invalid X username/);
  });
});
