import type { GoogleGenAI } from '@google/genai';

// 整個 request 上限 20MB，且音訊以 base64 傳輸會膨脹 4/3：
// 原始 WAV ≤ 14MB ⇒ base64 ≈ 18.7MB，剩餘留給 prompt
const INLINE_LIMIT_BYTES = 14 * 1024 * 1024;

const TRANSCRIBE_PROMPT =
  'Transcribe this audio verbatim in its original language. ' +
  'Output only the spoken words. If there is no speech, output nothing.';

export class Transcriber {
  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
  ) {}

  /** WAV → 逐字英文轉錄。無語音回空字串。 */
  async transcribe(wav: Buffer): Promise<string> {
    if (wav.byteLength > INLINE_LIMIT_BYTES) {
      // chunker 上限 45s 語音（≈1.4MB），正常不會到這裡；防呆而非功能
      throw new Error(`WAV ${wav.byteLength} bytes 超過 inline 上限，chunk 切割設定有誤`);
    }
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        { inlineData: { data: wav.toString('base64'), mimeType: 'audio/wav' } },
        TRANSCRIBE_PROMPT,
      ],
      config: { temperature: 0 },
    });
    return (response.text ?? '').trim();
  }
}
