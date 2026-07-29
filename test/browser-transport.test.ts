import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import { AppError } from "../src/domain/errors.js";
import { TripDraftSchema } from "../src/domain/schemas.js";
import type { BrowserSession } from "../src/auth/browser-session.js";
import type {
  ProviderApiClient,
  ProviderEnvelope,
  ProviderRequest,
} from "../src/provider/browser-api.js";
import { normalizeTrip } from "../src/provider/normalize.js";
import { BrowserChicTripTransport } from "../src/transport/browser.js";

class StubApi implements ProviderApiClient {
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: ProviderEnvelope[]) {}

  async request<T = unknown>(
    request: ProviderRequest,
  ): Promise<ProviderEnvelope<T>> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) throw new Error(`No stub response for ${request.path}`);
    return response as ProviderEnvelope<T>;
  }
}

function envelope(data: unknown): ProviderEnvelope {
  return { apiStatus: "001", data, message: null };
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    stateDir: "/private/tmp/chictrip-contract-test",
    browserProfileDir: "/private/tmp/chictrip-contract-test/browser",
    browserChannel: "chrome",
    enableUndocumentedWrites: true,
    enableExperimentalItemAdds: true,
    previewTtlMs: 15 * 60_000,
    approvalTtlMs: 5 * 60_000,
    apiBaseUrl: "https://api.chictrip.com.tw/",
    providerClientVersion: "2.0.38",
    siteUrl: "https://www.chictrip.com.tw/landing",
    httpHost: "127.0.0.1",
    httpPort: 3333,
    ...overrides,
  };
}

function session(): BrowserSession {
  return {
    status: async () => ({
      authenticated: true,
      accountRefHash: "account-ref",
    }),
  } as unknown as BrowserSession;
}

const initialSummary = {
  id: "trip-1",
  name: "原行程",
  startDate: "2026/12/01",
  endDate: "2026/12/01",
  updateTime: 100,
  permission: "Owner",
};

const initialDetail = {
  travelScheduleInfo: {
    id: "trip-1",
    name: "原行程",
    coverMediaId: "cover-1",
    startDate: "2026/12/01",
    endDate: "2026/12/01",
    totalDay: 1,
    userLabelId: "label-1",
    trafficType: "Driving",
    updateTime: 100,
    destinationList: [
      {
        locationKey: "7,7,0",
        locationName: "東京",
      },
    ],
    permission: "Owner",
  },
  dayList: [{ day: 1, tsdList: [] }],
};

