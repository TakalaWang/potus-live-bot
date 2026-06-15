import type { GoogleGenAI } from '@google/genai';
import { ANALYSIS_RESPONSE_SCHEMA } from './schema.js';
import type { AnalysisResult } from '../types.js';

const PROMPT_HEADER = `你是一位金融分析師。以下是一場白宮 YouTube 直播的英文逐字稿（含 [mm:ss] 時間戳）。請：

1. 用繁體中文撰寫摘要（summaryZh），聚焦川普總統與官員的發言內容。
2. 條列 3–8 個重點（keyPoints，繁體中文）。
3. 找出發言中可能影響金融市場的內容，輸出「受影響領域」觀察（marketImpacts）。嚴格遵守：
   - 以「產業／領域／主題」為單位（如「天然氣管道基建」「半導體製造」「國防」），不要點名單一個股當作推薦。
   - quote：直接從上面逐字稿複製一段相關的英文原文片段，作為依據。這段必須真的出現在逐字稿裡——找不到可引用的原文，就不要列這個領域。
   - reason：繁體中文說明，必須緊扣 quote 的字面內容，只陳述發言明確提到的事，不要延伸到逐字稿沒講的政策或結論。
   - direction：該發言對這個領域是利多（bullish）或利空（bearish）。
   - exampleTickers：2–4 個「代表該領域」的標的，優先用產業 ETF（如能源 XLE、半導體 SOXX、油氣探勘 XOP），可搭配該領域龍頭股當例子。這是「方向參考」而非個股買賣建議。代號需真實存在。
   - confidence：發言的具體程度與關聯的直接程度（high/medium/low）。
   - 只在發言有明確、具體的市場催化劑時才列出；若內容與市場無關（如純典禮、表揚、體育），marketImpacts 回空陣列，不要勉強湊。

逐字稿：
`;

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
        responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      },
    });
    const parsed = JSON.parse(response.text ?? '{}') as Partial<AnalysisResult>;
    return {
      summaryZh: parsed.summaryZh ?? '',
      keyPoints: parsed.keyPoints ?? [],
      marketImpacts: parsed.marketImpacts ?? [],
    };
  }
}
