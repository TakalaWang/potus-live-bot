# Free serverless deployment (public multi-server bot)

Run the bot with **zero always-on servers and zero monthly cost**. Server admins invite the bot and run `/subscribe channel:#target` to pick the notification channel — no per-server configuration on your side.

```
Discord /subscribe ──► Cloudflare Worker /interactions (Ed25519 verified)
                            │  subscriptions stored in KV (per guild)
                            │
1-min cron ──► YouTube Data API (official, API-key based — no IP bot-check)
                            │
        live start ──► REST fan-out notification to all subscribed channels
        stream end  ──► GitHub repository_dispatch
                            │
GitHub Actions: yt-dlp downloads VOD audio → replay pipeline (VAD → Gemini ASR
→ analysis → quotes) → report fan-out to all subscribed channels
(3 attempts, each on a fresh runner IP; Discord alert on final failure)
```

## Prerequisites (all free)

| What | Where |
|---|---|
| Discord application + bot token + public key | discord.com/developers/applications |
| YouTube Data API key | console.cloud.google.com (10k units/day free) |
| Cloudflare account | dash.cloudflare.com (free plan) |
| Gemini API key | aistudio.google.com (free tier) |
| Public GitHub repo | unlimited free Actions minutes |

## 1. Discord application

1. Create an application at the [Developer Portal](https://discord.com/developers/applications); add a **Bot**, copy the **token**.
2. From General Information, copy the **Application ID** and **Public Key**.
3. Register the slash commands (one-time):
   ```bash
   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... pnpm register-commands
   ```
4. Invite URL (OAuth2 → URL Generator): scopes `bot` + `applications.commands`; bot permissions View Channels, Send Messages, Embed Links, Attach Files.

The **Interactions Endpoint URL** is set in step 5 after the Worker is deployed.

## 2. YouTube Data API key

Google Cloud Console → create/select a project → enable **YouTube Data API v3** → Credentials → Create **API key** (restrict it to the YouTube Data API).

## 3. GitHub repo + secrets

```bash
gh repo create potus-live-bot --public --source . --push
```

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | bot token |
| `GEMINI_API_KEY` | Gemini API key |
| `WORKER_URL` | Worker URL after step 5, e.g. `https://potus-live-worker.xxx.workers.dev` |
| `SUBSCRIPTIONS_SECRET` | a long random string (same value as the Worker secret) |
| `DISCORD_WEBHOOK_URL` | a webhook in YOUR ops channel — only used for failure alerts |

Also create a **fine-grained PAT** for the Worker (Settings → Developer settings → Fine-grained tokens): repository access only this repo, permission **Contents: Read and write**.

## 4. Deploy the Worker

```bash
cd worker
pnpm install
pnpm exec wrangler login
pnpm exec wrangler kv namespace create STATE   # paste the id into wrangler.toml
pnpm exec wrangler secret put YOUTUBE_API_KEY
pnpm exec wrangler secret put DISCORD_BOT_TOKEN
pnpm exec wrangler secret put DISCORD_PUBLIC_KEY
pnpm exec wrangler secret put SUBSCRIPTIONS_SECRET
pnpm exec wrangler secret put GITHUB_TOKEN     # the fine-grained PAT
pnpm exec wrangler deploy                      # prints your workers.dev URL
```

`wrangler.toml` ships with `CHANNEL_ID` (the White House channel) and `GITHUB_REPO` already set — adjust if you fork for another channel.

## 5. Connect Discord to the Worker

Developer Portal → General Information → **Interactions Endpoint URL** → `https://<your-worker>.workers.dev/interactions` → Save (Discord sends a test PING; the Worker must already be deployed).

## 6. Test end to end

1. In a test server: invite the bot, run `/subscribe channel:#test`.
2. GitHub → Actions → **stream-report** → Run workflow → paste any past White House `video_id`. The report should arrive in the subscribed channel in ~10–30 minutes.
3. Worker detection can be tested by temporarily pointing `CHANNEL_ID` at any currently-live channel and redeploying.

## Operations notes

- **Budget**: ~3k/10k YouTube API units per day; KV writes only on stream transitions and `/subscribe` (1k/day limit); Discord fan-out auto-removes subscriptions that return 403/404 (kicked or channel deleted).
- **Failures**: VOD download bot-checks are retried on fresh runner IPs (3×); the final failure alert links to the run for one-click manual re-runs.
- **Streams with archiving disabled** (rare): the VOD doesn't exist; the workflow fails with a clear yt-dlp error.
