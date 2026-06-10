import YahooFinance from 'yahoo-finance2';
import type { Quote } from 'yahoo-finance2/modules/quote';
import type { StockQuote } from '../types.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export async function getQuotes(symbols: string[]): Promise<StockQuote[]> {
  const requested = [...new Set(symbols.map((s) => s.trim().toUpperCase()))];
  if (requested.length === 0) return [];

  let quoteMap: Map<string, Quote>;
  try {
    quoteMap = await yahooFinance.quote(requested, { return: 'map' });
  } catch (err) {
    console.warn(`[quotes] 批次查詢失敗（${(err as Error).message}），改逐檔查詢`);
    quoteMap = new Map();
    for (const symbol of requested) {
      try {
        const q = (await yahooFinance.quote(symbol)) as Quote | undefined;
        if (q) quoteMap.set(q.symbol, q);
      } catch (innerErr) {
        console.warn(`[quotes] 略過 ${symbol}：${(innerErr as Error).message}`);
      }
    }
  }

  const results: StockQuote[] = [];
  for (const symbol of requested) {
    const q = quoteMap.get(symbol) ?? quoteMap.get(symbol.replace('.', '-'));
    if (!q || q.regularMarketPrice === undefined) {
      console.warn(`[quotes] ${symbol} 查無行情（無效 ticker？）`);
      continue;
    }
    results.push({
      symbol,
      name: q.longName ?? q.shortName ?? q.symbol,
      price: q.regularMarketPrice,
      changePercent: q.regularMarketChangePercent ?? 0,
      currency: q.currency ?? 'USD',
      marketState: q.marketState,
    });
  }
  return results;
}
