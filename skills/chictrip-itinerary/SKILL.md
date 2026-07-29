---
name: chictrip-itinerary
description: Read, summarize, plan, preview, create, and modify the user's chicTrip itineraries through the local chictrip MCP server. Use when a user asks about their 去趣 or chicTrip trips, wants a new itinerary synchronized, or wants dates, destinations, places, timing, ordering, or trip metadata changed.
---

# chicTrip Itinerary

Use the local `chictrip` MCP server to work with the user's own chicTrip
itineraries. Keep authentication in the dedicated local browser profile. Never
ask the user to paste a password, cookie, access token, or refresh token.

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
2. Call `chictrip_preview_trip_change`. This must not change the provider
   itinerary.
3. Show the user the complete diff, every warning, every blocker, the estimated
   provider write count, and the preview expiration.
4. If blockers exist, resolve them by making a new intent and preview. Never
   apply a blocked preview.
5. Ask the user to review the preview and run the returned local approval
   command themselves. Approval is deliberately unavailable through MCP.
6. Wait for the CLI to report that the short-lived approval grant was stored
   locally. The approval secret must never be returned to or requested by the
   model.
7. Call `chictrip_apply_trip_change` once with the exact `previewId`,
   `intentHash`, and one fresh UUID idempotency key. The server loads and
   atomically consumes the local approval grant.
8. Treat only `applied` or `already_applied` with verified reconciliation as
   complete. Report `conflict`, `partial`, `indeterminate`, or `failed` as
   incomplete, and do not retry blindly.
9. Call `chictrip_get_trip` after a successful update when the user needs the
   final itinerary rendered. For uncertain outcomes, call
   `chictrip_get_change_status`; it never retries a write.

## Preserve safety boundaries

- Never call apply based only on an earlier conversational confirmation. The
  interactive CLI must have recorded the local approval grant.
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
- Never enable undocumented write flags on the user's behalf.
- Never use this integration for purchases, payments, eSIMs, insurance,
  transport bookings, account changes, publishing, or deleting an entire trip.
- Explain that the adapter uses undocumented chicTrip web endpoints and can
  break or conflict with the provider's terms. Prefer an official partner API
  when one becomes available.
