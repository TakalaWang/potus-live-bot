import { EmbedBuilder } from 'discord.js';
import type { AnalysisResult, StockPick, StockQuote } from './types.js';

export const DISCLAIMER = '本報告由 AI 自動生成，僅供參考，不構成投資建議；投資有風險，請自行判斷。';

export interface ReportMeta {
  title: string;
  videoUrl: string;
  durationSec: number;
  /** 轉錄失敗的時間範圍，如 '12:03–12:48' */
  failedRanges: string[];
}

// Discord embed 硬限制（超過會被 API 以 400 拒絕）
const FIELD_VALUE_LIMIT = 1024;
const FIELD_NAME_LIMIT = 256;
const TITLE_LIMIT = 256;
const DESC_LIMIT = 4096;
const MAX_FIELDS = 25;
const TOTAL_LIMIT = 6000; // 單一訊息所有 embed 文字總長

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
    .setURL(meta.videoUrl)
    .setDescription(truncate(analysis.summaryZh || '（無摘要）', DESC_LIMIT))
    .setTimestamp();

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
  if (analysis.stockPicks.length > 0) {
    const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
    const stocks = new EmbedBuilder().setColor(0xfee75c).setTitle('💹 股票觀察與建議');
    stocks.addFields(
      analysis.stockPicks.slice(0, MAX_FIELDS).map((pick) => ({
        name: truncate(pickTitle(pick), FIELD_NAME_LIMIT),
        value: truncate(pickValue(pick, quoteMap.get(pick.ticker)), FIELD_VALUE_LIMIT),
        inline: false,
      })),
    );
    embeds.push(stocks);
  }
  embeds[embeds.length - 1].setFooter({ text: DISCLAIMER });

  // 全部 embed 同一則訊息送出，總長必須 ≤ 6000：從後面開始拔 field
  while (embeds.reduce((sum, e) => sum + e.length, 0) > TOTAL_LIMIT) {
    const target = [...embeds].reverse().find((e) => (e.data.fields?.length ?? 0) > 0);
    if (!target) break;
    target.spliceFields((target.data.fields?.length ?? 1) - 1, 1);
  }
  return embeds;
}

function pickTitle(pick: StockPick): string {
  const dir = pick.direction === 'bullish' ? '📈 看多' : '📉 看空';
  const conf = { high: '高', medium: '中', low: '低' }[pick.confidence] ?? pick.confidence;
  return `${dir}｜${pick.ticker}（信心：${conf}）`;
}

function pickValue(pick: StockPick, quote: StockQuote | undefined): string {
  const priceLine = quote
    ? `${quote.name}：${quote.price} ${quote.currency}（${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%）`
    : '行情查詢失敗';
  return `${priceLine}\n${pick.reason}`;
}

/** 把多行文字組成多個 ≤1024 字的塊 */
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
