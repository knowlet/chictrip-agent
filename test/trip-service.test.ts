import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../src/config.js";
import { tripContentHash } from "../src/domain/canonical.js";
import { AppError } from "../src/domain/errors.js";
import {
  TripDraftSchema,
  TripRecordSchema,
  type Destination,
  type ListTripsInput,
  type PlaceRef,
  type SearchDestinationsInput,
  type SearchPlacesInput,
  type TripDraft,
  type TripPatchOperation,
  type TripRecord,
  type TripSummary,
} from "../src/domain/schemas.js";
import type {
  ChicTripTransport,
  MutationContext,
  ProviderMutationResult,
  TransportCapabilities,
} from "../src/domain/types.js";
import { TripService } from "../src/service/trip-service.js";
import { ApprovalService } from "../src/state/approval.js";
import { JsonStateStore } from "../src/state/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function draft(overrides: Partial<TripDraft> = {}): TripDraft {
  return TripDraftSchema.parse({
    title: "東京三日",
    startDate: "2026-10-01",
    endDate: "2026-10-03",
    timezone: "Asia/Tokyo",
    destinations: [
      { providerLocationKey: "jp-tokyo", name: "東京" },
    ],
    trafficType: "Custom",
    days: [
      { date: "2026-10-01", items: [] },
      { date: "2026-10-02", items: [] },
      { date: "2026-10-03", items: [] },
    ],
    ...overrides,
  });
}

function record(id: string, desired: TripDraft, version = "1"): TripRecord {
  const base = {
    ...structuredClone(desired),
    id,
    ownership: "owned" as const,
    permission: "owner" as const,
  };
  return TripRecordSchema.parse({
    ...base,
    revision: {
      providerVersion: version,
      contentHash: tripContentHash(base),
      readAt: new Date().toISOString(),
    },
  });
}

function capabilities(accountRefHash = "account-a"): TransportCapabilities {
  return {
    transport: "browser",
    supportLevel: "experimental-undocumented",
    authenticated: true,
    accountRefHash,
    read: {
      listTrips: true,
      getTrip: true,
      searchPlaces: true,
      searchDestinations: true,
    },
    write: {
      createTrip: true,
      updateTripFields: true,
      addItem: true,
      updateItem: true,
      moveItem: true,
      removeItem: true,
      deleteTrip: false,
      requiresApproval: true,
      idempotency: "local-ledger",
      atomicity: "multi-step",
    },
    caveats: [],
  };
}

class MockTransport implements ChicTripTransport {
  readonly kind = "browser" as const;
  currentCapabilities = capabilities();
  readonly trips = new Map<string, TripRecord>();
  createCalls = 0;
  updateCalls = 0;
  createError: unknown;
  omitCreatedTripFromReadback = false;
  applyCategoryUpdates = false;

  async getCapabilities(): Promise<TransportCapabilities> {
    return this.currentCapabilities;
  }

  async listTrips(_input: ListTripsInput): Promise<TripSummary[]> {
    return [...this.trips.values()].map((trip) => ({
      id: trip.id,
      title: trip.title,
      startDate: trip.startDate,
      endDate: trip.endDate,
      ownership: trip.ownership,
      permission: trip.permission,
      destinationNames: trip.destinations.map((destination) => destination.name),
      providerVersion: trip.revision.providerVersion,
    }));
  }

  async getTrip(tripId: string): Promise<TripRecord> {
    const trip = this.trips.get(tripId);
    if (!trip) throw new AppError("NOT_FOUND", `Trip not found: ${tripId}`);
    return structuredClone(trip);
  }

  async searchPlaces(_input: SearchPlacesInput): Promise<PlaceRef[]> {
    return [];
  }

  async searchDestinations(
    _input: SearchDestinationsInput,
  ): Promise<Destination[]> {
    return [];
  }

  async createTrip(
    input: TripDraft,
    _context: MutationContext,
  ): Promise<ProviderMutationResult> {
    this.createCalls += 1;
    if (this.createError) throw this.createError;
    const id = `trip-${this.createCalls}`;
    const withProviderIds = structuredClone(input);
    for (const [dayIndex, day] of withProviderIds.days.entries()) {
      for (const [itemIndex, item] of day.items.entries()) {
        item.id = `provider-${dayIndex}-${itemIndex}`;
        item.durationMinutes ??= 0;
      }
    }
    if (!this.omitCreatedTripFromReadback) {
      this.trips.set(id, record(id, withProviderIds, String(this.createCalls)));
    }
    return {
      tripId: id,
      providerVersion: String(this.createCalls),
      completedSteps: 1,
      totalSteps: 1,
    };
  }

