import { describe, expect, it } from 'vitest';
import { buildReport, DISCLAIMER, embedTotalLength } from '../src/report.js';
import type { AnalysisResult, StockQuote } from '../src/types.js';

const ANALYSIS: AnalysisResult = {
  summaryZh: '川普宣布對進口晶片課徵新關稅，並批評聯準會利率政策。',
  keyPoints: ['宣布晶片關稅 25%', '施壓聯準會降息', '提及能源政策鬆綁'],
  stockPicks: [
    { ticker: 'NVDA', direction: 'bearish', reason: '晶片關稅推高成本', confidence: 'high' },
    { ticker: 'XOM', direction: 'bullish', reason: '能源鬆綁利多', confidence: 'medium' },
  ],
};

const QUOTES: StockQuote[] = [
  { symbol: 'NVDA', name: 'NVIDIA Corporation', price: 1250.5, changePercent: -2.34, currency: 'USD', marketState: 'REGULAR' },
  { symbol: 'XOM', name: 'Exxon Mobil', price: 118.2, changePercent: 1.05, currency: 'USD', marketState: 'REGULAR' },
];

const META = {
  title: 'President Trump Delivers Remarks',
  videoUrl: 'https://www.youtube.com/watch?v=abc123',
  durationSec: 3725,
  failedRanges: [] as string[],
};

describe('buildReport', () => {
  it('組出摘要與股票兩個 embed，含現價與漲跌幅', () => {
    const embeds = buildReport(ANALYSIS, QUOTES, META);
    expect(embeds).toHaveLength(2);

    const summary = embeds[0];
    expect(summary.data.title).toContain('President Trump');
    expect(summary.data.url).toBe(META.videoUrl);
    expect(summary.data.description).toContain('晶片');
    const fieldText = JSON.stringify(summary.data.fields);
    expect(fieldText).toContain('1:02:05');

    const stocks = embeds[1];
    const stockText = JSON.stringify(stocks.data.fields);
    expect(stockText).toContain('NVDA');
    expect(stockText).toContain('1250.5');
    expect(stockText).toContain('-2.34');
    expect(stockText).toContain('📉');
    expect(stockText).toContain('📈');
    expect(stockText).toContain('晶片關稅推高成本');
  });

  it('免責聲明一定存在', () => {
    const embeds = buildReport(ANALYSIS, QUOTES, META);
    const last = embeds[embeds.length - 1];
    expect(last.data.footer?.text).toBe(DISCLAIMER);
  });

  it('查無行情的 ticker 顯示行情查詢失敗', () => {
    const embeds = buildReport(ANALYSIS, [QUOTES[0]], META);
    const stockText = JSON.stringify(embeds[1].data.fields);
    expect(stockText).toContain('行情查詢失敗');
  });

  it('轉錄缺漏範圍會列出', () => {
    const embeds = buildReport(ANALYSIS, QUOTES, { ...META, failedRanges: ['12:03–12:48', '40:00–40:45'] });
    const text = JSON.stringify(embeds[0].data.fields);
    expect(text).toContain('12:03');
    expect(text).toContain('40:00');
  });

  it('無股票建議時只有摘要 embed，免責聲明仍在', () => {
    const embeds = buildReport({ ...ANALYSIS, stockPicks: [] }, [], META);
    expect(embeds).toHaveLength(1);
    expect(embeds[0].data.footer?.text).toBe(DISCLAIMER);
  });

  it('超長內容被截斷到 Discord 限制內', () => {
    const longAnalysis: AnalysisResult = {
      summaryZh: '長'.repeat(5000),
      keyPoints: Array.from({ length: 40 }, (_, i) => `重點 ${i} ` + 'x'.repeat(200)),
      stockPicks: Array.from({ length: 40 }, (_, i) => ({
        ticker: `TICK${i}`,
        direction: 'bullish' as const,
        reason: '理由 '.repeat(300),
        confidence: 'low' as const,
      })),
    };
    const embeds = buildReport(longAnalysis, [], META);

    let total = 0;
    for (const e of embeds) {
      expect(e.data.description?.length ?? 0).toBeLessThanOrEqual(4096);
      expect(e.data.fields?.length ?? 0).toBeLessThanOrEqual(25);
      for (const f of e.data.fields ?? []) {
        expect(f.name.length).toBeLessThanOrEqual(256);
        expect(f.value.length).toBeLessThanOrEqual(1024);
      }
      total += embedTotalLength(e);
    }
    expect(total).toBeLessThanOrEqual(6000);
  });
});
