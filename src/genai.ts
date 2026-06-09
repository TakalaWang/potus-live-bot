import { GoogleGenAI } from '@google/genai';

/** 共用 Gemini client。retry 是 opt-in：對 408/429/5xx 指數退避重試 */
export function createGenAI(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 120_000, // 預設 60s，長音訊轉錄要調高
      retryOptions: { attempts: 4 },
    },
  });
}
