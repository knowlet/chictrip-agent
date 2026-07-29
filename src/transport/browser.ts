import type { AppConfig } from "../config.js";
import { AppError } from "../domain/errors.js";
import type {
  Destination,
  ListTripsInput,
  PlaceRef,
  SearchDestinationsInput,
  SearchPlacesInput,
  TripDraft,
  TripPatchOperation,
  TripRecord,
  TripSummary,
} from "../domain/schemas.js";
import type {
  ChicTripTransport,
  MutationContext,
  ProviderMutationResult,
  TransportCapabilities,
} from "../domain/types.js";
import type { BrowserSession } from "../auth/browser-session.js";
import {
  BrowserApiClient,
  type ProviderEnvelope,
  type ProviderApiClient,
  type ProviderRequest,
} from "../provider/browser-api.js";
import {
  asArray,
  asRecord,
  dateAtOffset,
  dayNumber,
  extractTripRoot,
  normalizeDestinationResults,
  normalizePlaceResults,
  normalizeTrip,
  normalizeTripSummary,
  pickNumber,
  pickString,
  providerDate,
  totalDays,
} from "../provider/normalize.js";

function versionFrom(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  const record = asRecord(value);
  return pickString(
    record,
    "travelScheduleUpdateTime",
    "TravelScheduleUpdateTime",
    "updateTime",
    "UpdateTime",
  );
}

function requireVersionFrom(value: unknown, operation: string): string {
  const version = versionFrom(value);
  if (!version) {
    throw new AppError(
      "PROVIDER_INDETERMINATE",
      `chicTrip did not return a new itinerary revision after ${operation}.`,
    );
  }
  return version;
}

function providerFlag(
  record: Record<string, unknown>,
  ...keys: string[]
): number {
  for (const key of keys) {
    const value = record[key];
    if (value === true || value === 1 || value === "1") return 1;
    if (value === false || value === 0 || value === "0") return 0;
  }
  return 0;
}

function providerWallClock(value: string | undefined): string {
  if (!value) return "";
  const match = value.match(/(?:T|\s|^)(\d{2}:\d{2})(?::(\d{2}))?/);
  if (!match?.[1]) return "";
  return `0001/01/01 ${match[1]}:${match[2] ?? "00"}`;
}

type AddItemOperation = Extract<TripPatchOperation, { op: "add_item" }>;

function addItemNeedsFollowUpUpdate(operation: AddItemOperation): boolean {
  return (
    operation.item.startsAt !== undefined ||
    operation.item.durationMinutes !== undefined ||
    operation.item.categoryId !== undefined
  );
}

function plannedAddWrites(
  operation: AddItemOperation,
  current?: TripRecord,
): number {
  let requiresSort = operation.afterItemId !== undefined;
  if (operation.afterItemId && current) {
    const day = current.days.find((candidate) => candidate.date === operation.date);
    requiresSort = !day || day.items.at(-1)?.id !== operation.afterItemId;
  }
  return (
    1 +
    Number(addItemNeedsFollowUpUpdate(operation)) +
    Number(requiresSort)
  );
}

function plannedWritesForOperations(
  current: TripRecord,
  operations: TripPatchOperation[],
): number {
  let startDate = current.startDate;
  let endDate = current.endDate;
  let layouts = current.days.map((day, dayIndex) => ({
    date: day.date,
    itemIds: day.items.map(
      (item, itemIndex) => item.id ?? `missing:${dayIndex}:${itemIndex}`,
    ),
  }));
  let syntheticId = 0;
  let writes = 0;

  for (const operation of operations) {
    if (operation.op === "add_item") {
      const layout = layouts.find((day) => day.date === operation.date);
      const requiresSort =
        operation.afterItemId !== undefined &&
        layout?.itemIds.at(-1) !== operation.afterItemId;
      writes +=
        1 +
        Number(addItemNeedsFollowUpUpdate(operation)) +
        Number(requiresSort);
      if (layout) {
        const newId = `planned-add:${syntheticId++}`;
        if (operation.afterItemId) {
          const anchorIndex = layout.itemIds.indexOf(operation.afterItemId);
          layout.itemIds.splice(
            anchorIndex >= 0 ? anchorIndex + 1 : layout.itemIds.length,
            0,
            newId,
          );
        } else {
          layout.itemIds.push(newId);
        }
      }
      continue;
    }

    writes += 1;
    if (operation.op === "remove_item") {
      for (const layout of layouts) {
        const index = layout.itemIds.indexOf(operation.itemId);
        if (index >= 0) {
          layout.itemIds.splice(index, 1);
          break;
        }
      }
    } else if (operation.op === "move_item") {
      const source = layouts.find((day) =>
        day.itemIds.includes(operation.itemId),
      );
      const target = layouts.find((day) => day.date === operation.toDate);
      if (source && target) {
        source.itemIds.splice(source.itemIds.indexOf(operation.itemId), 1);
        const anchorIndex = operation.afterItemId
          ? target.itemIds.indexOf(operation.afterItemId)
          : target.itemIds.length - 1;
        target.itemIds.splice(anchorIndex + 1, 0, operation.itemId);
      }
    } else if (operation.op === "set_trip_fields") {
      const nextStart = operation.fields.startDate ?? startDate;
      const nextEnd = operation.fields.endDate ?? endDate;
      if (totalDays(nextStart, nextEnd) === layouts.length) {
        layouts = layouts.map((layout, index) => ({
          date: dateAtOffset(nextStart, index),
          itemIds: layout.itemIds,
        }));
      }
      startDate = nextStart;
      endDate = nextEnd;
    }
  }
  return writes;
}

