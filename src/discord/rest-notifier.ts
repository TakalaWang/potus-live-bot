import type { EmbedBuilder } from 'discord.js';
import type { NotifierLike } from './notifier.js';

const API = 'https://discord.com/api/v10';

export class RestNotifier implements NotifierLike {
  constructor(
    private readonly botToken: string,
    private readonly channelIds: string[],
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async notifyLiveStart(title: string, url: string): Promise<void> {
    const body = JSON.stringify({
      embeds: [
        {
          color: 0xed4245,
          title: truncate(`🔴 直播開始：${title}`, 256),
          url,
          description: `白宮頻道正在直播，結束後將自動送出分析報告。\n${url}`,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    for (const channelId of this.channelIds) {
      await this.send(channelId, body, 'application/json');
    }
  }

  async sendReport(embeds: EmbedBuilder[], transcriptTxt: Buffer, filename: string): Promise<void> {
    for (const channelId of this.channelIds) {
      const form = new FormData();
      form.append(
        'payload_json',
        JSON.stringify({
          embeds: embeds.map((e) => e.toJSON()),
          attachments: transcriptTxt.length > 0 ? [{ id: 0, filename }] : [],
        }),
      );
      if (transcriptTxt.length > 0) {
        form.append('files[0]', new Blob([new Uint8Array(transcriptTxt)], { type: 'text/plain' }), filename);
      }
      await this.send(channelId, form);
    }
  }

  private async send(channelId: string, body: BodyInit, contentType?: string, attempt = 1): Promise<void> {
    const headers: Record<string, string> = { authorization: `Bot ${this.botToken}` };
    if (contentType) headers['content-type'] = contentType;
    try {
      const res = await fetch(`${API}/channels/${channelId}/messages`, { method: 'POST', headers, body });
      if (res.ok) return;
      if (res.status === 403 || res.status === 404) {
        console.warn(`[discord] 頻道 ${channelId} 無法發送（${res.status}），略過`);
        return;
      }
      if (res.status === 429 && attempt <= 3) {
        const data = (await res.json()) as { retry_after?: number };
        await sleep((data.retry_after ?? 1) * 1000 + 100);
        return this.send(channelId, body, contentType, attempt + 1);
      }
      console.error(`[discord] 頻道 ${channelId} 發送失敗：${res.status} ${await res.text()}`);
    } catch (err) {
      console.error(`[discord] 頻道 ${channelId} 發送錯誤：${(err as Error).message}`);
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
