# Free serverless deployment

Run the bot with **zero always-on servers and zero monthly cost**, using a different architecture from the 24/7 mode:

```
┌─ Detection + notification (24/7, free) ─────────────────────────┐
│ Cloudflare Worker (free plan, 1-minute cron)                     │
│   polls YouTube Data API (official, API-key based — datacenter   │
│   IPs are NOT bot-checked; ~3k of the 10k free daily quota)      │
│   live detected  → Discord webhook notification                  │
│   stream ended   → GitHub repository_dispatch                    │
└──────────────────────────────────────────────────────────────────┘
                              ↓ fires once per stream
┌─ Report (one-shot job, free) ────────────────────────────────────┐
│ GitHub Actions: download the VOD audio with yt-dlp, then run the │
│ existing replay pipeline (VAD → Gemini ASR → analysis → quotes   │
│ → Discord report). 3 attempts, each on a fresh runner IP.        │
└──────────────────────────────────────────────────────────────────┘
```

Trade-offs vs. the 24/7 mode:
- The report arrives ~10–30 minutes after the stream ends (VOD download + batch ASR) instead of ~2 minutes.
- There is no live in-progress transcription (the user-facing output is identical: live notification + post-stream report).
- The VOD download from GitHub Actions runners can hit YouTube's bot check; the workflow retries on fresh runners (new IPs). If all 3 attempts fail, you get a Discord alert with a one-click manual re-run link.

## Prerequisites

| What | Where | Cost |
|---|---|---|
| YouTube Data API key | console.cloud.google.com | free (10k units/day) |
| Cloudflare account | dash.cloudflare.com | free plan |
| Discord webhook | channel settings → Integrations → Webhooks | free |
| Discord bot token + channel id | existing bot setup (README) | free |
| Gemini API key | aistudio.google.com | free tier |
| Public GitHub repo | github.com | free unlimited Actions minutes |

## 1. YouTube Data API key

1. Go to [Google Cloud Console](https://console.cloud.google.com), create a project (or reuse one).
2. APIs & Services → Library → enable **YouTube Data API v3**.
3. APIs & Services → Credentials → Create credentials → **API key**. Restrict it to the YouTube Data API.

## 2. Find the channel id

Open the channel page → View page source → search for `"channelId"` (starts with `UC`). For the White House channel use its `UC...` id.

## 3. Push this repo to GitHub (public)

```bash
gh repo create potus-live-bot --public --source . --push
```

Then add repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | your bot token (sends the report) |
| `DISCORD_CHANNEL_ID` | target channel id |
| `GEMINI_API_KEY` | Gemini API key |
| `DISCORD_WEBHOOK_URL` | channel webhook (failure alerts) |

## 4. Create a fine-grained PAT for the Worker

GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
- Repository access: **only** `potus-live-bot`
- Permissions: **Contents: Read and write** (required for `repository_dispatch`)

## 5. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create STATE   # paste the printed id into wrangler.toml
```

Edit `wrangler.toml`: set `CHANNEL_ID`, `GITHUB_REPO` (e.g. `yourname/potus-live-bot`), and the KV namespace id. Then:

```bash
npx wrangler secret put YOUTUBE_API_KEY
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put GITHUB_TOKEN        # the fine-grained PAT from step 4
npx wrangler deploy
```

The Worker now polls every minute. Free-plan budget check: ~3k YouTube API units/day (limit 10k), ~3 KV writes per stream (limit 1k/day), well within Workers free requests.

## 6. Test end to end

Without waiting for a real stream, trigger the report manually against any past White House video:

- GitHub → Actions → **stream-report** → Run workflow → paste a `video_id`.

You should see a Discord report in ~10–30 minutes. To test the Worker, temporarily point `CHANNEL_ID` at any channel that is currently live.

## How failures are handled

- **Bot-check on VOD download**: attempts 2 and 3 run on fresh runners (different IPs). After 3 failures a Discord alert links to the run for manual re-run (each re-run is another IP draw).
- **Worker errors** (API quota, Discord down): the cron retries every minute; state in KV ensures notifications are not duplicated and the dispatch fires once.
- **Stream with archiving disabled** (rare): the VOD won't exist; the workflow fails with a clear yt-dlp error in the logs.