function providerProgressDetails(
  tripId: string,
  completedSteps: number,
  totalSteps: number,
) {
  return { tripId, completedSteps, totalSteps };
}

function requireAcceptedWriteVersion(
  value: unknown,
  operation: string,
  tripId: string,
  completedBefore: number,
  totalSteps: number,
): string {
  try {
    return requireVersionFrom(value, operation);
  } catch (error) {
    throw new AppError(
      "PROVIDER_INDETERMINATE",
      `chicTrip accepted ${operation} but did not return a usable itinerary revision.`,
      {
        cause: error,
        details: providerProgressDetails(
          tripId,
          completedBefore + 1,
          totalSteps,
        ),
      },
    );
  }
}

function hasIndeterminateProgress(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.code === "PROVIDER_INDETERMINATE" &&
    typeof error.details === "object" &&
    error.details !== null
  );
}

async function requestMutation(
  api: ProviderApiClient,
  request: ProviderRequest,
  operation: string,
  tripId: string,
  completedBefore: number,
  totalSteps: number,
): Promise<ProviderEnvelope> {
  try {
    return await api.request(request);
  } catch (error) {
    if (hasIndeterminateProgress(error)) throw error;
    if (error instanceof AppError && error.code !== "PROVIDER_INDETERMINATE") {
      throw error;
    }
    throw new AppError(
      "PROVIDER_INDETERMINATE",
      `${operation} may have reached chicTrip, but its outcome could not be determined.`,
      {
        cause: error,
        details: providerProgressDetails(
          tripId,
          completedBefore + 1,
          totalSteps,
        ),
      },
    );
  }
}

export class BrowserChicTripTransport implements ChicTripTransport {
  readonly kind = "browser" as const;
  private readonly api: ProviderApiClient;

  constructor(
    private readonly session: BrowserSession,
    private readonly config: AppConfig,
    api?: ProviderApiClient,
  ) {
    this.api = api ?? new BrowserApiClient(session, config);
  }

  async getCapabilities(): Promise<TransportCapabilities> {
    const status = await this.session.status();
    const writes = this.config.enableUndocumentedWrites;
    const addItems = writes && this.config.enableExperimentalItemAdds;
    return {
      transport: this.kind,
      supportLevel: "experimental-undocumented",
      authenticated: status.authenticated,
      ...(status.accountRefHash ? { accountRefHash: status.accountRefHash } : {}),
      read: {
        listTrips: true,
        getTrip: true,
        searchPlaces: true,
        searchDestinations: true,
      },
      write: {
        createTrip: writes,
        updateTripFields: writes,
        addItem: addItems,
        updateItem: writes,
        moveItem: writes,
        removeItem: writes,
        deleteTrip: false,
        requiresApproval: true,
        idempotency: "local-ledger",
        atomicity: "multi-step",
      },
      caveats: [
        "This adapter uses undocumented chicTrip web endpoints and may break when the vendor changes them.",
        "No password, cookie, access token, or refresh token leaves the dedicated local browser profile.",
        ...(writes
          ? []
          : [
              "Writes are disabled. Set CHICTRIP_ENABLE_UNDOCUMENTED_WRITES=1 only after reviewing the risks.",
            ]),
        ...(addItems
          ? [
              "Item adds use the currently observed p1 web-client flow and remain experimental.",
            ]
          : this.config.enableExperimentalItemAdds
            ? [
                "Item adds remain disabled until CHICTRIP_ENABLE_UNDOCUMENTED_WRITES=1 is also set.",
              ]
          : [
              "Item adds require the separate CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS=1 opt-in.",
            ]),
        "Moving itinerary items is limited to reordering within the same day.",
      ],
    };
  }

