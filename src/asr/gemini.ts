import type { GoogleGenAI } from '@google/genai';

const INLINE_LIMIT_BYTES = 14 * 1024 * 1024;

const TRANSCRIBE_PROMPT =
  'Transcribe this audio verbatim in its original language. ' +
  'Output only the spoken words. If there is no speech, output nothing.';

export class Transcriber {
  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
  ) {}

  async transcribe(wav: Buffer): Promise<string> {
    if (wav.byteLength > INLINE_LIMIT_BYTES) {
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