  async updateTrip(
    tripId: string,
    operations: TripPatchOperation[],
    _context: MutationContext,
  ): Promise<ProviderMutationResult> {
    this.updateCalls += 1;
    const existing = await this.getTrip(tripId);
    const desired = draft({
      title: existing.title,
      startDate: existing.startDate,
      endDate: existing.endDate,
      timezone: existing.timezone,
      destinations: existing.destinations,
      trafficType: existing.trafficType,
      days: existing.days,
    });
    for (const operation of operations) {
      if (operation.op === "set_trip_fields") {
        Object.assign(desired, operation.fields);
      } else if (
        this.applyCategoryUpdates &&
        operation.op === "update_item" &&
        operation.fields.categoryId !== undefined
      ) {
        const item = desired.days
          .flatMap((day) => day.items)
          .find((candidate) => candidate.id === operation.itemId);
        if (item) {
          if (operation.fields.categoryId === null) {
            delete item.categoryId;
          } else {
            item.categoryId = operation.fields.categoryId;
          }
        }
      }
    }
    this.trips.set(
      tripId,
      record(tripId, desired, String(Number(existing.revision.providerVersion) + 1)),
    );
    const providerVersion = this.trips.get(tripId)?.revision.providerVersion;
    return {
      tripId,
      ...(providerVersion ? { providerVersion } : {}),
      completedSteps: operations.length,
      totalSteps: operations.length,
    };
  }
}

async function harness(transport = new MockTransport()) {
  const stateDir = await mkdtemp(join(tmpdir(), "chictrip-agent-test-"));
  temporaryDirectories.push(stateDir);
  const config: AppConfig = {
    stateDir,
    browserProfileDir: join(stateDir, "browser"),
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
  };
  const store = new JsonStateStore(stateDir);
  const approval = new ApprovalService(store, config.approvalTtlMs);
  const service = new TripService(transport, store, approval, config);
  return { transport, store, service };
}

