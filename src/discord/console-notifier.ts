import type { EmbedBuilder } from 'discord.js';
import type { NotifierLike } from './notifier.js';

export class ConsoleNotifier implements NotifierLike {
  start(): Promise<void> {
    return Promise.resolve();
  }

  async notifyLiveStart(title: string, url: string): Promise<void> {
    console.log(`[dry-run] 🔴 直播開始：${title}\n${url}`);
  }

  async sendReport(embeds: EmbedBuilder[], transcriptTxt: Buffer, filename: string): Promise<void> {
    console.log('[dry-run] 📊 報告 embeds：');
    for (const embed of embeds) {
      console.log(JSON.stringify(embed.toJSON(), null, 2));
    }
    console.log(`[dry-run] 逐字稿附件 ${filename}（${transcriptTxt.length} bytes）：`);
    console.log(transcriptTxt.toString('utf8'));
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
