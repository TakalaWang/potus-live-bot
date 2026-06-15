# Home agent deployment

The agent downloads the VOD audio and runs the report pipeline on a **residential IP**, because YouTube bot-checks datacenter IPs (GitHub Actions, AWS, etc.). It polls the Worker's `/pending` queue, so it does not need to stay busy — it works only after a stream ends, and survives reboots (the queue lives in the Worker's KV).

Any always-on machine on a home/campus network works: a Raspberry Pi, an old laptop, a mini PC. It is intentionally light (idle between streams; Gemini does the heavy ASR in the cloud).

## Raspberry Pi / Linux (systemd)

```bash
# 1. Dependencies
sudo apt-get update
sudo apt-get install -y ffmpeg
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
  | sudo tee /usr/local/bin/yt-dlp > /dev/null && sudo chmod +x /usr/local/bin/yt-dlp
curl -fsSL https://deno.land/install.sh | sudo DENO_INSTALL=/usr/local sh   # yt-dlp needs deno
# Node 20+: use nodesource or nvm if your distro ships an older version

# 2. Code
sudo git clone https://github.com/TakalaWang/president-signal-bot /opt/president-signal-bot
cd /opt/president-signal-bot
sudo corepack enable
sudo pnpm install --frozen-lockfile
sudo pnpm download-model
sudo pnpm build

# 3. Config — create /opt/president-signal-bot/.env
sudo tee /opt/president-signal-bot/.env > /dev/null <<'EOF'
DISCORD_BOT_TOKEN=your-bot-token
GEMINI_API_KEY=your-gemini-key
SUBSCRIPTIONS_URL=https://your-worker.workers.dev/subscriptions
SUBSCRIPTIONS_SECRET=same-secret-as-the-worker
EOF

# 4. Service
sudo cp deploy/president-signal-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now president-signal-agent
sudo journalctl -u president-signal-agent -f      # watch it work
```

`SUBSCRIPTIONS_URL` is the same Worker endpoint the report job used; the agent derives `/pending` and `/pending/done` from it. `DATA_DIR` defaults to `./data` (dedup state + transcripts) — set it to a writable absolute path if you prefer.

## macOS (launchd)

`scripts/run-agent.sh` loads `.env` and puts Homebrew tools on PATH; a launchd agent runs it with `KeepAlive` (restarts on crash and at login).

```bash
# 1. config — create .env in the repo root
cat > .env <<'EOF'
DISCORD_BOT_TOKEN=your-bot-token
GEMINI_API_KEY=your-gemini-key
SUBSCRIPTIONS_URL=https://your-worker.workers.dev/subscriptions
SUBSCRIPTIONS_SECRET=same-secret-as-the-worker
EOF

# 2. install the launchd agent (edit the /PATH/TO/ placeholders first)
cp deploy/com.president-signal-agent.plist.example ~/Library/LaunchAgents/com.president-signal-agent.plist
# replace /PATH/TO/president-signal-bot with your actual checkout path in the plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.president-signal-agent.plist

# 3. watch it
tail -f data/agent.log
```

Manage it: `launchctl bootout gui/$(id -u)/com.president-signal-agent` to stop, `launchctl kickstart -k gui/$(id -u)/com.president-signal-agent` to restart after a rebuild.

A launchd *agent* runs only while you're logged in and pauses while the Mac sleeps — fine for a trial run, but a Raspberry Pi (above) is better for unattended 24/7 use.

## Verifying

Queue any past stream straight into the Worker and watch the running agent pick it up on its next poll:

```bash
curl -X POST -H "authorization: Bearer $SUBSCRIPTIONS_SECRET" \
  -H 'content-type: application/json' \
  -d '{"videoId":"VIDEO_ID","title":"Test"}' \
  "https://<your-worker>.workers.dev/pending"
```

Or run the pipeline directly, bypassing the queue entirely:

```bash
node dist/index.js --replay 'https://www.youtube.com/watch?v=VIDEO_ID' --title 'Test'
```
