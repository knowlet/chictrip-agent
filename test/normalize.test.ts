import { describe, expect, test } from "bun:test";
import { AppError } from "../src/domain/errors.js";
import { extractTripRoot, normalizeTrip } from "../src/provider/normalize.js";

describe("provider normalization", () => {
  test("keeps only explicit custom arrival times", () => {
    const trip = normalizeTrip({
      travelScheduleInfo: {
        id: "trip-1",
        name: "台北",
        startDate: "2026/09/01",
        endDate: "2026/09/01",
        updateTime: 7,
        permission: "Owner",
        destinationList: [
          { locationKey: "tw-tpe", locationName: "台北" },
        ],
      },
      dayList: [
        {
          day: 1,
          tsdList: [
            {
              id: "item-custom",
              poiId: "poi-1",
              name: "早餐",
              isUseCustomArrivalTime: true,
              customArrivalTime: "0001/01/01 09:30:00",
              arrivalTime: "2026/09/01 08:00:00",
              stayTime: 60,
            },
            {
              id: "item-auto",
              poiId: "poi-2",
              name: "午餐",
              isUseCustomArrivalTime: false,
              arrivalTime: "2026/09/01 12:00:00",
              stayTime: 60,
            },
          ],
        },
      ],
    });

    expect(trip.days[0]?.items[0]?.startsAt).toBe("2026-09-01T09:30:00+08:00");
    expect(trip.days[0]?.items[1]?.startsAt).toBeUndefined();
  });
});


describe("detail root selection compatibility", () => {
  test("keeps first-record behavior when no trip ID is supplied", () => {
    const first = { travelScheduleInfo: { id: "first" } };
    expect(extractTripRoot([first, { travelScheduleInfo: { id: "second" } }])).toBe(first);
  });

  test("keeps a direct object response unchanged", () => {
    const root = { travelScheduleInfo: { id: "trip-1" } };
    expect(extractTripRoot(root, "trip-1")).toBe(root);
  });
});

const destination = { locationKey: "tw-tpe", locationName: "台北" };

function identityFields(idField: "id" | "Id", id: string, name: string) {
  return {
    [idField]: id,
    name,
    startDate: "2026/09/01",
    endDate: "2026/09/01",
    permission: "Owner",
    destinationList: [destination],
  };
}

function topLevelDetail(idField: "id" | "Id", id: string, name: string) {
  return { ...identityFields(idField, id, name), dayList: [] };
}

describe("detail record identity shapes", () => {
  test("selects a nested travelScheduleInfo id or Id", () => {
    const byId = { travelScheduleInfo: identityFields("id", "trip-1", "巢狀") };
    const byCapitalId = { travelScheduleInfo: identityFields("Id", "trip-2", "大寫") };
    expect(extractTripRoot([byCapitalId, byId], "trip-1")).toBe(byId);
    expect(extractTripRoot([byId, byCapitalId], "trip-2")).toBe(byCapitalId);
    expect(normalizeTrip([byId], "trip-1")).toMatchObject({ id: "trip-1", title: "巢狀" });
    expect(normalizeTrip([byCapitalId], "trip-2")).toMatchObject({ id: "trip-2", title: "大寫" });
  });

  test("selects a top-level id or Id instead of throwing NOT_FOUND", () => {
    const byId = topLevelDetail("id", "trip-1", "頂層");
    const byCapitalId = topLevelDetail("Id", "trip-2", "大寫頂層");
    expect(extractTripRoot([byCapitalId, byId], "trip-1")).toBe(byId);
    expect(extractTripRoot([byId, byCapitalId], "trip-2")).toBe(byCapitalId);
    expect(normalizeTrip([byCapitalId, byId], "trip-1")).toMatchObject({
      id: "trip-1",
      title: "頂層",
    });
    expect(normalizeTrip([byId, byCapitalId], "trip-2")).toMatchObject({
      id: "trip-2",
      title: "大寫頂層",
    });
  });

  test("still rejects a top-level id that is not the requested trip", () => {
    let caught: unknown;
    try {
      extractTripRoot([topLevelDetail("id", "other", "別的")], "trip-1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: "NOT_FOUND" });
  });
});
