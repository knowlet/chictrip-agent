#!/bin/sh

set -eu

# Dedicated private ChatGPT tunnel entrypoint. The Chat host's destructive-tool
# approval is treated as the single human approval for each apply call.
# Do not reuse this launcher for generic local MCP clients or public endpoints.
export CHICTRIP_ENABLE_UNDOCUMENTED_WRITES=1
export CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS=1

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname -- "$script_dir")
server="$project_root/mcp/chat-writable-server.mjs"

if [ ! -f "$server" ]; then
  echo "chictrip-agent writable Chat MCP bundle is missing; run bun run build first." >&2
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
