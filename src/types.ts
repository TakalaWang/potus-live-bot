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

export interface MarketImpact {
  theme: string;
  direction: 'bullish' | 'bearish';
  quote: string;
  reason: string;
  exampleTickers: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface AnalysisResult {
  summaryZh: string;
  keyPoints: string[];
  marketImpacts: MarketImpact[];
}

export interface StockQuote {
  symbol: string;
  name: string;
  price: number;

  changePercent: number;
  currency: string;
  marketState: string;
}

export interface PendingVideo {
  kind: 'video';
  pendingId: string;
  videoId: string;
  title: string;
  videoUrl: string;
}

export interface PendingXPost {
  kind: 'x-post';
  pendingId: string;
  postId: string;
  username: string;
  text: string;
  createdAt: string;
  url: string;
}

export type PendingItem = PendingVideo | PendingXPost;

export type LiveCheck =
  | { state: 'live'; videoId: string; title: string }
  | { state: 'upcoming'; videoId: string; title: string }
  | { state: 'offline' }
  | { state: 'error'; message: string };
