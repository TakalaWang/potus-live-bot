import { Type } from '@google/genai';

export const ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summaryZh: { type: Type.STRING, description: '繁體中文摘要' },
    keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
    marketImpacts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          theme: { type: Type.STRING, description: '受影響的產業／領域／主題' },
          direction: { type: Type.STRING, enum: ['bullish', 'bearish'] },
          quote: { type: Type.STRING, description: '來源內容中的英文原文依據（必須真實出現）' },
          reason: { type: Type.STRING, description: '繁體中文，緊扣 quote 字面，不延伸' },
          exampleTickers: { type: Type.ARRAY, items: { type: Type.STRING } },
          confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
        },
        required: ['theme', 'direction', 'quote', 'reason', 'exampleTickers', 'confidence'],
      },
    },
  },
  required: ['summaryZh', 'keyPoints', 'marketImpacts'],
  propertyOrdering: ['summaryZh', 'keyPoints', 'marketImpacts'],
};
