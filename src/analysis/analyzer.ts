import { Type, type GoogleGenAI } from '@google/genai';
import type { AnalysisResult } from '../types.js';

const PROMPT_HEADER = `你是一位金融分析師。以下是一場白宮 YouTube 直播的英文逐字稿（含 [mm:ss] 時間戳）。請：

1. 用繁體中文撰寫摘要（summaryZh），聚焦川普總統與官員的發言內容。
2. 條列 3–8 個重點（keyPoints，繁體中文）。
3. 找出發言中可能影響金融市場的內容，給出股票觀察建議（stockPicks）：
   - ticker 必須是真實存在的美股上市代號（如 NVDA、XOM）。
   - direction：該發言對這檔股票是利多（bullish）或利空（bearish）。
   - reason：繁體中文說明發言內容與影響邏輯。
   - confidence：發言的具體程度與影響的直接程度（high/medium/low）。
   - 只列出有明確催化劑的標的；若內容與市場無關，stockPicks 回空陣列。

逐字稿：
`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summaryZh: { type: Type.STRING, description: '繁體中文摘要' },
    keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
    stockPicks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ticker: { type: Type.STRING },
          direction: { type: Type.STRING, enum: ['bullish', 'bearish'] },
          reason: { type: Type.STRING },
          confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
        },
        required: ['ticker', 'direction', 'reason', 'confidence'],
      },
    },
  },
  required: ['summaryZh', 'keyPoints', 'stockPicks'],
  propertyOrdering: ['summaryZh', 'keyPoints', 'stockPicks'],
};

export class Analyzer {
  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
  ) {}

  async analyze(transcriptText: string): Promise<AnalysisResult> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: PROMPT_HEADER + transcriptText,
      config: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    const parsed = JSON.parse(response.text ?? '{}') as Partial<AnalysisResult>;
    return {
      summaryZh: parsed.summaryZh ?? '',
      keyPoints: parsed.keyPoints ?? [],
      stockPicks: parsed.stockPicks ?? [],
    };
  }
}
