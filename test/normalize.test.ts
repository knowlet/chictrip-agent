import { describe, expect, test } from "bun:test";
import { normalizeTrip } from "../src/provider/normalize.js";

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
