import { describe, expect, test } from "bun:test";
import {
  tripContentHash,
  tripMatchesDesired,
} from "../src/domain/canonical.js";
import {
  TripDraftSchema,
  TripRecordSchema,
} from "../src/domain/schemas.js";

describe("semantic trip content hash", () => {
  test("ignores provider-generated IDs, timezone absence, and offset representation", () => {
    const desired = TripDraftSchema.parse({
      title: "東京一日",
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      timezone: "Asia/Tokyo",
      destinations: [
        { providerLocationKey: "jp-tokyo", name: "東京" },
      ],
      trafficType: "Custom",
      days: [
        {
          date: "2026-10-01",
          items: [
            {
              place: { providerPlaceId: "poi-1", name: "東京車站" },
              startsAt: "2026-10-01T09:00:00+09:00",
            },
          ],
        },
      ],
    });
    const providerReadback = TripDraftSchema.parse({
      ...structuredClone(desired),
      timezone: "Asia/Taipei",
      destinations: [
        { providerLocationKey: "jp-tokyo", name: "東京都" },
      ],
      days: [
        {
          date: "2026-10-01",
          items: [
            {
              id: "provider-created-id",
              place: { providerPlaceId: "poi-1", name: "東京車站" },
              startsAt: "2026-10-01T09:00:00+08:00",
              durationMinutes: 0,
            },
          ],
        },
      ],
    });

    expect(tripContentHash(providerReadback)).toBe(tripContentHash(desired));
  });

  test("includes requested cover and category values in reconciliation", () => {
    const desired = TripDraftSchema.parse({
      title: "東京一日",
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      timezone: "Asia/Tokyo",
      destinations: [{ providerLocationKey: "jp-tokyo", name: "東京" }],
      trafficType: "Custom",
      days: [
        {
          date: "2026-10-01",
          items: [
            {
              place: {
                providerPlaceId: "poi-1",
                name: "東京車站",
                coverMediaId: "cover-requested",
              },
              categoryId: "category-requested",
            },
          ],
        },
      ],
    });
    const actual = TripRecordSchema.parse({
      ...structuredClone(desired),
      id: "trip-1",
      ownership: "owned",
      permission: "owner",
      revision: {
        providerVersion: "2",
        contentHash: "0".repeat(64),
        readAt: new Date().toISOString(),
      },
    });

    expect(tripMatchesDesired(actual, desired)).toBe(true);
    actual.days[0]!.items[0]!.categoryId = "category-ignored";
    expect(tripMatchesDesired(actual, desired)).toBe(false);
    expect(tripContentHash(actual)).not.toBe(tripContentHash(desired));
  });

  test("allows provider-owned cover and category values only when omitted", () => {
    const desired = TripDraftSchema.parse({
      title: "東京一日",
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      timezone: "Asia/Tokyo",
      destinations: [{ providerLocationKey: "jp-tokyo", name: "東京" }],
      trafficType: "Custom",
      days: [
        {
          date: "2026-10-01",
          items: [
            {
              place: { providerPlaceId: "poi-1", name: "東京車站" },
            },
          ],
        },
      ],
    });
    const actual = TripRecordSchema.parse({
      ...structuredClone(desired),
      days: [
        {
          date: "2026-10-01",
          items: [
            {
              id: "provider-item",
              place: {
                providerPlaceId: "poi-1",
                name: "東京車站",
                coverMediaId: "provider-cover",
              },
              durationMinutes: 0,
              categoryId: "provider-category",
            },
          ],
        },
      ],
      id: "trip-1",
      ownership: "owned",
      permission: "owner",
      revision: {
        providerVersion: "2",
        contentHash: "0".repeat(64),
        readAt: new Date().toISOString(),
      },
    });

    expect(tripMatchesDesired(actual, desired)).toBe(true);
  });
});
