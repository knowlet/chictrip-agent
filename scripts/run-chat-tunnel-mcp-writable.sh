#!/bin/sh

set -eu

# Explicit deployment-owner opt-in for a dedicated, single-user ChatGPT tunnel.
# This entrypoint enables the reviewed provider write set and uses server-side
# MCP form elicitation for each fresh approval. Keep it separate from the
# read-only launcher so runtime restarts cannot silently change modes.
export CHICTRIP_ENABLE_UNDOCUMENTED_WRITES=1
export CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS=1

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname -- "$script_dir")
server="$project_root/mcp/chat-writable-server.mjs"

if [ ! -f "$server" ]; then
  echo "chictrip-agent writable MCP bundle is missing; run bun run build first." >&2
  exit 1
fi

if [ -x /opt/homebrew/bin/bun ]; then
  exec /opt/homebrew/bin/bun "$server"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$server"
fi

echo "chictrip-agent requires Bun or Node.js 22+." >&2
exit 1
