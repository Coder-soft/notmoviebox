#!/usr/bin/env bash
# notmoviebox — free public URL via a Cloudflare quick tunnel.
#
# Exposes the local Node server (which already works: residential IP, so the
# MovieBox API/CDN respond normally) at a temporary public https URL.
# No account, no card, no config.
#
#   ./scripts/tunnel.sh
#
# Requires cloudflared:  brew install cloudflared

set -euo pipefail

PORT="${PORT:-8787}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${TMPDIR:-/tmp}/notmoviebox-server.log"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed."
  echo "  macOS:  brew install cloudflared"
  echo "  other:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

# Start the app server if it is not already listening.
if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Starting notmoviebox on port ${PORT}…"
  ( cd "$ROOT" && nohup node server/index.mjs </dev/null >"$LOG" 2>&1 & )
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi

if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Server did not start. Check ${LOG}"
  exit 1
fi

echo "Opening tunnel… (Ctrl+C to stop)"
echo

# Quick tunnel prints its public URL on stderr; surface it and keep running.
cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate 2>&1 \
  | while IFS= read -r line; do
      url="$(printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' || true)"
      if [ -n "$url" ]; then
        echo
        echo "  notmoviebox is live at:  $url"
        echo
        echo "  (temporary URL — it changes each run. The API/CDN work because the"
        echo "   requests still leave from this machine's IP.)"
        echo
      fi
      printf '%s\n' "$line" | grep -vE 'trycloudflare\.com' || true
    done
