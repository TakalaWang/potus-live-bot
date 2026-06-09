import type { EmbedBuilder } from 'discord.js';
import type { NotifierLike } from './notifier.js';

/** --no-discord 模式：報告印到 stdout（replay 驗證用，不需要 Discord 設定） */
export class ConsoleNotifier implements NotifierLike {
  async start(): Promise<void> {}

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

  async stop(): Promise<void> {}
}
