#!/usr/bin/env bash
# launchd wrapper: load .env and run the home agent with the tools on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

# Homebrew (ffmpeg, yt-dlp, deno) + the node that ships with pnpm
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/Library/pnpm:$PATH"

set -a
# shellcheck disable=SC1091
source .env
set +a

exec node dist/index.js --agent
