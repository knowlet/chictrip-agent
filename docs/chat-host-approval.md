# Chat host approval mode

The default Chat tunnel launcher remains read-only. A private, owner-controlled
ChatGPT tunnel can opt into a writable MCP entrypoint where the Chat host's
confirmation for the destructive `chictrip_apply_trip_change` tool call is the
single per-change human approval.

This removes the second trip to a local terminal. It does **not** remove the
preview, account binding, intent hash, execution-plan digest, revision check,
one-shot nonce, idempotency ledger, or provider read-back verification.

## Build

```bash
bun install --frozen-lockfile
bun run validate
```

The build creates both entrypoints:

- `mcp/server.mjs`: normal local-CLI approval mode
- `mcp/chat-writable-server.mjs`: Chat host approval mode

## Enable for a private Chat tunnel

Set the mode once in the environment of the managed tunnel runtime, then keep
using the existing executable launcher:

```bash
export CHICTRIP_CHAT_HOST_APPROVAL=1
export CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS=1 # optional; keep 0 for safer rollout

# Use the existing runtime command:
# ... --mcp-command "$PWD/scripts/run-chat-tunnel-mcp.sh"
```

With `CHICTRIP_CHAT_HOST_APPROVAL` unset, the launcher forcibly disables all
writes and starts the original read-only-compatible MCP bundle.

## Runtime flow

1. Chat reads the trip and creates a preview.
2. Chat shows the diff, warnings, blockers, write count, and expiry.
3. Chat calls `chictrip_apply_trip_change` as a destructive tool.
4. The Chat host asks the user to allow that exact call once.
5. The server creates a short-lived local grant bound to the preview, intent,
   execution plan, account, and transport, then immediately consumes it.
6. The existing one-attempt ledger and read-back verification determine the
   final result.

An expired, unused grant may be refreshed during the approved call. A preview
that already has an apply claim is never re-approved or retried with a new key.

## Trust boundary

Host approval mode is appropriate only for the dedicated private Chat tunnel or
another client that independently enforces destructive-tool confirmation. MCP
metadata is not cryptographic proof that a generic client displayed an approval
UI. Do not expose `mcp/chat-writable-server.mjs` through a public endpoint or use
it as the default local MCP server.
