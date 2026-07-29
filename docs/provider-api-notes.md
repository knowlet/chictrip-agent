# chicTrip web contract notes

Observed from the official web application's public bundles on 2026-07-25.
These endpoints are not a published or supported chicTrip developer API.
Re-check the current bundle and service terms before maintaining or enabling
writes.

Base URL:

```text
https://api.chictrip.com.tw/
```

The current official web client sends these headers through its shared API
client:

```text
osType: web
language: zhtw
version: 2.0.38
```

`AddV2` and `UpdateV3` override `language` to `zh-tw`. The unrelated
`devVersion` UI feature flag is not an API request version.

The HTTP response uses an application envelope:

```json
{
  "apiStatus": "001",
  "data": {},
  "message": null
}
```

Known statuses:

- `001`: success
- `003`: authentication missing or expired
- `004`: optimistic revision conflict
- `006`: itinerary permission no longer allows the operation

`requestId` and `traceId` may also be present upstream. Do not return or persist
them with raw request/response data.

## Allowlisted endpoints

| Purpose | Method | Path |
| --- | --- | --- |
| List owned/collaborative trips | GET | `/TravelSchedule/GetMyAndCollaboration` |
| Read one trip | GET | `/TravelScheduleDetail/Get` |
| Search destinations | GET | `/Location/SearchV2` |
| Search places | GET | `/PoiSearch/SearchByKeyword` |
| Read system covers | GET | `/TravelSchedule/GetSystemCoverList` |
| Read itinerary labels | GET | `/TravelScheduleUserLabel/Get` |
| Create trip shell | POST | `/TravelSchedule/AddV2` |
| Verify revision | GET | `/TravelScheduleDetail/VerifyUpdateTime` |
| Update trip fields | PUT | `/TravelSchedule/UpdateV3` |
| Read p1 item insertion choices | GET | `/TravelScheduleDetail/GetAddWhere` |
| Add item with the p1 flow | POST | `/TravelScheduleDetail/Add` |
| Read editable item fields | GET | `/TravelScheduleDetail/GetEditInfo` |
| Update item | PUT | `/TravelScheduleDetail/Update` |
| Move/reorder item | PUT | `/TravelScheduleDetail/Sort` |
| Remove item | DELETE | `/TravelScheduleDetail/Delete` |

The adapter rejects every path outside this allowlist.

## p1 item-add flow

The current store defaults `devVersion` to `p1`. In that branch, the official
caller:

1. Reads `/TravelScheduleDetail/GetAddWhere` with the exact query keys
   `poiId`, `travelScheduleId`, and `travelScheduleUpdateTime: 0`.
2. Chooses an opaque `addWhereId` from the target day's `addWhereList`.
3. Posts multipart fields `TravelScheduleId`, one-based `Day`, `PoiId`,
   `AddWhereId`, `TravelScheduleUpdateTime`, optional `TsdCoverMediaId`, and
   `TsdName` to `/TravelScheduleDetail/Add`.
4. Consumes only `data.travelScheduleUpdateTime` from a successful response.

The response does not expose a consumed new-item ID. The adapter therefore
records the target day's existing IDs, appends at the verified `end` gap, then
reads the itinerary back and requires exactly one new ID with the requested
POI ID. If `afterItemId` requests a non-terminal position, the adapter uses the
already mapped same-day `/Sort` contract only after that unique ID is known.
Any missing revision, ambiguous ID diff, or failed readback after `Add` is
indeterminate/partial and permanently spends that preview's write claim.

Item adds require both `CHICTRIP_ENABLE_UNDOCUMENTED_WRITES=1` and the separate
`CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS=1` opt-in.

The `p2` branch is not a write contract: its final submit only validates local
form state, displays a success toast, and closes the dialog without calling an
add endpoint. The side menu can toggle this in memory, but refresh returns to
the `p1` default. The adapter therefore implements the observed p1 API
contract directly and never treats the p2 toast as provider success.

## Create/update form details

Before `AddV2`, the official UI reads `/TravelScheduleUserLabel/Get`, finds the
single item whose lowercase fields satisfy
`name === "未標籤" && isSystem === true`, and sends its `id` as
`TravelScheduleUserLabelId`. The adapter refuses to call `AddV2` if that unique
system label cannot be resolved.

`AddV2` and `UpdateV3` use
`application/x-www-form-urlencoded`. Bundled Axios 1.15.0 serializes arrays
with bracket keys, so destinations are sent as repeated
`LocationKey[]=...` fields. Empty arrays such as `destinationList: []` emit no
wire fields.

## Revision rule

Use the latest returned `updateTime` as the next provider version. Treat `004`
as a hard conflict: do not adopt the newer server version and continue writing.
Read the itinerary again and create a new human-reviewed preview.

Every successful mutation must return a new usable revision. A success envelope
without that revision, a mutation response that cannot be parsed, or a failed
readback is indeterminate and consumes the preview's single write attempt.
Readback comparison includes explicitly requested category and cover values;
an explicit category clear must be absent afterward. Provider-assigned optional
metadata is tolerated only when the approved draft did not specify it.

## Evidence

Primary public bundles inspected:

- `homeStore.7da2b015.js` — SHA-256
  `dac30a6e762267bdc0faae5ecf0c8fff8b758de2b39aa093f5d6599738baa4aa`
- `home.ab9e89ba.js` — SHA-256
  `859aae6890b0d3b8af3a8f7c33e43a7885f174c8af71ba3c6d8e1b179430a176`
- `TravelScheduleSettings.58e12b27.js` — SHA-256
  `2fee2d992c6300cce2162bb9013d7483c9b22336735383909aebee455a3b88`
- `GlobalComponents.b003d79e.js` — SHA-256
  `8d17c47d58b9a52e03b4d03fa91e83ede67878fe24c5654223097798edc5904e`
- `SideMenu.eca1758b.js` — SHA-256
  `b664be95a5c106c46b58dd834b92d753ad5539a4c4c47e80e5f64de14ca4b81c`
- `vue-router.5e1cd1ae.js` — SHA-256
  `237bb7fda1b163519bbd8c8fd8fb9b414b103adca601f270e942c62d387ee78a`

Bundle names are content-addressed and will change when chicTrip deploys a new
frontend.
