# Chat form approval mode

The default Chat tunnel launcher is permanently read-only. A deployment owner
can opt into a second, dedicated writable launcher for a private ChatGPT App:

- `scripts/run-chat-tunnel-mcp.sh` starts `mcp/server.mjs` with write flags
  forced to `0/0`.
- `scripts/run-chat-tunnel-mcp-writable.sh` starts
  `mcp/chat-writable-server.mjs` with write flags forced to `1/1`.

Do not switch either launcher from inside a conversation. Give the writable
launcher its own Tunnel, runtime profile, alias, and clearly named ChatGPT App.

## Build and local contract checks

```bash
bun install --frozen-lockfile
bun run validate
bun run smoke:chat-tunnel
bun run smoke:chat-tunnel:writable
```

The writable smoke verifies the eight expected tools, the complete
create/update preview schema, enabled write capabilities, destructive apply
annotations, and the requirement for Chat form confirmation. It uses temporary
unauthenticated state and performs no provider write.

## Connect the private writable Tunnel

After logging into chicTrip with the intended local state directory, connect a
separate Tunnel runtime:

```bash
tunnel-client runtimes connect \
  --alias chictrip-chat-writable \
  --profile chictrip-chat-writable \
  --profile-dir "$PWD/.tunnel-client/profiles" \
  --tunnel-id <YOUR_WRITABLE_TUNNEL_ID> \
  --runtime-api-key "file:$HOME/.local/share/chictrip-agent/openai-tunnel-runtime-key" \
  --mcp-command "$PWD/scripts/run-chat-tunnel-mcp-writable.sh" \
  --json
```

If the read-only and writable runtimes use the same `CHICTRIP_STATE_DIR`, they
must not run at the same time because Chrome cannot safely share one persistent
profile. Stop one runtime before starting the other, or give each runtime a
separate state/browser profile and log into chicTrip separately.

## Runtime approval flow

1. Chat reads capabilities and the current itinerary, resolves real provider
   IDs, and calls `chictrip_preview_trip_change` with the complete normalized
   request under the top-level `intent` field.
2. The server creates a read-only preview bound to the account, transport,
   revision, intent hash, and execution-plan digest.
3. Chat shows the complete diff, warnings, blockers, estimated writes, and
   expiration. A blocked preview cannot be applied.
4. Chat calls the destructive `chictrip_apply_trip_change` tool with the exact
   preview ID and intent hash plus one fresh idempotency UUID.
5. Before creating any grant, the server verifies that the connected MCP client
   supports form elicitation. The server-created form renders a canonical JSON
   review containing the target, complete diff, warnings, estimated writes,
   and expiry, then asks for the exact `APPLY <reviewCode>` string.
6. Only an accepted form with the exact string creates the short-lived,
   one-use local grant. Decline, cancel, missing form capability, or a wrong code
   returns an error and performs no provider write.
7. The existing single-attempt claim, revision check, idempotency ledger, and
   provider read-back verification determine the final result.

ChatGPT may also show its native confirmation for the destructive tool call.
That confirmation and the server-requested form serve different purposes; do
not weaken the tool annotations to suppress the native confirmation.

## Trust boundary

MCP form elicitation proves only that the connected client returned an accepted
form response. It is not a signed attestation that a human operated the UI: a
malicious generic MCP client can advertise form support and answer its own
request. Tool annotations likewise guide host behavior but do not replace
server authorization, validation, or confirmation; see OpenAI's
[tool annotations and elicitation guidance](https://developers.openai.com/plugins/build/mcp-server#tool-annotations-and-elicitation).

Therefore the writable entrypoint is restricted to a dedicated, private,
single-user ChatGPT Tunnel and its intended workspace/account. Do not expose it
through a public endpoint, Responses API, Codex, automation runner, shared
generic MCP client, or multi-user service. Those surfaces must use the default
local-CLI approval mode or a future authenticated URL-elicitation approval page.

If ChatGPT does not advertise or display form elicitation on the active surface,
the server fails closed with `APPROVAL_REQUIRED`. Use the read-only Tunnel or
the local CLI approval flow; do not add a fallback that silently mints a grant.

## Rollback

Stop the writable runtime and reconnect the read-only Tunnel:

```bash
tunnel-client runtimes stop chictrip-chat-writable --json

tunnel-client runtimes connect \
  --alias chictrip-chat \
  --profile chictrip-chat-readonly \
  --profile-dir "$PWD/.tunnel-client/profiles" \
  --tunnel-id <YOUR_READ_ONLY_TUNNEL_ID> \
  --runtime-api-key "file:$HOME/.local/share/chictrip-agent/openai-tunnel-runtime-key" \
  --mcp-command "$PWD/scripts/run-chat-tunnel-mcp.sh" \
  --json
```

Confirm `chictrip_capabilities` reports every provider write capability as
`false` before treating the rollback as complete.
