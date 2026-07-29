import { createHash } from "node:crypto";
import type { TripDraft, TripRecord } from "./schemas.js";

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function floatingDateTime(value: string): string {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/,
  );
  return match?.[1] && match[2]
    ? `${match[1]}T${match[2]}+00:00`
    : value;
}

export function tripContent(trip: TripDraft | TripRecord): TripDraft {
  return {
    title: trip.title,
    startDate: trip.startDate,
    endDate: trip.endDate,
    // chicTrip stores itinerary times as floating local wall-clock values and
    // does not expose an itinerary timezone field.
    timezone: "provider-floating-local-time",
    destinations: trip.destinations
      .map((destination) => ({
        providerLocationKey: destination.providerLocationKey,
        // Location names are provider-owned display labels and may be localized.
        name: "",
      }))
      .sort((left, right) =>
        left.providerLocationKey.localeCompare(right.providerLocationKey),
      ),
    trafficType: trip.trafficType,
    days: trip.days
      .map((day) => ({
        date: day.date,
        items: day.items.map((item) => ({
          place: {
            providerPlaceId: item.place.providerPlaceId,
            name: item.place.name,
            ...(item.place.coverMediaId
              ? { coverMediaId: item.place.coverMediaId }
              : {}),
          },
          ...(item.startsAt
            ? {
                startsAt: floatingDateTime(item.startsAt),
              }
            : {}),
          durationMinutes: item.durationMinutes ?? 0,
          ...(item.note ? { note: item.note } : {}),
          ...(item.categoryId ? { categoryId: item.categoryId } : {}),
        })),
      }))
      .sort((left, right) => left.date.localeCompare(right.date)),
  };
}

export function tripContentHash(trip: TripDraft | TripRecord): string {
  return sha256(tripContent(trip));
}

/**
 * Compares a provider read-back with an approved draft while allowing only
 * provider-owned optional metadata that the draft did not request.
 */
export function tripMatchesDesired(
  actual: TripRecord,
  desired: TripDraft,
): boolean {
  const actualContent = tripContent(actual);
  const desiredContent = tripContent(desired);
  const projectedActual = structuredClone(actualContent);

  for (const [dayIndex, desiredDay] of desiredContent.days.entries()) {
    const actualDay = projectedActual.days[dayIndex];
    if (!actualDay || actualDay.date !== desiredDay.date) continue;
    for (const [itemIndex, desiredItem] of desiredDay.items.entries()) {
      const actualItem = actualDay.items[itemIndex];
      if (!actualItem) continue;
      if (desiredItem.place.coverMediaId === undefined) {
        delete actualItem.place.coverMediaId;
      }
      if (desiredItem.categoryId === undefined) {
        delete actualItem.categoryId;
      }
    }
  }

  return canonicalize(projectedActual) === canonicalize(desiredContent);
}
