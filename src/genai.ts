import { GoogleGenAI } from '@google/genai';

export function createGenAI(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 120_000,
      retryOptions: { attempts: 4 },
    },
  });
}
