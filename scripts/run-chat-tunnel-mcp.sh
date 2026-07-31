#!/bin/sh

set -eu

# Read-only remains the default. A private, owner-controlled ChatGPT tunnel may
# opt into the dedicated host-approved write entrypoint once at deployment time.
# In that mode the Chat host's destructive-tool confirmation is the single
# per-change human approval; no local CLI approval is required.
case "${CHICTRIP_CHAT_HOST_APPROVAL:-0}" in
  1|true|TRUE)
    export CHICTRIP_ENABLE_UNDOCUMENTED_WRITES=1
    export CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS="${CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS:-0}"
    server_name="chat-writable-server.mjs"
    ;;
  *)
    # Never inherit write flags in the default Chat tunnel profile.
    export CHICTRIP_ENABLE_UNDOCUMENTED_WRITES=0
    export CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS=0
    server_name="server.mjs"
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname -- "$script_dir")
server="$project_root/mcp/$server_name"

if [ ! -f "$server" ]; then
  echo "chictrip-agent MCP bundle is missing; run bun run build first." >&2
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
