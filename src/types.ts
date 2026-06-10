export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface SpeechChunk {
  pcm: Buffer;
  startSec: number;
  endSec: number;
}

export interface VadFrame {
  probability: number;

  startSample: number;
}

export interface StockPick {
  ticker: string;
  direction: 'bullish' | 'bearish';
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface AnalysisResult {
  summaryZh: string;
  keyPoints: string[];
  stockPicks: StockPick[];
}

export interface StockQuote {
  symbol: string;
  name: string;
  price: number;

  changePercent: number;
  currency: string;
  marketState: string;
}

export type LiveCheck =
  | { state: 'live'; videoId: string; title: string }
  | { state: 'upcoming'; videoId: string; title: string }
  | { state: 'offline' }
  | { state: 'error'; message: string };
