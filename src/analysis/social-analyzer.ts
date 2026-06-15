import type { GoogleGenAI } from '@google/genai';
import { ANALYSIS_RESPONSE_SCHEMA } from './schema.js';
import type { PendingXPost, AnalysisResult } from '../types.js';

export class SocialAnalyzer {
  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
  ) {}

  async analyzePost(post: PendingXPost, recentContext: string): Promise<AnalysisResult> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: buildPrompt(post, recentContext),
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

function buildPrompt(post: PendingXPost, recentContext: string): string {
  return `你是一位金融分析師。請分析一則川普 X 發文，並參考下方近期白宮/川普直播逐字稿脈絡。請嚴格遵守：

1. 用繁體中文撰寫 summaryZh，說明這則 X 發文的重點與近期脈絡。
2. 條列 3–8 個 keyPoints，聚焦已提供的 X 原文和近期脈絡。
3. marketImpacts 是「市場觀察／投資留意方向」，不是買賣建議。只在 X 發文明確包含市場催化劑時列出。
4. marketImpacts 必須以「產業／領域／主題」為單位，不要把單一個股當推薦。
5. quote 必須直接從 X 發文原文複製一段英文，且必須真實出現在 X 發文中。若 X 發文沒有可引用的市場催化劑，marketImpacts 回空陣列。
6. reason 可以參考近期脈絡，但必須說清楚推論基礎，不能加入提供資料之外的政策、數字或事件。
7. exampleTickers 放 2–4 個代表該領域的真實 ETF 或龍頭股代號，優先 ETF。這些只是觀察標的，不是個股買賣建議。

X 發文：
@${post.username}
createdAt: ${post.createdAt}
url: ${post.url}
text:
${post.text}

近期脈絡（由近期直播逐字稿節選而來）：
${recentContext}`;
}
