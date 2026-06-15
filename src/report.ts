import { EmbedBuilder } from 'discord.js';
import type { AnalysisResult, MarketImpact, StockQuote } from './types.js';

export const DISCLAIMER = '本報告由 AI 自動生成，僅供參考，不構成投資建議；投資有風險，請自行判斷。';

export interface ReportMeta {
  title: string;
  videoUrl: string;
  durationSec: number;
  failedRanges: string[];
}

export interface SocialReportMeta {
  username: string;
  postUrl: string;
  text: string;
  createdAt: string;
}

const FIELD_VALUE_LIMIT = 1024;
const FIELD_NAME_LIMIT = 256;
const TITLE_LIMIT = 256;
const DESC_LIMIT = 4096;
const MAX_FIELDS = 25;
const TOTAL_LIMIT = 6000;

export function embedTotalLength(embed: EmbedBuilder): number {
  return embed.length;
}

export function buildReport(
  analysis: AnalysisResult,
  quotes: StockQuote[],
  meta: ReportMeta,
): EmbedBuilder[] {
  const summary = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(truncate(`📊 直播分析報告：${meta.title}`, TITLE_LIMIT))
    .setDescription(truncate(analysis.summaryZh || '（無摘要）', DESC_LIMIT))
    .setTimestamp();

  if (/^https?:\/\//.test(meta.videoUrl)) summary.setURL(meta.videoUrl);

  const summaryFields = [{ name: '⏱️ 直播長度', value: formatDuration(meta.durationSec), inline: true }];
  for (const chunk of chunkLines(analysis.keyPoints.map((p) => `• ${p}`))) {
    summaryFields.push({ name: '🔑 重點', value: chunk, inline: false });
  }
  if (meta.failedRanges.length > 0) {
    summaryFields.push({
      name: '⚠️ 轉錄缺漏',
      value: truncate(meta.failedRanges.join('、'), FIELD_VALUE_LIMIT),
      inline: false,
    });
  }
  summary.addFields(summaryFields.slice(0, MAX_FIELDS));

  const embeds = [summary];
  addMarketEmbed(embeds, analysis.marketImpacts, quotes, '💹 市場觀察｜受影響領域與方向（非個股推薦）');
  return finalizeEmbeds(embeds);
}

export function buildSocialReport(
  analysis: AnalysisResult,
  quotes: StockQuote[],
  meta: SocialReportMeta,
): EmbedBuilder[] {
  const summary = new EmbedBuilder()
    .setColor(0x1d9bf0)
    .setTitle(truncate(`📣 X 發文分析：@${meta.username}`, TITLE_LIMIT))
    .setDescription(truncate(analysis.summaryZh || '（無摘要）', DESC_LIMIT))
    .setTimestamp(new Date(meta.createdAt));

  if (/^https?:\/\//.test(meta.postUrl)) summary.setURL(meta.postUrl);

  const summaryFields = [
    { name: '🕒 發文時間', value: meta.createdAt, inline: true },
    { name: '🧾 原文', value: truncate(meta.text, FIELD_VALUE_LIMIT), inline: false },
  ];
  for (const chunk of chunkLines(analysis.keyPoints.map((p) => `• ${p}`))) {
    summaryFields.push({ name: '🔑 重點', value: chunk, inline: false });
  }
  summary.addFields(summaryFields.slice(0, MAX_FIELDS));

  const embeds = [summary];
  addMarketEmbed(embeds, analysis.marketImpacts, quotes, '💹 市場觀察｜投資留意方向（非買賣建議）');
  return finalizeEmbeds(embeds);
}

function addMarketEmbed(
  embeds: EmbedBuilder[],
  impacts: MarketImpact[],
  quotes: StockQuote[],
  title: string,
): void {
  if (impacts.length === 0) return;
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  const market = new EmbedBuilder().setColor(0xfee75c).setTitle(title);
  market.addFields(
    impacts.slice(0, MAX_FIELDS).map((impact) => ({
      name: truncate(impactTitle(impact), FIELD_NAME_LIMIT),
      value: truncate(impactValue(impact, quoteMap), FIELD_VALUE_LIMIT),
      inline: false,
    })),
  );
  embeds.push(market);
}

function finalizeEmbeds(embeds: EmbedBuilder[]): EmbedBuilder[] {
  embeds.at(-1)!.setFooter({ text: DISCLAIMER });
  while (embeds.reduce((sum, e) => sum + e.length, 0) > TOTAL_LIMIT) {
    const target = [...embeds].reverse().find((e) => (e.data.fields?.length ?? 0) > 0);
    if (!target) break;
    target.spliceFields((target.data.fields?.length ?? 1) - 1, 1);
  }
  return embeds;
}

function impactTitle(impact: MarketImpact): string {
  const dir = impact.direction === 'bullish' ? '📈 利多' : '📉 利空';
  const conf = { high: '高', medium: '中', low: '低' }[impact.confidence] ?? impact.confidence;
  return `${dir}｜${impact.theme}（信心：${conf}）`;
}

function impactValue(impact: MarketImpact, quoteMap: Map<string, StockQuote>): string {
  const lines = [`發言原文：「${impact.quote}」`, impact.reason];
  if (impact.exampleTickers.length > 0) {
    const tickers = impact.exampleTickers.map((t) => {
      const q = quoteMap.get(t.trim().toUpperCase());
      if (!q) return `${t}（行情查詢失敗）`;
      const changeSign = q.changePercent >= 0 ? '+' : '';
      return `${t}（${q.price} ${q.currency}，${changeSign}${q.changePercent.toFixed(2)}%）`;
    });
    lines.push(`相關類股／ETF：${tickers.join('、')}`);
  }
  return lines.join('\n');
}

function chunkLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const trimmed = truncate(line, FIELD_VALUE_LIMIT);
    if (current && current.length + trimmed.length + 1 > FIELD_VALUE_LIMIT) {
      chunks.push(current);
      current = trimmed;
    } else {
      current = current ? `${current}\n${trimmed}` : trimmed;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
