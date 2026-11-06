#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x node_modules/node/bin/node ]]; then
  npm ci
fi
export PATH="$PWD/node_modules/node/bin:$PATH"
if [[ ! -f .data/omb/snapshot.json || "${1:-}" == --snapshot ]]; then
  if ! command -v sqlite3 >/dev/null && [[ ! -x .data/tools/usr/bin/sqlite3 ]]; then
    mkdir -p .data/tools
    (cd .data/tools && apt-get download sqlite3 && dpkg-deb -x sqlite3*.deb .)
  fi
  export SQLITE3="$(command -v sqlite3 || echo "$PWD/.data/tools/usr/bin/sqlite3")"
  node --experimental-strip-types snapshot.ts
fi
exec /home/clauber/ai/bin/gsd-secrets run --key ELEVENLABS_API_KEY --key OPENAI_API_KEY --key ANTHROPIC_API_KEY --key GEMINI_KEY --key GROQ_MEETING_KEY --key 9R_KEY --key DEEPSEEK_API_KEY --key CLI_PROXY_API_KEY -- node --experimental-strip-types launch.ts
