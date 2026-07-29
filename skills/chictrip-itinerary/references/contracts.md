# Normalized intent contracts

Use ISO dates (`YYYY-MM-DD`) and offset-aware ISO timestamps. A trip can span at
most 60 days and must contain exactly one `days` entry for every date in its
range.

## Create

Resolve `providerLocationKey` with the MCP destination search tool. Do not
invent provider identifiers.

```json
{
  "kind": "create",
  "desired": {
    "title": "東京三日",
    "startDate": "2026-10-01",
    "endDate": "2026-10-03",
    "timezone": "Asia/Tokyo",
    "destinations": [
      {
        "providerLocationKey": "SEARCH_RESULT_LOCATION_KEY",
        "name": "東京"
      }
    ],
    "trafficType": "Custom",
    "days": [
      {
        "date": "2026-10-01",
        "items": [
          {
            "place": {
              "providerPlaceId": "SEARCH_RESULT_POI_ID",
              "name": "東京車站",
              "coverMediaId": "OPTIONAL_SEARCH_RESULT_COVER_ID"
            },
            "startsAt": "2026-10-01T09:00:00+09:00",
            "durationMinutes": 90
          }
        ]
      },
      {
        "date": "2026-10-02",
        "items": []
      },
      {
        "date": "2026-10-03",
        "items": []
      }
    ]
  }
}
```

Each create `days[].items[]` entry has the same `item` shape shown for
`add_item`: required `place.providerPlaceId` and `place.name`, plus optional
`place.latitude`, `place.longitude`, `place.coverMediaId`, `startsAt`,
`durationMinutes`, and `categoryId`. Item notes are currently unsupported.

Items may be included only when `chictrip_capabilities` reports
`write.addItem: true`. Resolve each `providerPlaceId` with the place search
tool. When item adds are disabled, a create intent containing items receives an
`ADD_ITEM_DISABLED` blocker; do not silently substitute an empty shell.

## Update

Copy the latest `revision` from `chictrip_get_trip` without altering it.

```json
{
  "kind": "update",
  "tripId": "TRIP_ID",
  "baseRevision": {
    "providerVersion": "PROVIDER_VERSION",
    "contentHash": "CONTENT_HASH",
    "readAt": "2026-07-25T08:00:00.000Z"
  },
  "operations": [
    {
      "op": "set_trip_fields",
      "fields": {
        "title": "東京四日"
      }
    },
    {
      "op": "update_item",
      "itemId": "EXISTING_ITEM_ID",
      "fields": {
        "durationMinutes": 90
      }
    },
    {
      "op": "add_item",
      "date": "2026-10-01",
      "afterItemId": "OPTIONAL_EXISTING_ANCHOR_ID",
      "item": {
        "place": {
          "providerPlaceId": "SEARCH_RESULT_POI_ID",
          "name": "東京車站"
        },
        "startsAt": "2026-10-01T09:00:00+09:00",
        "durationMinutes": 90
      }
    },
    {
      "op": "move_item",
      "itemId": "EXISTING_ITEM_ID",
      "toDate": "2026-10-01",
      "afterItemId": "OPTIONAL_ANCHOR_ITEM_ID"
    }
  ]
}
```

Supported operation names are:

- `set_trip_fields`
- `add_item`
- `update_item`
- `move_item`
- `remove_item`

Do not use arbitrary JSON Patch or send a full replacement document for an
update.

`add_item` uses the experimental current p1 provider flow and must be capability
gated. It does not support item notes. `move_item` is limited to reordering
within the same date; cross-day moves are always blocked.

## Apply

The local CLI records a short-lived approval grant only after the person types
the exact review code in an interactive terminal. The secret remains in
protected local state and is never returned to the agent.

```json
{
  "previewId": "PREVIEW_UUID",
  "intentHash": "PREVIEW_INTENT_HASH",
  "idempotencyKey": "FRESH_UUID"
}
```

The local grant is bound to the full execution plan, account, and transport.
It expires quickly and is atomically consumed when that preview claims its
single provider write attempt.
