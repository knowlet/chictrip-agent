#!/bin/sh

set -eu

# This launcher is a stable read-only rollback boundary. Never inherit write
# flags from a shell or long-lived runtime.
export CHICTRIP_ENABLE_UNDOCUMENTED_WRITES=0
export CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS=0

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname -- "$script_dir")

if [ ! -f "$project_root/mcp/server.mjs" ]; then
  echo "chictrip-agent MCP bundle is missing; run bun run build first." >&2
  exit 1
fi

if [ -x /opt/homebrew/bin/bun ]; then
  exec /opt/homebrew/bin/bun "$project_root/mcp/server.mjs"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$project_root/mcp/server.mjs"
fi

echo "chictrip-agent requires Bun or Node.js 22+." >&2
exit 1
