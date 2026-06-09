import YahooFinance from 'yahoo-finance2';
import type { Quote } from 'yahoo-finance2/modules/quote';
import type { StockQuote } from '../types.js';

// v3：default export 是 class，要實例化（v2 的 singleton 用法已不適用）
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

/**
 * 批次查報價（單一 HTTP request）。
 * 無效 ticker 不會丟錯，只是默默缺席——呼叫端用回傳結果 diff 輸入即可得知。
 */
export async function getQuotes(symbols: string[]): Promise<StockQuote[]> {
  if (symbols.length === 0) return [];

  let quoteMap: Map<string, Quote>;
  try {
    quoteMap = await yahooFinance.quote(symbols, { return: 'map' });
  } catch (err) {
    // 整批失敗（網路、429、Yahoo schema 變更）→ 退回逐檔查詢，單檔失敗不拖累全部
    console.warn(`[quotes] 批次查詢失敗（${(err as Error).message}），改逐檔查詢`);
    quoteMap = new Map();
    for (const symbol of symbols) {
      try {
        const q = (await yahooFinance.quote(symbol)) as Quote | undefined;
        if (q) quoteMap.set(symbol, q);
      } catch (innerErr) {
        console.warn(`[quotes] 略過 ${symbol}：${(innerErr as Error).message}`);
      }
    }
  }

  const results: StockQuote[] = [];
  for (const symbol of symbols) {
    const q = quoteMap.get(symbol);
    if (!q || q.regularMarketPrice === undefined) {
      console.warn(`[quotes] ${symbol} 查無行情（無效 ticker？）`);
      continue;
    }
    results.push({
      symbol: q.symbol,
      name: q.longName ?? q.shortName ?? q.symbol,
      price: q.regularMarketPrice,
      changePercent: q.regularMarketChangePercent ?? 0,
      currency: q.currency ?? 'USD',
      marketState: q.marketState,
    });
  }
  return results;
}
