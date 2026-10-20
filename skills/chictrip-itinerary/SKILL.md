---
name: chictrip-itinerary
description: Read, summarize, plan, preview, create, and modify the user's chicTrip itineraries through connected chictrip MCP tools in ChatGPT or Codex. Use when a user asks about their 去趣 or chicTrip trips, wants a new itinerary synchronized, or wants dates, destinations, places, timing, ordering, or trip metadata changed.
---

# chicTrip Itinerary

Use the chicTrip tools supplied by the active plugin, through either its local
MCP server or its private ChatGPT App and Tunnel. Keep authentication in the
dedicated browser profile on the computer running that server. Never ask the
user to paste a password, cookie, access token, or refresh token.

## Verify the connection

1. Discover the active plugin's tools by their `chictrip_` names; the host may
   prefix them with its own namespace. A skill being installed does not prove
   that its App or Tunnel is connected.
2. Call `chictrip_capabilities` before reading or changing itineraries. Use the
   returned authentication and capability fields, not the App's display name
   or an earlier conversation, to determine what is available now.
3. If no chicTrip tools are available, explain that the App must be connected
   before live data can be read. If the server is unavailable, identify the
   connection failure; do not misreport it as an empty itinerary list. If
   authentication is required, have the user sign in on the runtime computer
   using the repository's existing login flow.
4. In read-only mode, continue with reading, summarizing, and planning in chat.
   State that a proposed plan has not been synchronized. Never enable writes,
   switch App bindings, or replace the runtime to satisfy an itinerary request.
5. Use the actual tool result as evidence. Successful MCP responses put their
   payload in `structuredContent.data` with `ok: true`; an `isError` or
   `ok: false` result is not a successful operation. Do not fabricate trips,
   identifiers, synchronization results, or a logged-in account.

## Choose the workflow

- For a summary or planning discussion, call `chictrip_list_trips`, then
  `chictrip_get_trip`. Do not create a preview unless the user wants data
  synchronized.
- For a new trip, resolve destination identifiers with
  `chictrip_search_destinations`. Resolve every planned place with
  `chictrip_search_places`; never invent a provider place ID. Put items in the
  create intent only when `chictrip_capabilities` reports
  `write.addItem: true`.
- For an existing trip, always read it immediately before planning the change.
  Copy its full `revision` into an `update` intent and express changes as
  structured operations.
- Read [references/contracts.md](references/contracts.md) before constructing a
  create or update intent.

## Preview every write

1. Call `chictrip_capabilities`. Stop if the requested write capability is
   disabled.
2. Call `chictrip_preview_trip_change` with the normalized create or update
   request in its top-level `intent` field. This must not change the provider
   itinerary. The CLI `changes preview --input` file remains the direct intent
   without this MCP-only envelope.
3. Show the user the complete diff, every warning, every blocker, the estimated
   provider write count, and the preview expiration.
4. If blockers exist, resolve them by making a new intent and preview. Never
   apply a blocked preview.
5. Determine the active approval mode from the apply tool's title, description,
   and preview summary:
   - In **Chat form approval** mode, the apply tool says it will request MCP
     form elicitation. Call `chictrip_apply_trip_change` only after presenting
     the preview. The server form will repeat the target, canonical full diff,
     warnings, estimated writes, and expiry before asking the user inside Chat
     to type the exact `APPLY <reviewCode>` string. Do not send the user back to
     a computer or ask them to run a CLI approval command. If the client cannot
     show the form, or the user declines or cancels it, report
     `APPROVAL_REQUIRED` and stop.
   - In **local CLI approval** mode, ask the user to run the preview's local
     approval command and wait until the CLI reports that the short-lived grant
     was stored.
6. Call `chictrip_apply_trip_change` once with the exact `previewId`,
   `intentHash`, and one fresh UUID idempotency key. In Chat form approval mode,
   the server creates and immediately consumes a short-lived grant bound to the
   preview only after the form returns the exact review code. In local CLI mode,
   it consumes the grant previously stored by the CLI. Approval secrets never
   appear in tool output.
7. Treat only `applied` or `already_applied` with verified reconciliation as
   complete. Report `conflict`, `partial`, `indeterminate`, or `failed` as
   incomplete, and do not retry blindly.
8. Call `chictrip_get_trip` after a successful update when the user needs the
   final itinerary rendered. For uncertain outcomes, call
   `chictrip_get_change_status`; it never retries a write.

## Preserve safety boundaries

- Never treat ordinary conversational consent or destructive-tool metadata as
  write approval. Approval must be either the exact review code collected by
  server-initiated Chat form elicitation or a local CLI grant, according to the
  active MCP entrypoint.
- A preview gets at most one provider write attempt. Never generate a new
  idempotency key to retry a preview after `partial` or `indeterminate`.
- Never reuse an idempotency key for a different intent.
- Never force through a revision conflict. Re-read and create a new preview.
- Attempt `add_item` only when capabilities report `write.addItem: true`.
  Explain that it uses the experimental current p1 web flow and that an
  uncertain result cannot be blindly retried. If it is false, do not silently
  downgrade a requested place-filled trip to an empty shell; offer that only as
  a separate user choice.
- Never attempt a cross-day `move_item`; it remains deliberately blocked.
- Never silently alter a collaborative trip; identify it and mention that the
  revision will be rechecked.
- During an itinerary operation, never change launchers or enable undocumented
  write flags. A deployment owner must explicitly opt into the separate
  writable runtime before the conversation starts.
- Never use this integration for purchases, payments, eSIMs, insurance,
  transport bookings, account changes, publishing, or deleting an entire trip.
- Explain that the adapter uses undocumented chicTrip web endpoints and can
  break or conflict with the provider's terms. Prefer an official partner API
  when one becomes available.