describe("browser provider write contracts", () => {
  test("creates a trip shell with the observed AddV2 form contract", async () => {
    const api = new StubApi([
      envelope([{ id: "cover-default" }]),
      envelope([
        {
          id: "system-unlabeled",
          name: "未標籤",
          isSystem: true,
          travelScheduleCount: 0,
        },
      ]),
      envelope({
        id: "created-trip",
        name: "東京一日",
        updateTime: 201,
        permission: "Owner",
      }),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const desired = TripDraftSchema.parse({
      title: "東京一日",
      startDate: "2026-12-01",
      endDate: "2026-12-01",
      timezone: "Asia/Tokyo",
      destinations: [
        { providerLocationKey: "7,7,0", name: "東京" },
      ],
      trafficType: "Custom",
      days: [{ date: "2026-12-01", items: [] }],
    });

    const result = await transport.createTrip(desired, {
      requestId: "request-1",
      idempotencyKey: "idempotency-1",
      expectedAccountRefHash: "account-a",
    });

    expect(result).toEqual({
      tripId: "created-trip",
      providerVersion: "201",
      completedSteps: 1,
      totalSteps: 1,
    });
    expect(api.requests).toHaveLength(3);
    expect(api.requests[1]).toMatchObject({
      method: "GET",
      path: "/TravelScheduleUserLabel/Get",
    });
    expect(api.requests[2]).toMatchObject({
      method: "POST",
      path: "/TravelSchedule/AddV2",
      expectedAccountRefHash: "account-a",
      language: "zh-tw",
      bodyEncoding: "form",
      body: {
        CoverMediaId: "cover-default",
        Name: "東京一日",
        StartDate: "2026/12/01",
        EndDate: "2026/12/01",
        TotalDay: 1,
        ViewMode: "DetailMode",
        TravelScheduleUserLabelId: "system-unlabeled",
        id: "",
        TrafficType: "Custom",
        IsForceUpdateTsdRoute: 0,
        updateTime: 0,
        LocationKey: ["7,7,0"],
      },
    });
  });

  test("reads full itinerary context and preserves a hard revision check on UpdateV3", async () => {
    const updatedSummary = {
      ...initialSummary,
      name: "新標題",
      updateTime: 101,
    };
    const updatedDetail = {
      ...structuredClone(initialDetail),
      travelScheduleInfo: {
        ...structuredClone(initialDetail.travelScheduleInfo),
        name: "新標題",
        updateTime: 101,
      },
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope({ updateTime: 100 }),
      envelope({ updateTime: 101 }),
      envelope([updatedSummary]),
      envelope(updatedDetail),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(initialDetail, "trip-1");

    const result = await transport.updateTrip(
      "trip-1",
      [{ op: "set_trip_fields", fields: { title: "新標題" } }],
      {
        requestId: "request-2",
        idempotencyKey: "idempotency-2",
        expectedAccountRefHash: "account-a",
        expectedRevision: initial.revision,
      },
    );

    expect(result).toEqual({
      tripId: "trip-1",
      providerVersion: "101",
      completedSteps: 1,
      totalSteps: 1,
    });
    const detailReads = api.requests.filter(
      (request) => request.path === "/TravelScheduleDetail/Get",
    );
    expect(detailReads).toHaveLength(3);
    for (const request of detailReads) {
      expect(request.query).toMatchObject({
        travelScheduleId: "trip-1",
        travelScheduleName: expect.any(String),
        TravelScheduleUpdateTime: expect.any(String),
        isMyTravelSchedule: 1,
      });
    }

    const verify = api.requests.find(
      (request) =>
        request.path === "/TravelScheduleDetail/VerifyUpdateTime",
    );
    expect(verify).toMatchObject({
      method: "GET",
      query: {
        TravelScheduleId: "trip-1",
        travelScheduleUpdateTime: "100",
      },
    });
    expect(verify?.acceptedStatuses).toBeUndefined();

    const update = api.requests.find(
      (request) => request.path === "/TravelSchedule/UpdateV3",
    );
    expect(update).toMatchObject({
      method: "PUT",
      expectedAccountRefHash: "account-a",
      language: "zh-tw",
      bodyEncoding: "form",
      body: {
        CoverMediaId: "cover-1",
        Name: "新標題",
        StartDate: "2026/12/01",
        EndDate: "2026/12/01",
        TotalDay: 1,
        TravelScheduleUserLabelId: "label-1",
        id: "trip-1",
        TrafficType: "Driving",
        IsForceUpdateTsdRoute: 0,
        updateTime: "100",
        LocationKey: ["7,7,0"],
      },
    });
  });

  test("fails closed before UpdateV3 when revision verification returns no version", async () => {
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope({}),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(initialDetail, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [{ op: "set_trip_fields", fields: { title: "不應送出" } }],
        {
          requestId: "request-missing-version",
          idempotencyKey: "idempotency-missing-version",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_INDETERMINATE" });
    expect(
      api.requests.some(
        (request) => request.path === "/TravelSchedule/UpdateV3",
      ),
    ).toBe(false);
  });

  test("does not send UpdateV3 when VerifyUpdateTime reports a conflict", async () => {
    const requests: ProviderRequest[] = [];
    const api: ProviderApiClient = {
      request: async <T>(request: ProviderRequest) => {
        requests.push(structuredClone(request));
        if (request.path === "/TravelSchedule/GetMyAndCollaboration") {
          return envelope([initialSummary]) as ProviderEnvelope<T>;
        }
        if (request.path === "/TravelScheduleDetail/Get") {
          return envelope(initialDetail) as ProviderEnvelope<T>;
        }
        if (request.path === "/TravelScheduleDetail/VerifyUpdateTime") {
          throw new AppError("CONFLICT", "Provider status 004.");
        }
        throw new Error(`Unexpected provider request: ${request.path}`);
      },
    };
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(initialDetail, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [{ op: "set_trip_fields", fields: { title: "不應送出" } }],
        {
          requestId: "request-provider-conflict",
          idempotencyKey: "idempotency-provider-conflict",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      requests.some((request) => request.path === "/TravelSchedule/UpdateV3"),
    ).toBe(false);
  });

  test("records an accepted UpdateV3 without a revision as indeterminate progress", async () => {
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope({ updateTime: 100 }),
      envelope({}),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(initialDetail, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [{ op: "set_trip_fields", fields: { title: "結果不明" } }],
        {
          requestId: "request-updatev3-missing-result-version",
          idempotencyKey: "idempotency-updatev3-missing-result-version",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_INDETERMINATE",
      details: {
        tripId: "trip-1",
        completedSteps: 1,
        totalSteps: 1,
      },
    });
  });

  test("treats a created trip without a returned revision as indeterminate", async () => {
    const api = new StubApi([
      envelope([{ id: "cover-default" }]),
      envelope([
        {
          id: "system-unlabeled",
          name: "未標籤",
          isSystem: true,
          travelScheduleCount: 0,
        },
      ]),
      envelope({ id: "created-trip" }),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const desired = TripDraftSchema.parse({
      title: "缺少版本",
      startDate: "2026-12-01",
      endDate: "2026-12-01",
      timezone: "Asia/Tokyo",
      destinations: [{ providerLocationKey: "7,7,0", name: "東京" }],
      trafficType: "Custom",
      days: [{ date: "2026-12-01", items: [] }],
    });

    await expect(
      transport.createTrip(desired, {
        requestId: "request-create-missing-version",
        idempotencyKey: "idempotency-create-missing-version",
        expectedAccountRefHash: "account-a",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_INDETERMINATE" });
  });

  test("fails before AddV2 when the unique system unlabeled label is unavailable", async () => {
    const api = new StubApi([
      envelope([{ id: "cover-default" }]),
      envelope([{ id: "other-label", name: "其他", isSystem: false }]),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const desired = TripDraftSchema.parse({
      title: "不應建立",
      startDate: "2026-12-01",
      endDate: "2026-12-01",
      timezone: "Asia/Tokyo",
      destinations: [{ providerLocationKey: "7,7,0", name: "東京" }],
      trafficType: "Custom",
      days: [{ date: "2026-12-01", items: [] }],
    });

    await expect(
      transport.createTrip(desired, {
        requestId: "request-label-missing",
        idempotencyKey: "idempotency-label-missing",
        expectedAccountRefHash: "account-a",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_INDETERMINATE" });
    expect(
      api.requests.some((request) => request.path === "/TravelSchedule/AddV2"),
    ).toBe(false);
  });

  test("keeps item adds behind their separate explicit opt-in", async () => {
    const api = new StubApi([]);
    const transport = new BrowserChicTripTransport(
      session(),
      config({ enableExperimentalItemAdds: false }),
      api,
    );
    const capabilities = await transport.getCapabilities();
    expect(capabilities.write.addItem).toBe(false);

    const desired = TripDraftSchema.parse({
      title: "東京一日",
      startDate: "2026-12-01",
      endDate: "2026-12-01",
      timezone: "Asia/Tokyo",
      destinations: [
        { providerLocationKey: "7,7,0", name: "東京" },
      ],
      trafficType: "Custom",
      days: [
        {
          date: "2026-12-01",
          items: [
            {
              place: {
                providerPlaceId: "poi-tokyo-station",
                name: "東京車站",
              },
            },
          ],
        },
      ],
    });

    await expect(
      transport.createTrip(desired, {
        requestId: "request-add",
        idempotencyKey: "idempotency-add",
        expectedAccountRefHash: "account-a",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(api.requests).toHaveLength(0);
  });

  test("rejects add_item updates when the separate item-add opt-in is disabled", async () => {
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(initialDetail),
    ]);
    const transport = new BrowserChicTripTransport(
      session(),
      config({ enableExperimentalItemAdds: false }),
      api,
    );
    const initial = normalizeTrip(initialDetail, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [
          {
            op: "add_item",
            date: "2026-12-01",
            item: {
              place: {
                providerPlaceId: "poi-tokyo-station",
                name: "東京車站",
              },
            },
          },
        ],
        {
          requestId: "request-update-add",
          idempotencyKey: "idempotency-update-add",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(
      api.requests.some(
        (request) =>
          request.path === "/TravelScheduleDetail/GetAddWhere" ||
          request.path === "/TravelScheduleDetail/Add",
      ),
    ).toBe(false);
  });

  test("adds an item with the observed p1 GetAddWhere and Add contracts", async () => {
    const updatedSummary = { ...initialSummary, updateTime: 101 };
    const updatedDetail = {
      ...structuredClone(initialDetail),
      travelScheduleInfo: {
        ...structuredClone(initialDetail.travelScheduleInfo),
        updateTime: 101,
      },
      dayList: [
        {
          day: 1,
          tsdList: [
            {
              id: "item-new",
              poiId: "poi-tokyo-station",
              name: "東京車站",
            },
          ],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope({
        dayList: [
          {
            day: 1,
            addWhereList: [
              {
                addWhereId: "end",
                isBestOfAll: true,
                departureTsdSort: null,
                arrivalTsdSort: null,
              },
            ],
          },
        ],
      }),
      envelope({ travelScheduleUpdateTime: 101 }),
      envelope([updatedSummary]),
      envelope(updatedDetail),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(initialDetail, "trip-1");

    const result = await transport.updateTrip(
      "trip-1",
      [
        {
          op: "add_item",
          date: "2026-12-01",
          item: {
            place: {
              providerPlaceId: "poi-tokyo-station",
              name: "東京車站",
              coverMediaId: "cover-tokyo-station",
            },
          },
        },
      ],
      {
        requestId: "request-p1-add",
        idempotencyKey: "idempotency-p1-add",
        expectedAccountRefHash: "account-a",
        expectedRevision: initial.revision,
      },
    );

    expect(result).toEqual({
      tripId: "trip-1",
      providerVersion: "101",
      completedSteps: 1,
      totalSteps: 1,
    });
    expect(
      api.requests.find(
        (request) => request.path === "/TravelScheduleDetail/GetAddWhere",
      ),
    ).toMatchObject({
      method: "GET",
      query: {
        poiId: "poi-tokyo-station",
        travelScheduleId: "trip-1",
        travelScheduleUpdateTime: 0,
      },
    });
    expect(
      api.requests.find(
        (request) => request.path === "/TravelScheduleDetail/Add",
      ),
    ).toMatchObject({
      method: "POST",
      expectedAccountRefHash: "account-a",
      bodyEncoding: "multipart",
      body: {
        TravelScheduleId: "trip-1",
        Day: 1,
        PoiId: "poi-tokyo-station",
        AddWhereId: "end",
        TravelScheduleUpdateTime: "100",
        TsdCoverMediaId: "cover-tokyo-station",
        TsdName: "東京車站",
      },
    });
  });

  test("treats an accepted Add without a returned revision as indeterminate", async () => {
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope({
        dayList: [
          {
            day: 1,
            addWhereList: [{ addWhereId: "end" }],
          },
        ],
      }),
      envelope({}),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(initialDetail, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [
          {
            op: "add_item",
            date: "2026-12-01",
            item: {
              place: {
                providerPlaceId: "poi-1",
                name: "景點一",
              },
            },
          },
        ],
        {
          requestId: "request-add-missing-revision",
          idempotencyKey: "idempotency-add-missing-revision",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_INDETERMINATE",
      details: {
        tripId: "trip-1",
        completedSteps: 1,
        totalSteps: 1,
      },
    });
    expect(api.requests).toHaveLength(4);
  });

  test("treats a failed readback after an accepted Add as indeterminate", async () => {
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope({
        dayList: [
          {
            day: 1,
            addWhereList: [{ addWhereId: "end" }],
          },
        ],
      }),
      envelope({ travelScheduleUpdateTime: 101 }),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(initialDetail, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [
          {
            op: "add_item",
            date: "2026-12-01",
            item: {
              place: {
                providerPlaceId: "poi-1",
                name: "景點一",
              },
            },
          },
        ],
        {
          requestId: "request-add-readback-failure",
          idempotencyKey: "idempotency-add-readback-failure",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_INDETERMINATE",
      details: {
        tripId: "trip-1",
        completedSteps: 1,
        totalSteps: 1,
      },
    });
  });

  test("preserves accepted progress when Add follow-up Update lacks a revision", async () => {
    const detailAfterAdd = {
      ...structuredClone(initialDetail),
      travelScheduleInfo: {
        ...structuredClone(initialDetail.travelScheduleInfo),
        updateTime: 101,
      },
      dayList: [
        {
          day: 1,
          tsdList: [
            {
              id: "item-new",
              poiId: "poi-new",
              name: "新景點",
              stayTime: 0,
            },
          ],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(initialDetail),
      envelope({
        dayList: [
          { day: 1, addWhereList: [{ addWhereId: "end" }] },
        ],
      }),
      envelope({ travelScheduleUpdateTime: 101 }),
      envelope([{ ...initialSummary, updateTime: 101 }]),
      envelope(detailAfterAdd),
      envelope(detailAfterAdd.dayList[0]?.tsdList[0]),
      envelope({}),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(initialDetail, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [
          {
            op: "add_item",
            date: "2026-12-01",
            item: {
              place: { providerPlaceId: "poi-new", name: "新景點" },
              durationMinutes: 90,
            },
          },
        ],
        {
          requestId: "request-add-update-missing-revision",
          idempotencyKey: "idempotency-add-update-missing-revision",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_INDETERMINATE",
      details: {
        tripId: "trip-1",
        completedSteps: 2,
        totalSteps: 2,
      },
    });
  });

  test("reads back the new item ID and sorts it after an explicit anchor", async () => {
    const detailWithItems = {
      ...structuredClone(initialDetail),
      dayList: [
        {
          day: 1,
          tsdList: [
            { id: "item-a", poiId: "poi-a", name: "景點 A" },
            { id: "item-b", poiId: "poi-b", name: "景點 B" },
          ],
        },
      ],
    };
    const detailAfterAdd = {
      ...structuredClone(detailWithItems),
      travelScheduleInfo: {
        ...structuredClone(detailWithItems.travelScheduleInfo),
        updateTime: 101,
      },
      dayList: [
        {
          day: 1,
          tsdList: [
            { id: "item-a", poiId: "poi-a", name: "景點 A" },
            { id: "item-b", poiId: "poi-b", name: "景點 B" },
            { id: "item-new", poiId: "poi-new", name: "新景點" },
          ],
        },
      ],
    };
    const detailAfterSort = {
      ...structuredClone(detailAfterAdd),
      travelScheduleInfo: {
        ...structuredClone(detailAfterAdd.travelScheduleInfo),
        updateTime: 102,
      },
      dayList: [
        {
          day: 1,
          tsdList: [
            { id: "item-a", poiId: "poi-a", name: "景點 A" },
            { id: "item-new", poiId: "poi-new", name: "新景點" },
            { id: "item-b", poiId: "poi-b", name: "景點 B" },
          ],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(detailWithItems),
      envelope({
        dayList: [
          { day: 1, addWhereList: [{ addWhereId: "end" }] },
        ],
      }),
      envelope({ travelScheduleUpdateTime: 101 }),
      envelope([{ ...initialSummary, updateTime: 101 }]),
      envelope(detailAfterAdd),
      envelope(102),
      envelope([{ ...initialSummary, updateTime: 102 }]),
      envelope(detailAfterSort),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(detailWithItems, "trip-1");

    const result = await transport.updateTrip(
      "trip-1",
      [
        {
          op: "add_item",
          date: "2026-12-01",
          afterItemId: "item-a",
          item: {
            place: {
              providerPlaceId: "poi-new",
              name: "新景點",
            },
          },
        },
      ],
      {
        requestId: "request-add-and-sort",
        idempotencyKey: "idempotency-add-and-sort",
        expectedAccountRefHash: "account-a",
        expectedRevision: initial.revision,
      },
    );

    expect(result).toEqual({
      tripId: "trip-1",
      providerVersion: "102",
      completedSteps: 2,
      totalSteps: 2,
    });
    expect(
      api.requests.find(
        (request) => request.path === "/TravelScheduleDetail/Sort",
      ),
    ).toMatchObject({
      expectedAccountRefHash: "account-a",
      body: {
        TravelScheduleId: "trip-1",
        MoveOutDay: 1,
        MoveInDay: 1,
        MoveTsdId: "item-new",
        TsdIdList: ["item-a", "item-new", "item-b"],
        travelScheduleUpdateTime: "101",
      },
    });
  });

  test("preserves accepted progress when Add follow-up Sort lacks a revision", async () => {
    const detailWithItems = {
      ...structuredClone(initialDetail),
      dayList: [
        {
          day: 1,
          tsdList: [
            { id: "item-a", poiId: "poi-a", name: "景點 A" },
            { id: "item-b", poiId: "poi-b", name: "景點 B" },
          ],
        },
      ],
    };
    const detailAfterAdd = {
      ...structuredClone(detailWithItems),
      travelScheduleInfo: {
        ...structuredClone(detailWithItems.travelScheduleInfo),
        updateTime: 101,
      },
      dayList: [
        {
          day: 1,
          tsdList: [
            { id: "item-a", poiId: "poi-a", name: "景點 A" },
            { id: "item-b", poiId: "poi-b", name: "景點 B" },
            { id: "item-new", poiId: "poi-new", name: "新景點" },
          ],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(detailWithItems),
      envelope({
        dayList: [
          { day: 1, addWhereList: [{ addWhereId: "end" }] },
        ],
      }),
      envelope({ travelScheduleUpdateTime: 101 }),
      envelope([{ ...initialSummary, updateTime: 101 }]),
      envelope(detailAfterAdd),
      envelope({}),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(detailWithItems, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [
          {
            op: "add_item",
            date: "2026-12-01",
            afterItemId: "item-a",
            item: { place: { providerPlaceId: "poi-new", name: "新景點" } },
          },
        ],
        {
          requestId: "request-add-sort-missing-revision",
          idempotencyKey: "idempotency-add-sort-missing-revision",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_INDETERMINATE",
      details: {
        tripId: "trip-1",
        completedSteps: 2,
        totalSteps: 2,
      },
    });
  });

  test("creates a trip and then appends its planned items", async () => {
    const createdSummary = {
      ...initialSummary,
      id: "created-trip",
      name: "東京一日",
      updateTime: 201,
    };
    const createdShell = {
      ...structuredClone(initialDetail),
      travelScheduleInfo: {
        ...structuredClone(initialDetail.travelScheduleInfo),
        id: "created-trip",
        name: "東京一日",
        updateTime: 201,
      },
    };
    const createdWithItem = {
      ...structuredClone(createdShell),
      travelScheduleInfo: {
        ...structuredClone(createdShell.travelScheduleInfo),
        updateTime: 202,
      },
      dayList: [
        {
          day: 1,
          tsdList: [
            {
              id: "created-item",
              poiId: "poi-tokyo-station",
              name: "東京車站",
            },
          ],
        },
      ],
    };
    const api = new StubApi([
      envelope([{ id: "cover-default" }]),
      envelope([
        { id: "system-unlabeled", name: "未標籤", isSystem: true },
      ]),
      envelope({ id: "created-trip", updateTime: 201 }),
      envelope([createdSummary]),
      envelope(createdShell),
      envelope({
        dayList: [
          { day: 1, addWhereList: [{ addWhereId: "end" }] },
        ],
      }),
      envelope({ travelScheduleUpdateTime: 202 }),
      envelope([{ ...createdSummary, updateTime: 202 }]),
      envelope(createdWithItem),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const desired = TripDraftSchema.parse({
      title: "東京一日",
      startDate: "2026-12-01",
      endDate: "2026-12-01",
      timezone: "Asia/Tokyo",
      destinations: [{ providerLocationKey: "7,7,0", name: "東京" }],
      trafficType: "Custom",
      days: [
        {
          date: "2026-12-01",
          items: [
            {
              place: {
                providerPlaceId: "poi-tokyo-station",
                name: "東京車站",
              },
            },
          ],
        },
      ],
    });

    const result = await transport.createTrip(desired, {
      requestId: "request-create-with-item",
      idempotencyKey: "idempotency-create-with-item",
      expectedAccountRefHash: "account-a",
    });

    expect(result).toEqual({
      tripId: "created-trip",
      providerVersion: "202",
      completedSteps: 2,
      totalSteps: 2,
    });
    expect(
      api.requests.filter(
        (request) =>
          request.path === "/TravelSchedule/AddV2" ||
          request.path === "/TravelScheduleDetail/Add",
      ),
    ).toHaveLength(2);
  });

  test("rejects cross-day moves without sending Sort", async () => {
    const twoDaySummary = {
      ...initialSummary,
      endDate: "2026/12/02",
    };
    const twoDayDetail = {
      ...structuredClone(initialDetail),
      travelScheduleInfo: {
        ...structuredClone(initialDetail.travelScheduleInfo),
        endDate: "2026/12/02",
        totalDay: 2,
      },
      dayList: [
        {
          day: 1,
          tsdList: [{ id: "item-1", poiId: "poi-1", name: "景點一" }],
        },
        {
          day: 2,
          tsdList: [{ id: "item-2", poiId: "poi-2", name: "景點二" }],
        },
      ],
    };
    const api = new StubApi([
      envelope([twoDaySummary]),
      envelope(twoDayDetail),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(twoDayDetail, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [
          {
            op: "move_item",
            itemId: "item-1",
            toDate: "2026-12-02",
          },
        ],
        {
          requestId: "request-cross-day-move",
          idempotencyKey: "idempotency-cross-day-move",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(
      api.requests.some(
        (request) => request.path === "/TravelScheduleDetail/Sort",
      ),
    ).toBe(false);
  });

  test("sorts within one day using the complete provider item ID order", async () => {
    const detailWithItems = {
      ...structuredClone(initialDetail),
      dayList: [
        {
          day: 1,
          tsdList: [
            { id: "item-a", poiId: "poi-a", name: "景點 A" },
            { id: "item-b", poiId: "poi-b", name: "景點 B" },
            { id: "item-c", poiId: "poi-c", name: "景點 C" },
          ],
        },
      ],
    };
    const updatedDetail = {
      ...structuredClone(detailWithItems),
      travelScheduleInfo: {
        ...structuredClone(detailWithItems.travelScheduleInfo),
        updateTime: 101,
      },
      dayList: [
        {
          day: 1,
          tsdList: [
            { id: "item-a", poiId: "poi-a", name: "景點 A" },
            { id: "item-c", poiId: "poi-c", name: "景點 C" },
            { id: "item-b", poiId: "poi-b", name: "景點 B" },
          ],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(detailWithItems),
      envelope(101),
      envelope([{ ...initialSummary, updateTime: 101 }]),
      envelope(updatedDetail),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(detailWithItems, "trip-1");

    const result = await transport.updateTrip(
      "trip-1",
      [
        {
          op: "move_item",
          itemId: "item-b",
          toDate: "2026-12-01",
          afterItemId: "item-c",
        },
      ],
      {
        requestId: "request-same-day-sort",
        idempotencyKey: "idempotency-same-day-sort",
        expectedAccountRefHash: "account-a",
        expectedRevision: initial.revision,
      },
    );

    expect(result).toMatchObject({
      providerVersion: "101",
      completedSteps: 1,
      totalSteps: 1,
    });
    expect(
      api.requests.find(
        (request) => request.path === "/TravelScheduleDetail/Sort",
      ),
    ).toMatchObject({
      method: "PUT",
      bodyEncoding: "multipart",
      body: {
        TravelScheduleId: "trip-1",
        MoveOutDay: 1,
        MoveInDay: 1,
        MoveTsdId: "item-b",
        TsdIdList: ["item-a", "item-c", "item-b"],
        travelScheduleUpdateTime: "100",
      },
    });
  });

  test("rejects same-day sorting when any target item lacks a provider ID", async () => {
    const detailWithMissingId = {
      ...structuredClone(initialDetail),
      dayList: [
        {
          day: 1,
          tsdList: [
            { id: "item-1", poiId: "poi-1", name: "景點一" },
            { poiId: "poi-unknown", name: "缺少識別碼的景點" },
          ],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(detailWithMissingId),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(detailWithMissingId, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [
          {
            op: "move_item",
            itemId: "item-1",
            toDate: "2026-12-01",
          },
        ],
        {
          requestId: "request-missing-id-sort",
          idempotencyKey: "idempotency-missing-id-sort",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_INDETERMINATE" });
    expect(
      api.requests.some(
        (request) => request.path === "/TravelScheduleDetail/Sort",
      ),
    ).toBe(false);
  });

  test("records an accepted item Update without a revision as indeterminate progress", async () => {
    const item = {
      id: "item-1",
      poiId: "poi-1",
      name: "原景點",
      stayTime: 60,
    };
    const detailWithItem = {
      ...structuredClone(initialDetail),
      dayList: [{ day: 1, tsdList: [item] }],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(detailWithItem),
      envelope(item),
      envelope({}),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(detailWithItem, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [
          {
            op: "update_item",
            itemId: "item-1",
            fields: { name: "結果不明" },
          },
        ],
        {
          requestId: "request-item-update-missing-revision",
          idempotencyKey: "idempotency-item-update-missing-revision",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_INDETERMINATE",
      details: {
        tripId: "trip-1",
        completedSteps: 1,
        totalSteps: 1,
      },
    });
  });

  test("records an accepted item Delete without a revision as indeterminate progress", async () => {
    const detailWithItem = {
      ...structuredClone(initialDetail),
      dayList: [
        {
          day: 1,
          tsdList: [{ id: "item-1", poiId: "poi-1", name: "景點一" }],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(detailWithItem),
      envelope({}),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(detailWithItem, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [{ op: "remove_item", itemId: "item-1" }],
        {
          requestId: "request-item-delete-missing-revision",
          idempotencyKey: "idempotency-item-delete-missing-revision",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_INDETERMINATE",
      details: {
        tripId: "trip-1",
        completedSteps: 1,
        totalSteps: 1,
      },
    });
  });

  test("records an accepted Sort without a revision as indeterminate progress", async () => {
    const detailWithItems = {
      ...structuredClone(initialDetail),
      dayList: [
        {
          day: 1,
          tsdList: [
            { id: "item-a", poiId: "poi-a", name: "景點 A" },
            { id: "item-b", poiId: "poi-b", name: "景點 B" },
          ],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(detailWithItems),
      envelope({}),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(detailWithItems, "trip-1");

    await expect(
      transport.updateTrip(
        "trip-1",
        [
          {
            op: "move_item",
            itemId: "item-a",
            toDate: "2026-12-01",
            afterItemId: "item-b",
          },
        ],
        {
          requestId: "request-sort-missing-revision",
          idempotencyKey: "idempotency-sort-missing-revision",
          expectedAccountRefHash: "account-a",
          expectedRevision: initial.revision,
        },
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_INDETERMINATE",
      details: {
        tripId: "trip-1",
        completedSteps: 1,
        totalSteps: 1,
      },
    });
  });

  test("updates item fields with floating local time and current revision", async () => {
    const item = {
      id: "item-1",
      poiId: "poi-1",
      name: "原景點",
      stayTime: 60,
      isUseCustomArrivalTime: false,
      isUseCustomDepartureTime: false,
      poiClassificationId: "cat-1",
    };
    const detailWithItem = {
      ...structuredClone(initialDetail),
      dayList: [{ day: 1, tsdList: [item] }],
    };
    const updatedDetail = {
      ...structuredClone(detailWithItem),
      travelScheduleInfo: {
        ...structuredClone(detailWithItem.travelScheduleInfo),
        updateTime: 101,
      },
      dayList: [
        {
          day: 1,
          tsdList: [
            {
              ...item,
              name: "新景點",
              stayTime: 90,
              isUseCustomArrivalTime: true,
              customArrivalTime: "0001/01/01 09:00:00",
              poiClassificationId: "cat-2",
            },
          ],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(detailWithItem),
      envelope(item),
      envelope(101),
      envelope([{ ...initialSummary, updateTime: 101 }]),
      envelope(updatedDetail),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(detailWithItem, "trip-1");

    const result = await transport.updateTrip(
      "trip-1",
      [
        {
          op: "update_item",
          itemId: "item-1",
          fields: {
            name: "新景點",
            durationMinutes: 90,
            startsAt: "2026-12-01T09:00:00+09:00",
            categoryId: "cat-2",
          },
        },
      ],
      {
        requestId: "request-item-update",
        idempotencyKey: "idempotency-item-update",
        expectedAccountRefHash: "account-a",
        expectedRevision: initial.revision,
      },
    );

    expect(result).toMatchObject({
      tripId: "trip-1",
      providerVersion: "101",
      completedSteps: 1,
      totalSteps: 1,
    });
    expect(
      api.requests.find(
        (request) => request.path === "/TravelScheduleDetail/Update",
      ),
    ).toMatchObject({
      method: "PUT",
      bodyEncoding: "multipart",
      body: {
        TsdId: "item-1",
        Name: "新景點",
        PoiClassificationId: "cat-2",
        StayTime: 90,
        IsUseCustomArrivalTime: 1,
        CustomArrivalTime: "0001/01/01 09:00:00",
        IsUseCustomDepartureTime: 0,
        CustomDepartureTime: "",
        TravelScheduleId: "trip-1",
        travelScheduleUpdateTime: "100",
      },
    });
  });

  test("preserves and normalizes existing arrival and departure times on a name-only update", async () => {
    const item = {
      id: "item-1",
      poiId: "poi-1",
      name: "原景點",
      stayTime: 60,
      isUseCustomArrivalTime: 1,
      customArrivalTime: "09:30",
      isUseCustomDepartureTime: 1,
      departureTime: "11:00",
      poiClassificationId: "cat-1",
    };
    const detailWithItem = {
      ...structuredClone(initialDetail),
      dayList: [{ day: 1, tsdList: [item] }],
    };
    const updatedDetail = {
      ...structuredClone(detailWithItem),
      travelScheduleInfo: {
        ...structuredClone(detailWithItem.travelScheduleInfo),
        updateTime: 101,
      },
      dayList: [
        {
          day: 1,
          tsdList: [{ ...item, name: "只改名稱" }],
        },
      ],
    };
    const api = new StubApi([
      envelope([initialSummary]),
      envelope(detailWithItem),
      envelope(item),
      envelope(101),
      envelope([{ ...initialSummary, updateTime: 101 }]),
      envelope(updatedDetail),
    ]);
    const transport = new BrowserChicTripTransport(session(), config(), api);
    const initial = normalizeTrip(detailWithItem, "trip-1");

    await transport.updateTrip(
      "trip-1",
      [
        {
          op: "update_item",
          itemId: "item-1",
          fields: { name: "只改名稱" },
        },
      ],
      {
        requestId: "request-preserve-times",
        idempotencyKey: "idempotency-preserve-times",
        expectedAccountRefHash: "account-a",
        expectedRevision: initial.revision,
      },
    );

    expect(
      api.requests.find(
        (request) => request.path === "/TravelScheduleDetail/Update",
      ),
    ).toMatchObject({
      expectedAccountRefHash: "account-a",
      body: {
        Name: "只改名稱",
        IsUseCustomArrivalTime: 1,
        CustomArrivalTime: "0001/01/01 09:30:00",
        IsUseCustomDepartureTime: 1,
        CustomDepartureTime: "0001/01/01 11:00:00",
      },
    });
  });
});