  async listTrips(input: ListTripsInput): Promise<TripSummary[]> {
    const response = await this.api.request<unknown[]>({
      method: "GET",
      path: "/TravelSchedule/GetMyAndCollaboration",
      query: { updateTime: 0, orderByColumn: "updatetime", sort: "desc" },
    });
    return asArray(response.data)
      .map(normalizeTripSummary)
      .filter((trip) => input.scope === "all" || trip.ownership === input.scope)
      .slice(0, input.limit);
  }

  async getTrip(tripId: string): Promise<TripRecord> {
    const trip = normalizeTrip(await this.rawTrip(tripId), tripId);
    if (!trip.id) throw new AppError("NOT_FOUND", `Trip not found: ${tripId}`);
    return trip;
  }

  async searchPlaces(input: SearchPlacesInput): Promise<PlaceRef[]> {
    const response = await this.api.request({
      method: "GET",
      path: "/PoiSearch/SearchByKeyword",
      query: {
        keyword: input.query,
        centerLatitude: input.centerLatitude ?? 25.0478,
        centerLongitude: input.centerLongitude ?? 121.5319,
      },
    });
    return normalizePlaceResults(response.data, input.limit);
  }

  async searchDestinations(input: SearchDestinationsInput): Promise<Destination[]> {
    const response = await this.api.request({
      method: "GET",
      path: "/Location/SearchV2",
      query: { key: input.query },
    });
    return normalizeDestinationResults(response.data, input.limit);
  }

