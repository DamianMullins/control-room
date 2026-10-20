#!/bin/bash
# Launch script for the ops dashboard. Kept separate from the launchd plist so config and
# tokens stay in .env (chmod 600) instead of being duplicated into a plist.
set -euo pipefail

# launchd starts with a minimal PATH, so add the usual macOS locations.
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
export PATH

cd "$(dirname "$0")"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

export NODE_ENV=production
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-5391}"

exec node build/index.js
