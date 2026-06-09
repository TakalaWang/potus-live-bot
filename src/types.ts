/** 一段已轉錄的語音，時間為直播相對秒數 */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Chunker 產出的待轉錄語音塊 */
export interface SpeechChunk {
  pcm: Buffer;
  startSec: number;
  endSec: number;
}

/** VAD 對單一 512-sample frame 的判斷 */
export interface VadFrame {
  /** 語音機率 0..1 */
  probability: number;
  /** frame 起點，自串流開始的樣本數 */
  startSample: number;
}

export interface StockPick {
  ticker: string;
  direction: 'bullish' | 'bearish';
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

/** Gemini 直播結束後分析的結構化輸出 */
export interface AnalysisResult {
  summaryZh: string;
  keyPoints: string[];
  stockPicks: StockPick[];
}

export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  /** 當日漲跌百分比，-4.11 代表 -4.11% */
  changePercent: number;
  currency: string;
  marketState: string;
}

export type LiveCheck =
  | { state: 'live'; videoId: string; title: string }
  | { state: 'upcoming'; videoId: string; title: string }
  | { state: 'offline' }
  | { state: 'error'; message: string };