  async createTrip(
    input: TripDraft,
    context: MutationContext,
  ): Promise<ProviderMutationResult> {
    this.requireWrite("createTrip");
    const items = input.days.flatMap((day) =>
      day.items.map((item) => ({ date: day.date, item })),
    );
    if (items.length > 0) this.requireItemAdds();
    if (items.some(({ item }) => item.note)) {
      throw new AppError(
        "UNSUPPORTED_CAPABILITY",
        "Adding itinerary item notes is not covered by the observed provider contract.",
      );
    }
    const itemOperations: AddItemOperation[] = items.map(({ date, item }) => ({
      op: "add_item",
      date,
      item,
    }));
    const totalSteps =
      1 +
      itemOperations.reduce(
        (sum, operation) => sum + plannedAddWrites(operation),
        0,
      );
    const coverResponse = await this.api.request({
      method: "GET",
      path: "/TravelSchedule/GetSystemCoverList",
    });
    const firstCover = asRecord(asArray(coverResponse.data)[0]);
    const coverMediaId = pickString(firstCover, "id", "Id");
    if (!coverMediaId) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "Could not resolve the system cover required for trip creation.",
      );
    }
    const labelsResponse = await this.api.request({
      method: "GET",
      path: "/TravelScheduleUserLabel/Get",
    });
    const defaultLabels = asArray(labelsResponse.data)
      .map(asRecord)
      .filter(
        (candidate) =>
          candidate.isSystem === true &&
          pickString(candidate, "name") === "未標籤",
      );
    const defaultLabelId =
      defaultLabels.length === 1
        ? pickString(defaultLabels[0] ?? {}, "id")
        : undefined;
    if (!defaultLabelId) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "Could not resolve the unique system 未標籤 label required for trip creation.",
      );
    }
    const createResponse = await this.api.request({
      method: "POST",
      path: "/TravelSchedule/AddV2",
      expectedAccountRefHash: context.expectedAccountRefHash,
      language: "zh-tw",
      bodyEncoding: "form",
      body: {
        CoverMediaId: coverMediaId,
        Name: input.title,
        StartDate: providerDate(input.startDate),
        EndDate: providerDate(input.endDate),
        TotalDay: totalDays(input.startDate, input.endDate),
        ViewMode: "DetailMode",
        TravelScheduleUserLabelId: defaultLabelId,
        id: "",
        TrafficType: input.trafficType,
        IsForceUpdateTsdRoute: 0,
        updateTime: 0,
        LocationKey: input.destinations.map(
          (destination) => destination.providerLocationKey,
        ),
      },
    });
    const created = asRecord(createResponse.data);
    const tripId = pickString(created, "id", "Id");
    if (!tripId) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "chicTrip did not return the created trip ID.",
      );
    }
    let updateTime: string;
    try {
      updateTime = requireVersionFrom(created, "AddV2");
    } catch (error) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "chicTrip accepted trip creation but did not return a usable revision.",
        {
          cause: error,
          details: providerProgressDetails(tripId, 1, totalSteps),
        },
      );
    }
    let completedSteps = 1;
    if (itemOperations.length > 0) {
      let current: TripRecord;
      try {
        current = await this.readBackAtVersion(
          tripId,
          updateTime,
          completedSteps,
          totalSteps,
        );
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === "PROVIDER_INDETERMINATE"
        ) {
          throw new AppError(
            "PROVIDER_PARTIAL",
            "The trip shell was created, but its item plan could not be continued safely.",
            {
              cause: error,
              details: providerProgressDetails(
                tripId,
                completedSteps,
                totalSteps,
              ),
            },
          );
        }
        throw error;
      }
      for (const operation of itemOperations) {
        let outcome: Awaited<ReturnType<BrowserChicTripTransport["addItem"]>>;
        try {
          outcome = await this.addItem(
            tripId,
            operation,
            current,
            updateTime,
            context.expectedAccountRefHash,
            completedSteps,
            totalSteps,
          );
        } catch (error) {
          if (
            error instanceof AppError &&
            (error.code === "PROVIDER_PARTIAL" ||
              error.code === "PROVIDER_INDETERMINATE") &&
            typeof error.details === "object" &&
            error.details !== null
          ) {
            throw error;
          }
          throw new AppError(
            "PROVIDER_PARTIAL",
            "The trip shell was created, but only part of its item plan was applied.",
            {
              cause: error,
              details: providerProgressDetails(
                tripId,
                completedSteps,
                totalSteps,
              ),
            },
          );
        }
        updateTime = outcome.providerVersion;
        completedSteps = outcome.completedSteps;
        current = outcome.trip;
      }
    }
    return {
      tripId,
      providerVersion: updateTime,
      completedSteps,
      totalSteps,
    };
  }

  async updateTrip(
    tripId: string,
    operations: TripPatchOperation[],
    context: MutationContext,
  ): Promise<ProviderMutationResult> {
    this.requireWrite("updateTrip");
    let current = await this.getTrip(tripId);
    if (
      context.expectedRevision &&
      (current.revision.contentHash !==
        context.expectedRevision.contentHash ||
        (context.expectedRevision.providerVersion &&
          current.revision.providerVersion !==
            context.expectedRevision.providerVersion))
    ) {
      throw new AppError(
        "CONFLICT",
        "The itinerary changed before the first provider write.",
      );
    }
    if (!current.revision.providerVersion) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "The itinerary has no provider revision, so no write can be attempted safely.",
      );
    }
    let updateTime = current.revision.providerVersion;
    let completedSteps = 0;
    const totalSteps = plannedWritesForOperations(current, operations);
    try {
      for (const operation of operations) {
        let operationReadBackHandled = false;
        switch (operation.op) {
          case "set_trip_fields":
            updateTime = await this.updateTripFields(
              tripId,
              operation.fields,
              updateTime,
              context.expectedAccountRefHash,
              completedSteps,
              totalSteps,
            );
            break;
          case "add_item": {
            this.requireItemAdds();
            const outcome = await this.addItem(
              tripId,
              operation,
              current,
              updateTime,
              context.expectedAccountRefHash,
              completedSteps,
              totalSteps,
            );
            updateTime = outcome.providerVersion;
            completedSteps = outcome.completedSteps;
            current = outcome.trip;
            operationReadBackHandled = true;
            break;
          }
          case "update_item":
            updateTime = await this.updateItem(
              tripId,
              operation.itemId,
              operation.fields,
              updateTime,
              context.expectedAccountRefHash,
              completedSteps,
              totalSteps,
            );
            break;
          case "remove_item":
            updateTime = await this.removeItem(
              tripId,
              operation.itemId,
              current,
              updateTime,
              context.expectedAccountRefHash,
              completedSteps,
              totalSteps,
            );
            break;
          case "move_item":
            updateTime = await this.moveItem(
              tripId,
              operation.itemId,
              operation.toDate,
              operation.afterItemId,
              current,
              updateTime,
              context.expectedAccountRefHash,
              completedSteps,
              totalSteps,
            );
            break;
        }
        if (!operationReadBackHandled) {
          completedSteps += 1;
          current = await this.readBackAtVersion(
            tripId,
            updateTime,
            completedSteps,
            totalSteps,
          );
        }
      }
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "PROVIDER_PARTIAL" ||
          error.code === "PROVIDER_INDETERMINATE") &&
        typeof error.details === "object" &&
        error.details !== null
      ) {
        throw error;
      }
      if (completedSteps > 0) {
        throw new AppError(
          "PROVIDER_PARTIAL",
          "Only part of the requested itinerary update was applied.",
          {
            cause: error,
            details: { tripId, completedSteps, totalSteps },
          },
        );
      }
      throw error;
    }
    return { tripId, providerVersion: updateTime, completedSteps, totalSteps };
  }

  private requireWrite(capability: string): void {
    if (!this.config.enableUndocumentedWrites) {
      throw new AppError(
        "UNSUPPORTED_CAPABILITY",
        `${capability} is disabled for undocumented chicTrip endpoints.`,
      );
    }
  }

  private requireItemAdds(): void {
    if (!this.config.enableExperimentalItemAdds) {
      throw new AppError(
        "UNSUPPORTED_CAPABILITY",
        "Adding itinerary items requires CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS=1.",
      );
    }
  }

  private async readBackAtVersion(
    tripId: string,
    expectedVersion: string,
    completedSteps: number,
    totalSteps: number,
  ): Promise<TripRecord> {
    let trip: TripRecord;
    try {
      trip = await this.getTrip(tripId);
    } catch (error) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "A provider write returned, but the itinerary could not be read back safely.",
        {
          cause: error,
          details: providerProgressDetails(
            tripId,
            completedSteps,
            totalSteps,
          ),
        },
      );
    }
    if (
      !trip.revision.providerVersion ||
      trip.revision.providerVersion !== expectedVersion
    ) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "The provider revision changed or was unavailable during write reconciliation.",
        {
          details: providerProgressDetails(
            tripId,
            completedSteps,
            totalSteps,
          ),
        },
      );
    }
    return trip;
  }

  private async addItem(
    tripId: string,
    operation: AddItemOperation,
    current: TripRecord,
    updateTime: string,
    expectedAccountRefHash: string,
    completedBefore: number,
    totalSteps: number,
  ): Promise<{
    providerVersion: string;
    completedSteps: number;
    trip: TripRecord;
  }> {
    this.requireItemAdds();
    if (operation.item.note) {
      throw new AppError(
        "UNSUPPORTED_CAPABILITY",
        "Adding itinerary item notes is not covered by the observed provider contract.",
      );
    }
    const dayIndex = current.days.findIndex(
      (day) => day.date === operation.date,
    );
    const day = current.days[dayIndex];
    if (dayIndex < 0 || !day) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Cannot add an item outside the trip: ${operation.date}`,
      );
    }
    if (day.items.some((item) => !item.id)) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "Cannot safely identify a newly added item because an existing provider item ID is missing.",
      );
    }
    const beforeIds = new Set(day.items.map((item) => item.id as string));
    let requiresSort = false;
    if (operation.afterItemId) {
      const anchorIndex = day.items.findIndex(
        (item) => item.id === operation.afterItemId,
      );
      if (anchorIndex < 0) {
        throw new AppError(
          "NOT_FOUND",
          `The add-item anchor was not found on ${operation.date}: ${operation.afterItemId}`,
        );
      }
      requiresSort = anchorIndex !== day.items.length - 1;
    }

    const providerDay = dayNumber(current.startDate, operation.date);
    const placementResponse = await this.api.request({
      method: "GET",
      path: "/TravelScheduleDetail/GetAddWhere",
      query: {
        poiId: operation.item.place.providerPlaceId,
        travelScheduleId: tripId,
        travelScheduleUpdateTime: 0,
      },
    });
    const placementDays = asArray(asRecord(placementResponse.data).dayList).map(
      asRecord,
    );
    const placementDay =
      placementDays.find(
        (candidate) => pickNumber(candidate, "day", "Day") === providerDay,
      ) ?? placementDays[dayIndex];
    const candidates = asArray(placementDay?.addWhereList).map(asRecord);
    const allowedEndTokens =
      day.items.length === 0 ? new Set(["end", "start", "first"]) : new Set(["end"]);
    const endCandidate = candidates.find((candidate) => {
      const token = pickString(candidate, "addWhereId", "AddWhereId");
      return token ? allowedEndTokens.has(token) : false;
    });
    const addWhereId = endCandidate
      ? pickString(endCandidate, "addWhereId", "AddWhereId")
      : undefined;
    if (!addWhereId) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "The provider did not return a verified end-of-day insertion choice.",
      );
    }

    let completedSteps = completedBefore;
    const addResponse = await requestMutation(
      this.api,
      {
        method: "POST",
        path: "/TravelScheduleDetail/Add",
        expectedAccountRefHash,
        bodyEncoding: "multipart",
        body: {
          TravelScheduleId: tripId,
          Day: providerDay,
          PoiId: operation.item.place.providerPlaceId,
          AddWhereId: addWhereId,
          TravelScheduleUpdateTime: updateTime,
          ...(operation.item.place.coverMediaId
            ? { TsdCoverMediaId: operation.item.place.coverMediaId }
            : {}),
          TsdName: operation.item.place.name,
        },
      },
      "TravelScheduleDetail/Add",
      tripId,
      completedSteps,
      totalSteps,
    );
    let nextVersion = requireAcceptedWriteVersion(
      addResponse.data,
      "TravelScheduleDetail/Add",
      tripId,
      completedSteps,
      totalSteps,
    );
    completedSteps += 1;

    let readBack = await this.readBackAtVersion(
      tripId,
      nextVersion,
      completedSteps,
      totalSteps,
    );
    const readBackDay = readBack.days.find(
      (candidate) => candidate.date === operation.date,
    );
    const addedItems =
      readBackDay?.items.filter(
        (item) => item.id && !beforeIds.has(item.id),
      ) ?? [];
    if (
      addedItems.length !== 1 ||
      addedItems[0]?.place.providerPlaceId !==
        operation.item.place.providerPlaceId
    ) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "The item add returned, but a unique new provider item could not be reconciled.",
        {
          details: providerProgressDetails(
            tripId,
            completedSteps,
            totalSteps,
          ),
        },
      );
    }
    const itemId = addedItems[0].id as string;

    if (addItemNeedsFollowUpUpdate(operation)) {
      try {
        nextVersion = await this.updateItem(
          tripId,
          itemId,
          {
            ...(operation.item.startsAt
              ? { startsAt: operation.item.startsAt }
              : {}),
            ...(operation.item.durationMinutes !== undefined
              ? { durationMinutes: operation.item.durationMinutes }
              : {}),
            ...(operation.item.categoryId !== undefined
              ? { categoryId: operation.item.categoryId }
              : {}),
          },
          nextVersion,
          expectedAccountRefHash,
          completedSteps,
          totalSteps,
        );
      } catch (error) {
        if (hasIndeterminateProgress(error)) throw error;
        throw new AppError(
          "PROVIDER_PARTIAL",
          "The item was added, but its requested fields were not fully applied.",
          {
            cause: error,
            details: providerProgressDetails(
              tripId,
              completedSteps,
              totalSteps,
            ),
          },
        );
      }
      completedSteps += 1;
      readBack = await this.readBackAtVersion(
        tripId,
        nextVersion,
        completedSteps,
        totalSteps,
      );
    }

    if (requiresSort && operation.afterItemId) {
      try {
        nextVersion = await this.moveItem(
          tripId,
          itemId,
          operation.date,
          operation.afterItemId,
          readBack,
          nextVersion,
          expectedAccountRefHash,
          completedSteps,
          totalSteps,
        );
      } catch (error) {
        if (hasIndeterminateProgress(error)) throw error;
        throw new AppError(
          "PROVIDER_PARTIAL",
          "The item was added, but its requested order was not fully applied.",
          {
            cause: error,
            details: providerProgressDetails(
              tripId,
              completedSteps,
              totalSteps,
            ),
          },
        );
      }
      completedSteps += 1;
      readBack = await this.readBackAtVersion(
        tripId,
        nextVersion,
        completedSteps,
        totalSteps,
      );
    }

    return {
      providerVersion: nextVersion,
      completedSteps,
      trip: readBack,
    };
  }

  private async rawTrip(tripId: string): Promise<Record<string, unknown>> {
    const listResponse = await this.api.request({
      method: "GET",
      path: "/TravelSchedule/GetMyAndCollaboration",
      query: { updateTime: 0, orderByColumn: "updatetime", sort: "desc" },
    });
    const summary = asArray(listResponse.data)
      .map(normalizeTripSummary)
      .find((candidate) => candidate.id === tripId);
    if (!summary) throw new AppError("NOT_FOUND", `Trip not found: ${tripId}`);
    const response = await this.api.request({
      method: "GET",
      path: "/TravelScheduleDetail/Get",
      query: {
        travelScheduleId: tripId,
        travelScheduleName: summary.title,
        TravelScheduleUpdateTime: summary.providerVersion ?? 0,
        isMyTravelSchedule: summary.permission === "owner" ? 1 : 0,
      },
    });
    return extractTripRoot(response.data, tripId);
  }

  private async updateTripFields(
    tripId: string,
    fields: Extract<TripPatchOperation, { op: "set_trip_fields" }>["fields"],
    updateTime: string,
    expectedAccountRefHash: string,
    completedBefore: number,
    totalSteps: number,
  ): Promise<string> {
    const root = await this.rawTrip(tripId);
    const info = asRecord(root.travelScheduleInfo);
    const startDate = fields.startDate ?? normalizeTrip(root, tripId).startDate;
    const endDate = fields.endDate ?? normalizeTrip(root, tripId).endDate;
    const destinations =
      fields.destinations ??
      normalizeTrip(root, tripId).destinations;
    const verify = await this.api.request({
      method: "GET",
      path: "/TravelScheduleDetail/VerifyUpdateTime",
      query: {
        TravelScheduleId: tripId,
        travelScheduleUpdateTime: updateTime,
      },
    });
    const latestVersion = requireVersionFrom(
      verify.data,
      "VerifyUpdateTime",
    );
    const response = await requestMutation(
      this.api,
      {
        method: "PUT",
        path: "/TravelSchedule/UpdateV3",
        expectedAccountRefHash,
        language: "zh-tw",
        bodyEncoding: "form",
        body: {
          CoverMediaId: pickString(info, "coverMediaId", "CoverMediaId") ?? "",
          Name:
            fields.title ??
            pickString(info, "name", "Name") ??
            "Untitled trip",
          StartDate: providerDate(startDate),
          EndDate: providerDate(endDate),
          TotalDay: totalDays(startDate, endDate),
          ViewMode: pickString(info, "viewMode", "ViewMode") ?? "DetailMode",
          TravelScheduleUserLabelId:
            pickString(info, "userLabelId", "TravelScheduleUserLabelId") ?? "",
          id: tripId,
          TrafficType:
            fields.trafficType ??
            pickString(info, "trafficType", "TrafficType") ??
            "Custom",
          IsForceUpdateTsdRoute: 0,
          updateTime: latestVersion,
          LocationKey: destinations.map(
            (destination) => destination.providerLocationKey,
          ),
        },
      },
      "UpdateV3",
      tripId,
      completedBefore,
      totalSteps,
    );
    return requireAcceptedWriteVersion(
      response.data,
      "UpdateV3",
      tripId,
      completedBefore,
      totalSteps,
    );
  }

  private async updateItem(
    tripId: string,
    itemId: string,
    fields: Extract<TripPatchOperation, { op: "update_item" }>["fields"],
    updateTime: string,
    expectedAccountRefHash?: string,
    completedBefore = 0,
    totalSteps = 1,
  ): Promise<string> {
    if (fields.note !== undefined) {
      throw new AppError(
        "UNSUPPORTED_CAPABILITY",
        "Updating itinerary item notes is not yet mapped to a verified provider contract.",
      );
    }
    const edit = await this.api.request({
      method: "GET",
      path: "/TravelScheduleDetail/GetEditInfo",
      query: {
        TsdId: itemId,
        TravelScheduleId: tripId,
        TravelScheduleUpdateTime: updateTime,
      },
    });
    const current = asRecord(edit.data);
    const startsAt = fields.startsAt;
    const timeValue =
      typeof startsAt === "string" ? providerWallClock(startsAt) : "";
    const currentArrivalTime = providerWallClock(
      pickString(current, "customArrivalTime", "CustomArrivalTime"),
    );
    const currentDepartureTime = providerWallClock(
      pickString(
        current,
        "departureTime",
        "DepartureTime",
        "customDepartureTime",
        "CustomDepartureTime",
      ),
    );
    const response = await requestMutation(
      this.api,
      {
        method: "PUT",
        path: "/TravelScheduleDetail/Update",
        ...(expectedAccountRefHash ? { expectedAccountRefHash } : {}),
        bodyEncoding: "multipart",
        body: {
          TsdId: itemId,
          Name:
            fields.name ??
            pickString(current, "name", "Name") ??
            "Untitled place",
          PoiClassificationId:
            fields.categoryId === null
              ? ""
              : fields.categoryId ??
                pickString(
                  current,
                  "poiClassificationId",
                  "PoiClassificationId",
                ) ??
                "",
          StayTime:
            fields.durationMinutes ??
            pickNumber(current, "stayTime", "StayTime") ??
            0,
          IsUseCustomArrivalTime:
            fields.startsAt === undefined
              ? providerFlag(
                  current,
                  "isUseCustomArrivalTime",
                  "IsUseCustomArrivalTime",
                )
              : startsAt
                ? 1
                : 0,
          CustomArrivalTime:
            fields.startsAt === undefined ? currentArrivalTime : timeValue,
          IsUseCustomDepartureTime: providerFlag(
            current,
            "isUseCustomDepartureTime",
            "IsUseCustomDepartureTime",
          ),
          CustomDepartureTime: currentDepartureTime,
          TravelScheduleId: tripId,
          travelScheduleUpdateTime: updateTime,
        },
      },
      "TravelScheduleDetail/Update",
      tripId,
      completedBefore,
      totalSteps,
    );
    return requireAcceptedWriteVersion(
      response.data,
      "TravelScheduleDetail/Update",
      tripId,
      completedBefore,
      totalSteps,
    );
  }

  private async removeItem(
    tripId: string,
    itemId: string,
    trip: TripRecord,
    updateTime: string,
    expectedAccountRefHash: string,
    completedBefore: number,
    totalSteps: number,
  ): Promise<string> {
    const dayIndex = trip.days.findIndex((day) =>
      day.items.some((item) => item.id === itemId),
    );
    if (dayIndex < 0) throw new AppError("NOT_FOUND", `Trip item not found: ${itemId}`);
    const response = await requestMutation(
      this.api,
      {
        method: "DELETE",
        path: "/TravelScheduleDetail/Delete",
        expectedAccountRefHash,
        bodyEncoding: "multipart",
        body: {
          TravelScheduleId: tripId,
          Day: dayIndex + 1,
          TsdId: itemId,
          TravelScheduleUpdateTime: updateTime,
        },
      },
      "TravelScheduleDetail/Delete",
      tripId,
      completedBefore,
      totalSteps,
    );
    return requireAcceptedWriteVersion(
      response.data,
      "TravelScheduleDetail/Delete",
      tripId,
      completedBefore,
      totalSteps,
    );
  }

  private async moveItem(
    tripId: string,
    itemId: string,
    toDate: string,
    afterItemId: string | undefined,
    trip: TripRecord,
    updateTime: string,
    expectedAccountRefHash?: string,
    completedBefore = 0,
    totalSteps = 1,
  ): Promise<string> {
    const sourceIndex = trip.days.findIndex((day) =>
      day.items.some((item) => item.id === itemId),
    );
    const targetIndex = trip.days.findIndex((day) => day.date === toDate);
    if (sourceIndex < 0) throw new AppError("NOT_FOUND", `Trip item not found: ${itemId}`);
    if (targetIndex < 0) {
      throw new AppError("VALIDATION_ERROR", `Target date is outside the trip: ${toDate}`);
    }
    if (sourceIndex !== targetIndex) {
      throw new AppError(
        "UNSUPPORTED_CAPABILITY",
        "Moving itinerary items across days is not covered by the verified current provider contract.",
      );
    }
    const targetItems = trip.days[targetIndex]?.items ?? [];
    if (targetItems.some((item) => !item.id)) {
      throw new AppError(
        "PROVIDER_INDETERMINATE",
        "Cannot safely sort an itinerary day because at least one provider item ID is missing.",
      );
    }
    const targetIds = targetItems
      .map((item) => item.id as string)
      .filter((id) => id !== itemId);
    const insertionIndex = afterItemId
      ? targetIds.indexOf(afterItemId) + 1
      : targetIds.length;
    if (afterItemId && insertionIndex === 0) {
      throw new AppError("NOT_FOUND", `Target item not found: ${afterItemId}`);
    }
    targetIds.splice(insertionIndex, 0, itemId);
    const response = await requestMutation(
      this.api,
      {
        method: "PUT",
        path: "/TravelScheduleDetail/Sort",
        ...(expectedAccountRefHash ? { expectedAccountRefHash } : {}),
        bodyEncoding: "multipart",
        body: {
          TravelScheduleId: tripId,
          MoveOutDay: sourceIndex + 1,
          MoveInDay: targetIndex + 1,
          MoveTsdId: itemId,
          TsdIdList: targetIds,
          travelScheduleUpdateTime: updateTime,
        },
      },
      "TravelScheduleDetail/Sort",
      tripId,
      completedBefore,
      totalSteps,
    );
    return requireAcceptedWriteVersion(
      response.data,
      "TravelScheduleDetail/Sort",
      tripId,
      completedBefore,
      totalSteps,
    );
  }
}
