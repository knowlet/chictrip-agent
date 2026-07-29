import {
  DestinationSchema,
  PlaceRefSchema,
  TrafficTypeSchema,
  TripRecordSchema,
  TripSummarySchema,
  type Destination,
  type PlaceRef,
  type TripDay,
  type TripRecord,
  type TripSummary,
} from "../domain/schemas.js";
import { tripContentHash } from "../domain/canonical.js";

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function pickString(
  object: UnknownRecord,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export function pickNumber(
  object: UnknownRecord,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
  }
  return undefined;
}

export function normalizeDate(value: unknown): string {
  if (typeof value !== "string") return "1970-01-01";
  const match = value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "1970-01-01";
}

export function providerDate(value: string): string {
  return value.replaceAll("-", "/");
}

export function dateAtOffset(startDate: string, offset: number): string {
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function dayNumber(startDate: string, date: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const target = Date.parse(`${date}T00:00:00Z`);
  return Math.floor((target - start) / 86_400_000) + 1;
}

export function totalDays(startDate: string, endDate: string): number {
  return dayNumber(startDate, endDate);
}

export function extractTripRoot(data: unknown, tripId?: string): UnknownRecord {
  if (!Array.isArray(data)) return asRecord(data);
  const records = data.map(asRecord);
  if (tripId) {
    const match = records.find((candidate) => {
      const info = asRecord(candidate.travelScheduleInfo);
      return pickString(info, "id", "Id") === tripId;
    });
    if (match) return match;
  }
  return records[0] ?? {};
}

function normalizePermission(
  permission: unknown,
): "owner" | "editor" | "viewer" | "unknown" {
  if (typeof permission !== "string") return "unknown";
  const normalized = permission.toLowerCase();
  return normalized === "owner" ||
    normalized === "editor" ||
    normalized === "viewer"
    ? normalized
    : "unknown";
}

function normalizeOwnership(permission: unknown): "owned" | "collaborating" {
  return normalizePermission(permission) === "owner"
    ? "owned"
    : "collaborating";
}

export function normalizeDestinations(value: unknown): Destination[] {
  return asArray(value)
    .map(asRecord)
    .map((destination) => ({
      providerLocationKey:
        pickString(destination, "locationKey", "LocationKey", "id", "Id") ?? "",
      name:
        pickString(destination, "locationName", "name", "Name", "title") ?? "",
    }))
    .filter((destination) => destination.providerLocationKey && destination.name)
    .map((destination) => DestinationSchema.parse(destination));
}

export function normalizeTripSummary(raw: unknown): TripSummary {
  const record = asRecord(raw);
  const destinations = normalizeDestinations(record.destinationList);
  const startDate = normalizeDate(record.startDate ?? record.StartDate);
  const endDate = normalizeDate(record.endDate ?? record.EndDate);
  return TripSummarySchema.parse({
    id: pickString(record, "id", "Id") ?? "",
    title: pickString(record, "name", "Name") ?? "Untitled trip",
    startDate,
    endDate,
    ownership: normalizeOwnership(record.permission),
    permission: normalizePermission(record.permission),
    destinationNames: destinations.map((destination) => destination.name),
    providerVersion: pickString(record, "updateTime", "UpdateTime"),
  });
}

function normalizeStartsAt(
  raw: UnknownRecord,
  itineraryDate: string,
): string | undefined {
  const customFlag =
    raw.isUseCustomArrivalTime === true ||
    raw.IsUseCustomArrivalTime === true ||
    pickNumber(raw, "isUseCustomArrivalTime", "IsUseCustomArrivalTime") === 1;
  if (!customFlag) return undefined;
  const candidate = pickString(raw, "customArrivalTime", "CustomArrivalTime");
  if (!candidate) return undefined;
  const time = candidate.match(/(?:T|\s)(\d{2}:\d{2}(?::\d{2})?)/)?.[1];
  if (!time) return undefined;
  const normalized = `${itineraryDate}T${time.length === 5 ? `${time}:00` : time}`;
  const withOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}+08:00`;
  const parsed = Date.parse(withOffset);
  return Number.isFinite(parsed) ? withOffset : undefined;
}

function normalizeItem(
  raw: unknown,
  itineraryDate: string,
): TripDay["items"][number] {
  const record = asRecord(raw);
  const nestedPoi = asRecord(record.poi);
  const cover = asRecord(record.cover);
  const id =
    pickString(record, "tsdId", "TsdId", "travelScheduleDetailId", "id", "Id") ??
    "";
  const providerPlaceId =
    pickString(record, "poiId", "PoiId", "placeId") ??
    pickString(nestedPoi, "id", "Id") ??
    `unknown:${id}`;
  const place = PlaceRefSchema.parse({
    providerPlaceId,
    name:
      pickString(record, "name", "Name", "tsdName", "TsdName") ??
      pickString(nestedPoi, "name", "Name") ??
      "Untitled place",
    latitude:
      pickNumber(record, "latitude", "Latitude", "lat") ??
      pickNumber(nestedPoi, "latitude", "Latitude", "lat"),
    longitude:
      pickNumber(record, "longitude", "Longitude", "lon", "lng") ??
      pickNumber(nestedPoi, "longitude", "Longitude", "lon", "lng"),
    coverMediaId:
      pickString(record, "coverMediaId", "TsdCoverMediaId") ??
      pickString(cover, "id", "Id"),
  });
  const startsAt = normalizeStartsAt(record, itineraryDate);
  const durationMinutes = pickNumber(record, "stayTime", "StayTime");
  const note = pickString(record, "note", "Note");
  const categoryId = pickString(
    record,
    "poiClassificationId",
    "PoiClassificationId",
  );
  return {
    ...(id ? { id } : {}),
    place,
    ...(startsAt ? { startsAt } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    ...(note ? { note } : {}),
    ...(categoryId ? { categoryId } : {}),
  };
}

export function normalizeTrip(data: unknown, tripId?: string): TripRecord {
  const root = extractTripRoot(data, tripId);
  const infoCandidate = asRecord(root.travelScheduleInfo);
  const info = Object.keys(infoCandidate).length > 0 ? infoCandidate : root;
  const id = pickString(info, "id", "Id") ?? tripId ?? "";
  const startDate = normalizeDate(info.startDate ?? info.StartDate);
  const endDate = normalizeDate(info.endDate ?? info.EndDate);
  const rawDays =
    asArray(root.dayList).length > 0
      ? asArray(root.dayList)
      : asArray(root.days).length > 0
        ? asArray(root.days)
        : asArray(root.travelScheduleDayList);
  const days: TripDay[] = rawDays.map((rawDay, index) => {
    const day = asRecord(rawDay);
    const dayIndex = (pickNumber(day, "day", "Day") ?? index + 1) - 1;
    const date =
      normalizeDate(day.date ?? day.Date) !== "1970-01-01"
        ? normalizeDate(day.date ?? day.Date)
        : dateAtOffset(startDate, dayIndex);
    const itemsSource =
      asArray(day.tsdList).length > 0
        ? asArray(day.tsdList)
        : asArray(day.travelScheduleDetailList).length > 0
          ? asArray(day.travelScheduleDetailList)
          : asArray(day.detailList).length > 0
            ? asArray(day.detailList)
            : asArray(day.items);
    return {
      date,
      items: itemsSource.map((item) => normalizeItem(item, date)),
    };
  });
  const numberOfDays = Math.max(1, totalDays(startDate, endDate));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const completeDays = Array.from({ length: numberOfDays }, (_, index) => {
    const date = dateAtOffset(startDate, index);
    return byDate.get(date) ?? { date, items: [] };
  });
  const base = {
    id,
    title: pickString(info, "name", "Name") ?? "Untitled trip",
    startDate,
    endDate,
    timezone: "Asia/Taipei",
    destinations: normalizeDestinations(info.destinationList),
    trafficType:
      TrafficTypeSchema.safeParse(
        pickString(info, "trafficType", "TrafficType"),
      ).data ?? "Custom",
    days: completeDays,
    ownership: normalizeOwnership(info.permission),
    permission: normalizePermission(info.permission),
  };
  return TripRecordSchema.parse({
    ...base,
    revision: {
      providerVersion: pickString(info, "updateTime", "UpdateTime"),
      contentHash: tripContentHash(base),
      readAt: new Date().toISOString(),
    },
  });
}

export function normalizePlaceResults(data: unknown, limit: number): PlaceRef[] {
  const root = asRecord(data);
  const candidates =
    asArray(root.result).length > 0
      ? asArray(root.result)
      : asArray(root.data).length > 0
        ? asArray(root.data)
        : asArray(data);
  return candidates
    .slice(0, limit)
    .map(asRecord)
    .map((place) => {
      const cover = asRecord(place.cover);
      return {
        providerPlaceId: pickString(place, "poiId", "id", "Id") ?? "",
        name: pickString(place, "name", "Name", "title") ?? "",
        latitude: pickNumber(place, "latitude", "Latitude", "lat"),
        longitude: pickNumber(place, "longitude", "Longitude", "lng", "lon"),
        coverMediaId:
          pickString(place, "coverMediaId", "CoverMediaId") ??
          pickString(cover, "id", "Id"),
      };
    })
    .filter((place) => place.providerPlaceId && place.name)
    .map((place) => PlaceRefSchema.parse(place));
}

export function normalizeDestinationResults(
  data: unknown,
  limit: number,
): Destination[] {
  const root = asRecord(data);
  const candidates =
    asArray(root.result).length > 0
      ? asArray(root.result)
      : asArray(root.locationList).length > 0
        ? asArray(root.locationList)
        : asArray(data);
  return normalizeDestinations(candidates).slice(0, limit);
}
