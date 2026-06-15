import { describe, expect, it } from 'vitest';
import { buildReport, buildSocialReport, DISCLAIMER, embedTotalLength } from '../src/report.js';
import type { AnalysisResult, StockQuote } from '../src/types.js';

const ANALYSIS: AnalysisResult = {
  summaryZh: '川普宣布對進口晶片課徵新關稅，並批評聯準會利率政策。',
  keyPoints: ['宣布晶片關稅 25%', '施壓聯準會降息', '提及能源政策鬆綁'],
  marketImpacts: [
    {
      theme: '半導體製造',
      direction: 'bearish',
      quote: 'a twenty five percent tariff on all imported semiconductors',
      reason: '對進口晶片課徵 25% 關稅，推升依賴海外製造的晶片業者成本',
      exampleTickers: ['SOXX', 'SMH'],
      confidence: 'high',
    },
    {
      theme: '傳統能源',
      direction: 'bullish',
      quote: 'we will approve new drilling permits immediately',
      reason: '立即核發鑽探許可，利多油氣探勘與生產類股',
      exampleTickers: ['XLE'],
      confidence: 'medium',
    },
  ],
};

const QUOTES: StockQuote[] = [
  { symbol: 'SOXX', name: 'iShares Semiconductor ETF', price: 245.5, changePercent: -2.34, currency: 'USD', marketState: 'REGULAR' },
  { symbol: 'SMH', name: 'VanEck Semiconductor ETF', price: 312.8, changePercent: -1.9, currency: 'USD', marketState: 'REGULAR' },
  { symbol: 'XLE', name: 'Energy Select Sector SPDR', price: 89.2, changePercent: 1.05, currency: 'USD', marketState: 'REGULAR' },
];

const META = {
  title: 'President Trump Delivers Remarks',
  videoUrl: 'https://www.youtube.com/watch?v=abc123',
  durationSec: 3725,
  failedRanges: [] as string[],
};

describe('buildReport', () => {
  it('組出摘要與市場觀察兩個 embed，含領域、原文引用、相關類股行情', () => {
    const embeds = buildReport(ANALYSIS, QUOTES, META);
    expect(embeds).toHaveLength(2);

    const summary = embeds[0];
    expect(summary.data.title).toContain('President Trump');
    expect(summary.data.url).toBe(META.videoUrl);
    expect(summary.data.description).toContain('晶片');
    const fieldText = JSON.stringify(summary.data.fields);
    expect(fieldText).toContain('1:02:05');

    const market = embeds[1];
    const text = JSON.stringify(market.data.fields);
    // 領域而非單一個股
    expect(text).toContain('半導體製造');
    expect(text).toContain('傳統能源');
    // 強制引用逐字稿原文
    expect(text).toContain('twenty five percent tariff');
    // 方向 emoji
    expect(text).toContain('📉');
    expect(text).toContain('📈');
    // 相關類股/ETF 與行情
    expect(text).toContain('SOXX');
    expect(text).toContain('245.5');
    expect(text).toContain('-2.34');
    expect(text).toContain('XLE');
    expect(text).toContain('油氣探勘');
  });

  it('免責聲明一定存在', () => {
    const embeds = buildReport(ANALYSIS, QUOTES, META);
    const last = embeds.at(-1)!;
    expect(last.data.footer?.text).toBe(DISCLAIMER);
  });

  it('查無行情的類股顯示行情查詢失敗', () => {
    const embeds = buildReport(ANALYSIS, [QUOTES[0]], META); // 只有 SOXX 有行情
    const text = JSON.stringify(embeds[1].data.fields);
    expect(text).toContain('行情查詢失敗');
  });

  it('轉錄缺漏範圍會列出', () => {
    const embeds = buildReport(ANALYSIS, QUOTES, { ...META, failedRanges: ['12:03–12:48', '40:00–40:45'] });
    const text = JSON.stringify(embeds[0].data.fields);
    expect(text).toContain('12:03');
    expect(text).toContain('40:00');
  });

  it('無市場影響時只有摘要 embed，免責聲明仍在', () => {
    const embeds = buildReport({ ...ANALYSIS, marketImpacts: [] }, [], META);
    expect(embeds).toHaveLength(1);
    expect(embeds[0].data.footer?.text).toBe(DISCLAIMER);
  });

  it('超長內容被截斷到 Discord 限制內', () => {
    const longAnalysis: AnalysisResult = {
      summaryZh: '長'.repeat(5000),
      keyPoints: Array.from({ length: 40 }, (_, i) => `重點 ${i} ` + 'x'.repeat(200)),
      marketImpacts: Array.from({ length: 40 }, (_, i) => ({
        theme: `領域 ${i} ` + 'x'.repeat(100),
        direction: 'bullish' as const,
        quote: 'q'.repeat(300),
        reason: '理由 '.repeat(300),
        exampleTickers: ['AAA', 'BBB', 'CCC'],
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

describe('buildSocialReport', () => {
  it('組出 X 發文摘要、市場觀察、原文與免責聲明', () => {
    const embeds = buildSocialReport(ANALYSIS, QUOTES, {
      username: 'realDonaldTrump',
      postUrl: 'https://x.com/realDonaldTrump/status/123',
      text: 'a twenty five percent tariff on all imported semiconductors',
      createdAt: '2026-06-12T00:00:00Z',
    });

    expect(embeds).toHaveLength(2);
    expect(embeds[0].data.title).toContain('@realDonaldTrump');
    expect(embeds[0].data.url).toBe('https://x.com/realDonaldTrump/status/123');
    expect(JSON.stringify(embeds[0].data.fields)).toContain('原文');
    expect(JSON.stringify(embeds[0].data.fields)).toContain('imported semiconductors');
    expect(embeds[1].data.title).toContain('投資留意方向');
    expect(JSON.stringify(embeds[1].data.fields)).toContain('SOXX');
    expect(embeds.at(-1)!.data.footer?.text).toBe(DISCLAIMER);
  });
});
