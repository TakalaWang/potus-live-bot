import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type SendableChannels,
} from 'discord.js';

const SEND_RETRIES = 3;

export interface NotifierLike {
  start(): Promise<void>;
  notifyLiveStart(title: string, url: string): Promise<void>;
  sendReport(embeds: EmbedBuilder[], transcriptTxt: Buffer, filename: string): Promise<void>;
  stop(): Promise<void>;
}

export class Notifier implements NotifierLike {
  private readonly client: Client;
  private channel: SendableChannels | null = null;

  constructor(
    private readonly token: string,
    private readonly channelId: string,
  ) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
  }

  async start(): Promise<void> {
    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, () => resolve());
    });
    await this.client.login(this.token);
    await ready;

    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel?.isSendable()) {
      throw new Error(
        `頻道 ${this.channelId} 不存在或不可發送訊息（檢查 channel ID 與 bot 的 View Channel / Send Messages 權限）`,
      );
    }
    this.channel = channel;
  }

  async notifyLiveStart(title: string, url: string): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(truncate(`🔴 直播開始：${title}`, 256))
      .setURL(url)
      .setDescription(`白宮頻道正在直播，已開始背景轉錄。\n${url}`)
      .setTimestamp();
    await this.sendWithRetry({ embeds: [embed] });
  }

  async sendReport(embeds: EmbedBuilder[], transcriptTxt: Buffer, filename: string): Promise<void> {
    const files =
      transcriptTxt.length > 0
        ? [new AttachmentBuilder(transcriptTxt, { name: filename, description: '完整逐字稿' })]
        : [];
    await this.sendWithRetry({ embeds, files });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async sendWithRetry(payload: Parameters<SendableChannels['send']>[0]): Promise<void> {
    if (!this.channel) throw new Error('Notifier 尚未 start()');
    let lastError: unknown;
    for (let attempt = 1; attempt <= SEND_RETRIES; attempt++) {
      try {
        await this.channel.send(payload);
        return;
      } catch (err) {
        lastError = err;
        console.warn(`[discord] 發送失敗（第 ${attempt}/${SEND_RETRIES} 次）：${(err as Error).message}`);
        if (attempt < SEND_RETRIES) await sleep(2000 * attempt);
      }
    }

    console.error('[discord] 發送最終失敗：', lastError);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