describe("TripService safety boundary", () => {
  test("preview performs no provider write", async () => {
    const { service, transport } = await harness();
    const preview = await service.preview({ kind: "create", desired: draft() });

    expect(preview.diff).toHaveLength(1);
    expect(preview.blockers).toEqual([]);
    expect(transport.createCalls).toBe(0);
    expect(transport.updateCalls).toBe(0);
  });

  test("previews a create plan with item adds and counts only provider writes", async () => {
    const { service, transport } = await harness();
    const desired = draft({
      days: [
        {
          date: "2026-10-01",
          items: [
            {
              place: { providerPlaceId: "poi-1", name: "東京車站" },
              startsAt: "2026-10-01T09:00:00+09:00",
              durationMinutes: 90,
            },
          ],
        },
        { date: "2026-10-02", items: [] },
        { date: "2026-10-03", items: [] },
      ],
    });

    const preview = await service.preview({ kind: "create", desired });

    expect(preview.blockers).toEqual([]);
    expect(preview.estimatedProviderWrites).toBe(3);
    expect(transport.createCalls).toBe(0);
  });

  test("blocks item-add previews when the transport has not opted in", async () => {
    const transport = new MockTransport();
    transport.currentCapabilities = {
      ...transport.currentCapabilities,
      write: {
        ...transport.currentCapabilities.write,
        addItem: false,
      },
    };
    const { service } = await harness(transport);
    const desired = draft({
      days: [
        {
          date: "2026-10-01",
          items: [
            {
              place: { providerPlaceId: "poi-1", name: "東京車站" },
            },
          ],
        },
        { date: "2026-10-02", items: [] },
        { date: "2026-10-03", items: [] },
      ],
    });

    const preview = await service.preview({ kind: "create", desired });

    expect(preview.blockers).toContainEqual(
      expect.objectContaining({ code: "ADD_ITEM_DISABLED" }),
    );
  });

  test("apply requires an approval grant recorded by the interactive CLI", async () => {
    const { service, transport } = await harness();
    const preview = await service.preview({ kind: "create", desired: draft() });

    await expect(
      service.apply({
        previewId: preview.previewId,
        intentHash: preview.intentHash,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(transport.createCalls).toBe(0);
  });

  test("approval plus apply writes once and an identical retry is idempotent", async () => {
    const { service, transport } = await harness();
    const desired = draft({
      days: [
        {
          date: "2026-10-01",
          items: [
            {
              place: { providerPlaceId: "poi-1", name: "東京車站" },
            },
          ],
        },
        { date: "2026-10-02", items: [] },
        { date: "2026-10-03", items: [] },
      ],
    });
    const preview = await service.preview({ kind: "create", desired });
    await service.approve(
      preview.previewId,
      `APPLY ${preview.approval.reviewCode}`,
    );
    const request = {
      previewId: preview.previewId,
      intentHash: preview.intentHash,
      idempotencyKey: randomUUID(),
    };

    const first = await service.apply(request);
    const retry = await service.apply(request);

    expect(first.status).toBe("applied");
    expect(retry.status).toBe("already_applied");
    await expect(
      service.apply({
        ...request,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(transport.createCalls).toBe(1);
  });

  test("atomically allows only one write attempt for two approvals and two keys", async () => {
    const { service, transport } = await harness();
    const preview = await service.preview({ kind: "create", desired: draft() });
    const confirmation = `APPLY ${preview.approval.reviewCode}`;
    await Promise.all([
      service.approve(preview.previewId, confirmation),
      service.approve(preview.previewId, confirmation),
    ]);

    const attempts = await Promise.allSettled([
      service.apply({
        previewId: preview.previewId,
        intentHash: preview.intentHash,
        idempotencyKey: randomUUID(),
      }),
      service.apply({
        previewId: preview.previewId,
        intentHash: preview.intentHash,
        idempotencyKey: randomUUID(),
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(transport.createCalls).toBe(1);
  });

  test("rejects a stored intent changed after approval without writing", async () => {
    const { service, store, transport } = await harness();
    const preview = await service.preview({ kind: "create", desired: draft() });
    await service.approve(
      preview.previewId,
      `APPLY ${preview.approval.reviewCode}`,
    );
    await store.update((state) => {
      const stored = state.previews[preview.previewId];
      if (stored?.intent.kind === "create") {
        stored.intent.desired.title = "未經核准的標題";
      }
    });

    await expect(
      service.apply({
        previewId: preview.previewId,
        intentHash: preview.intentHash,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(transport.createCalls).toBe(0);
  });

  test("stale update is rejected before any provider write", async () => {
    const transport = new MockTransport();
    const original = record("trip-existing", draft(), "1");
    transport.trips.set(original.id, original);
    const { service } = await harness(transport);
    const preview = await service.preview({
      kind: "update",
      tripId: original.id,
      baseRevision: original.revision,
      operations: [{ op: "set_trip_fields", fields: { title: "新標題" } }],
    });
    await service.approve(
      preview.previewId,
      `APPLY ${preview.approval.reviewCode}`,
    );
    transport.trips.set(original.id, record(original.id, draft({ title: "協作者修改" }), "2"));

    await expect(
      service.apply({
        previewId: preview.previewId,
        intentHash: preview.intentHash,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(transport.updateCalls).toBe(0);
  });

  test("approval is bound to the authenticated account", async () => {
    const transport = new MockTransport();
    const { service } = await harness(transport);
    const preview = await service.preview({ kind: "create", desired: draft() });
    await service.approve(
      preview.previewId,
      `APPLY ${preview.approval.reviewCode}`,
    );
    transport.currentCapabilities = capabilities("account-b");

    await expect(
      service.apply({
        previewId: preview.previewId,
        intentHash: preview.intentHash,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(transport.createCalls).toBe(0);
  });

  test("a provider write error is recorded as indeterminate, not safe to retry", async () => {
    const transport = new MockTransport();
    transport.createError = new AppError(
      "PROVIDER_ERROR",
      "Upstream connection ended during the write.",
    );
    const { service } = await harness(transport);
    const preview = await service.preview({ kind: "create", desired: draft() });
    const confirmation = `APPLY ${preview.approval.reviewCode}`;
    await service.approve(preview.previewId, confirmation);

    const result = await service.apply({
      previewId: preview.previewId,
      intentHash: preview.intentHash,
      idempotencyKey: randomUUID(),
    });

    expect(result.status).toBe("indeterminate");
    await expect(
      service.apply({
        previewId: preview.previewId,
        intentHash: preview.intentHash,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(transport.createCalls).toBe(1);
  });

  test("a failed readback after the provider mutation returns is indeterminate", async () => {
    const transport = new MockTransport();
    transport.omitCreatedTripFromReadback = true;
    const { service } = await harness(transport);
    const preview = await service.preview({ kind: "create", desired: draft() });
    await service.approve(
      preview.previewId,
      `APPLY ${preview.approval.reviewCode}`,
    );

    const result = await service.apply({
      previewId: preview.previewId,
      intentHash: preview.intentHash,
      idempotencyKey: randomUUID(),
    });

    expect(result.status).toBe("indeterminate");
    expect(result.reconciliation?.state).toBe("ambiguous");
    expect(transport.createCalls).toBe(1);
  });

  test("does not report applied when the provider ignores a category-only update", async () => {
    const transport = new MockTransport();
    const existing = record(
      "trip-category",
      draft({
        days: [
          {
            date: "2026-10-01",
            items: [
              {
                id: "item-1",
                place: { providerPlaceId: "poi-1", name: "東京車站" },
                categoryId: "category-before",
              },
            ],
          },
          { date: "2026-10-02", items: [] },
          { date: "2026-10-03", items: [] },
        ],
      }),
    );
    transport.trips.set(existing.id, existing);
    const { service } = await harness(transport);
    const preview = await service.preview({
      kind: "update",
      tripId: existing.id,
      baseRevision: existing.revision,
      operations: [
        {
          op: "update_item",
          itemId: "item-1",
          fields: { categoryId: "category-requested" },
        },
      ],
    });
    await service.approve(
      preview.previewId,
      `APPLY ${preview.approval.reviewCode}`,
    );

    const result = await service.apply({
      previewId: preview.previewId,
      intentHash: preview.intentHash,
      idempotencyKey: randomUUID(),
    });

    expect(result.status).toBe("indeterminate");
    expect(result.reconciliation?.state).toBe("ambiguous");
  });

  test("does not treat an ignored explicit category clear as provider-owned metadata", async () => {
    const transport = new MockTransport();
    const existing = record(
      "trip-category-clear",
      draft({
        days: [
          {
            date: "2026-10-01",
            items: [
              {
                id: "item-1",
                place: { providerPlaceId: "poi-1", name: "東京車站" },
                categoryId: "category-before",
              },
            ],
          },
          { date: "2026-10-02", items: [] },
          { date: "2026-10-03", items: [] },
        ],
      }),
    );
    transport.trips.set(existing.id, existing);
    const { service } = await harness(transport);
    const preview = await service.preview({
      kind: "update",
      tripId: existing.id,
      baseRevision: existing.revision,
      operations: [
        {
          op: "update_item",
          itemId: "item-1",
          fields: { categoryId: null },
        },
      ],
    });
    await service.approve(
      preview.previewId,
      `APPLY ${preview.approval.reviewCode}`,
    );

    const result = await service.apply({
      previewId: preview.previewId,
      intentHash: preview.intentHash,
      idempotencyKey: randomUUID(),
    });

    expect(result.status).toBe("indeterminate");
  });

  test("reports applied only after an explicit category clear is read back", async () => {
    const transport = new MockTransport();
    transport.applyCategoryUpdates = true;
    const existing = record(
      "trip-category-cleared",
      draft({
        days: [
          {
            date: "2026-10-01",
            items: [
              {
                id: "item-1",
                place: { providerPlaceId: "poi-1", name: "東京車站" },
                categoryId: "category-before",
              },
            ],
          },
          { date: "2026-10-02", items: [] },
          { date: "2026-10-03", items: [] },
        ],
      }),
    );
    transport.trips.set(existing.id, existing);
    const { service } = await harness(transport);
    const preview = await service.preview({
      kind: "update",
      tripId: existing.id,
      baseRevision: existing.revision,
      operations: [
        {
          op: "update_item",
          itemId: "item-1",
          fields: { categoryId: null },
        },
      ],
    });
    await service.approve(
      preview.previewId,
      `APPLY ${preview.approval.reviewCode}`,
    );

    const result = await service.apply({
      previewId: preview.previewId,
      intentHash: preview.intentHash,
      idempotencyKey: randomUUID(),
    });

    expect(result.status).toBe("applied");
  });

  test("shifts an existing trip by day index and blocks duration changes", async () => {
    const transport = new MockTransport();
    const existing = record(
      "trip-shift",
      draft({
        days: [
          {
            date: "2026-10-01",
            items: [
              {
                id: "item-1",
                place: { providerPlaceId: "poi-1", name: "東京車站" },
              },
            ],
          },
          { date: "2026-10-02", items: [] },
          { date: "2026-10-03", items: [] },
        ],
      }),
    );
    transport.trips.set(existing.id, existing);
    const { service } = await harness(transport);

    const shifted = await service.preview({
      kind: "update",
      tripId: existing.id,
      baseRevision: existing.revision,
      operations: [
        {
          op: "set_trip_fields",
          fields: {
            startDate: "2026-10-05",
            endDate: "2026-10-07",
          },
        },
      ],
    });
    expect(shifted.blockers).toEqual([]);

    const resized = await service.preview({
      kind: "update",
      tripId: existing.id,
      baseRevision: existing.revision,
      operations: [
        {
          op: "set_trip_fields",
          fields: { endDate: "2026-10-04" },
        },
      ],
    });
    expect(resized.blockers).toContainEqual(
      expect.objectContaining({ code: "DATE_RANGE_RESIZE_UNVERIFIED" }),
    );
  });

  test("blocks updates to viewer-only collaborative trips", async () => {
    const transport = new MockTransport();
    const viewerTrip = {
      ...record("trip-viewer", draft()),
      ownership: "collaborating" as const,
      permission: "viewer" as const,
    };
    transport.trips.set(viewerTrip.id, viewerTrip);
    const { service } = await harness(transport);

    const preview = await service.preview({
      kind: "update",
      tripId: viewerTrip.id,
      baseRevision: viewerTrip.revision,
      operations: [{ op: "set_trip_fields", fields: { title: "不能修改" } }],
    });

    expect(preview.blockers).toContainEqual(
      expect.objectContaining({ code: "TRIP_NOT_EDITABLE" }),
    );
  });

  test("blocks cross-day moves at preview time", async () => {
    const transport = new MockTransport();
    const existing = record(
      "trip-move",
      draft({
        days: [
          {
            date: "2026-10-01",
            items: [
              {
                id: "item-1",
                place: { providerPlaceId: "poi-1", name: "東京車站" },
              },
            ],
          },
          { date: "2026-10-02", items: [] },
          { date: "2026-10-03", items: [] },
        ],
      }),
    );
    transport.trips.set(existing.id, existing);
    const { service } = await harness(transport);

    const preview = await service.preview({
      kind: "update",
      tripId: existing.id,
      baseRevision: existing.revision,
      operations: [
        { op: "move_item", itemId: "item-1", toDate: "2026-10-02" },
      ],
    });

    expect(preview.blockers).toContainEqual(
      expect.objectContaining({ code: "MOVE_ACROSS_DAYS_UNVERIFIED" }),
    );
  });
});

describe("TripDraft validation", () => {
  test("requires exactly one day entry for every date", () => {
    expect(() =>
      draft({
        days: [
          { date: "2026-10-01", items: [] },
          { date: "2026-10-03", items: [] },
        ],
      }),
    ).toThrow(/days must contain exactly one entry|Missing itinerary day/);
  });

  test("requires itinerary days in chronological order", () => {
    expect(() =>
      draft({
        days: [
          { date: "2026-10-02", items: [] },
          { date: "2026-10-01", items: [] },
          { date: "2026-10-03", items: [] },
        ],
      }),
    ).toThrow(/ordered chronologically/);
  });

  test("rejects an empty category identifier", () => {
    expect(() =>
      draft({
        days: [
          {
            date: "2026-10-01",
            items: [
              {
                place: { providerPlaceId: "poi-1", name: "東京車站" },
                categoryId: "",
              },
            ],
          },
          { date: "2026-10-02", items: [] },
          { date: "2026-10-03", items: [] },
        ],
      }),
    ).toThrow();
  });
});
