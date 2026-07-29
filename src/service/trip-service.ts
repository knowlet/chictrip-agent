import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors.js";
import {
  ApplyTripChangeInputSchema,
  ListTripsInputSchema,
  SearchDestinationsInputSchema,
  SearchPlacesInputSchema,
  TripChangeIntentSchema,
  TripDraftSchema,
  type ApplyTripChangeInput,
  type ListTripsInput,
  type SearchDestinationsInput,
  type SearchPlacesInput,
  type TripChangeIntent,
  type TripDraft,
  type TripPatchOperation,
  type TripRecord,
} from "../domain/schemas.js";
import {
  sha256,
  tripContentHash,
  tripMatchesDesired,
} from "../domain/canonical.js";
import type {
  ApplyTripChangeResult,
  ChangeDiff,
  ChangePreview,
  ChicTripTransport,
  MutationLedgerEntry,
  StoredPreview,
  TripServiceApi,
  TransportCapabilities,
} from "../domain/types.js";
import type { AppConfig } from "../config.js";
import type { JsonStateStore } from "../state/store.js";
import type { ApprovalService } from "../state/approval.js";
import { dateAtOffset, totalDays } from "../provider/normalize.js";

function findItem(
  trip: TripDraft | TripRecord,
  itemId: string,
): { dayIndex: number; itemIndex: number } | undefined {
  for (const [dayIndex, day] of trip.days.entries()) {
    const itemIndex = day.items.findIndex((item) => item.id === itemId);
    if (itemIndex >= 0) return { dayIndex, itemIndex };
  }
  return undefined;
}

function rebuildDateRange(trip: TripDraft): void {
  const count = totalDays(trip.startDate, trip.endDate);
  const old = new Map(trip.days.map((day) => [day.date, day]));
  trip.days = Array.from({ length: count }, (_, index) => {
    const date = dateAtOffset(trip.startDate, index);
    return old.get(date) ?? { date, items: [] };
  });
}

function explicitClearsMatch(
  actual: TripRecord,
  intent: TripChangeIntent,
): boolean {
  if (intent.kind !== "update") return true;
  const finalCategoryChanges = new Map<string, string | null>();
  for (const operation of intent.operations) {
    if (
      operation.op === "update_item" &&
      operation.fields.categoryId !== undefined
    ) {
      finalCategoryChanges.set(operation.itemId, operation.fields.categoryId);
    }
  }
  for (const [itemId, categoryId] of finalCategoryChanges) {
    if (categoryId !== null) continue;
    const found = findItem(actual, itemId);
    if (!found) return false;
    const item = actual.days[found.dayIndex]?.items[found.itemIndex];
    if (!item || item.categoryId !== undefined) return false;
  }
  return true;
}

function applyOperation(
  desired: TripDraft,
  operation: TripPatchOperation,
  diff: ChangeDiff[],
  blockers: ChangePreview["blockers"],
): void {
  switch (operation.op) {
    case "set_trip_fields": {
      const originalStartDate = desired.startDate;
      const originalEndDate = desired.endDate;
      const originalDays = structuredClone(desired.days);
      for (const [field, after] of Object.entries(operation.fields)) {
        const key = field as keyof typeof operation.fields;
        const before = desired[key];
        if (after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
          diff.push({
            path: `/trip/${field}`,
            action: "update",
            before,
            after,
          });
          Object.assign(desired, { [field]: after });
        }
      }
      const dateChangeRequested =
        operation.fields.startDate !== undefined ||
        operation.fields.endDate !== undefined;
      if (dateChangeRequested) {
        const originalCount = totalDays(originalStartDate, originalEndDate);
        const nextCount = totalDays(desired.startDate, desired.endDate);
        if (nextCount < 1 || nextCount > 60) {
          blockers.push({
            code: "INVALID_DATE_RANGE",
            message: "The requested date range must contain between 1 and 60 days.",
          });
          desired.startDate = originalStartDate;
          desired.endDate = originalEndDate;
          desired.days = originalDays;
        } else if (nextCount !== originalCount) {
          blockers.push({
            code: "DATE_RANGE_RESIZE_UNVERIFIED",
            message:
              "Changing the number of itinerary days is not covered by a verified provider workflow.",
          });
          rebuildDateRange(desired);
        } else {
          // The current chicTrip UI shifts an existing itinerary while keeping
          // its day count. Preserve items by day index, not by old calendar date.
          desired.days = originalDays.map((day, index) => ({
            date: dateAtOffset(desired.startDate, index),
            items: day.items,
          }));
        }
      } else {
        rebuildDateRange(desired);
      }
      break;
    }
    case "add_item": {
      const day = desired.days.find((candidate) => candidate.date === operation.date);
      if (!day) {
        blockers.push({
          code: "DATE_OUTSIDE_TRIP",
          message: `Cannot add an item outside the trip: ${operation.date}`,
        });
        return;
      }
      let index = day.items.length;
      if (operation.afterItemId) {
        const afterIndex = day.items.findIndex(
          (item) => item.id === operation.afterItemId,
        );
        if (afterIndex < 0) {
          blockers.push({
            code: "ITEM_NOT_FOUND",
            message: `afterItemId was not found on ${operation.date}.`,
          });
          return;
        }
        index = afterIndex + 1;
      }
      // Provider item IDs do not exist until apply. Keep previews semantic so
      // read-back verification does not depend on a synthetic identifier.
      const item = structuredClone(operation.item);
      day.items.splice(index, 0, item);
      diff.push({
        path: `/days/${operation.date}/items/${index}`,
        action: "add",
        after: operation.item,
      });
      break;
    }
    case "update_item": {
      const found = findItem(desired, operation.itemId);
      if (!found) {
        blockers.push({
          code: "ITEM_NOT_FOUND",
          message: `Trip item was not found: ${operation.itemId}`,
        });
        return;
      }
      const item = desired.days[found.dayIndex]?.items[found.itemIndex];
      if (!item) return;
      for (const [field, after] of Object.entries(operation.fields)) {
        let before: unknown;
        if (field === "name") {
          before = item.place.name;
          if (after !== undefined) item.place.name = String(after);
        } else {
          const key = field as "startsAt" | "durationMinutes" | "note" | "categoryId";
          before = item[key];
          if (after === null) {
            delete item[key];
          } else if (after !== undefined) {
            Object.assign(item, { [key]: after });
          }
        }
        if (after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
          diff.push({
            path: `/items/${operation.itemId}/${field}`,
            action: "update",
            before,
            after,
          });
        }
      }
      break;
    }
    case "remove_item": {
      const found = findItem(desired, operation.itemId);
      if (!found) {
        blockers.push({
          code: "ITEM_NOT_FOUND",
          message: `Trip item was not found: ${operation.itemId}`,
        });
        return;
      }
      const day = desired.days[found.dayIndex];
      const [removed] = day?.items.splice(found.itemIndex, 1) ?? [];
      diff.push({
        path: `/items/${operation.itemId}`,
        action: "remove",
        before: removed,
      });
      break;
    }
    case "move_item": {
      const found = findItem(desired, operation.itemId);
      const targetDay = desired.days.find((day) => day.date === operation.toDate);
      if (!found || !targetDay) {
        blockers.push({
          code: "ITEM_NOT_FOUND",
          message: `Could not resolve the move target for item ${operation.itemId}.`,
        });
        return;
      }
      const sourceDay = desired.days[found.dayIndex];
      if (sourceDay?.date !== targetDay.date) {
        blockers.push({
          code: "MOVE_ACROSS_DAYS_UNVERIFIED",
          message:
            "Moving itinerary items across days is not covered by the verified current provider workflow.",
        });
        return;
      }
      const [item] = sourceDay?.items.splice(found.itemIndex, 1) ?? [];
      if (!item) return;
      let targetIndex = targetDay.items.length;
      if (operation.afterItemId) {
        const afterIndex = targetDay.items.findIndex(
          (candidate) => candidate.id === operation.afterItemId,
        );
        if (afterIndex < 0) {
          blockers.push({
            code: "ITEM_NOT_FOUND",
            message: `Move anchor was not found: ${operation.afterItemId}`,
          });
          sourceDay?.items.splice(found.itemIndex, 0, item);
          return;
        }
        targetIndex = afterIndex + 1;
      }
      targetDay.items.splice(targetIndex, 0, item);
      diff.push({
        path: `/items/${operation.itemId}`,
        action: "move",
        before: {
          date: sourceDay?.date,
          index: found.itemIndex,
        },
        after: {
          date: targetDay.date,
          index: targetIndex,
        },
      });
      break;
    }
  }
}

function reviewCode(previewId: string): string {
  return sha256(previewId).slice(0, 8).toUpperCase();
}

function executionPlanDigest(
  stored: Omit<
    StoredPreview,
    "executionPlanDigest" | "approvalGrant" | "applyClaim"
  >,
): string {
  return sha256(stored);
}

function assertStoredPreviewIntegrity(
  stored: StoredPreview,
  expectedPreviewId: string,
): void {
  if (
    stored.preview.previewId !== expectedPreviewId ||
    sha256(stored.intent) !== stored.preview.intentHash
  ) {
    throw new AppError(
      "APPROVAL_INVALID",
      "The stored preview no longer matches its approved intent. Create a new preview.",
    );
  }
  const expectedBaseRevision =
    stored.intent.kind === "update" ? stored.intent.baseRevision : undefined;
  if (
    sha256(expectedBaseRevision ?? null) !==
    sha256(stored.preview.baseRevision ?? null)
  ) {
    throw new AppError(
      "APPROVAL_INVALID",
      "The stored preview revision binding is invalid. Create a new preview.",
    );
  }
  if (
    !stored.desired ||
    tripContentHash(stored.desired) !== stored.desiredContentHash
  ) {
    throw new AppError(
      "APPROVAL_INVALID",
      "The stored desired itinerary failed its integrity check. Create a new preview.",
    );
  }
  const computedDigest = executionPlanDigest({
    preview: stored.preview,
    intent: stored.intent,
    desired: stored.desired,
    desiredContentHash: stored.desiredContentHash,
  });
  if (
    !stored.executionPlanDigest ||
    computedDigest !== stored.executionPlanDigest
  ) {
    throw new AppError(
      "APPROVAL_INVALID",
      "The stored execution plan failed its integrity check. Create a new preview.",
    );
  }
}

function assertLedgerBinding(
  entry: MutationLedgerEntry,
  expected: {
    previewId: string;
    intentHash: string;
    executionPlanDigest: string;
    accountRefHash: string;
    transport: ChicTripTransport["kind"];
  },
): void {
  if (
    entry.previewId !== expected.previewId ||
    entry.intentHash !== expected.intentHash ||
    entry.executionPlanDigest !== expected.executionPlanDigest ||
    entry.accountRefHash !== expected.accountRefHash ||
    entry.transport !== expected.transport
  ) {
    throw new AppError(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key is bound to a different preview, account, transport, or execution plan.",
    );
  }
}

function ledgerResult(entry: MutationLedgerEntry): ApplyTripChangeResult {
  if (entry.result) {
    return {
      ...entry.result,
      status:
        entry.result.status === "applied"
          ? "already_applied"
          : entry.result.status,
    };
  }
  return {
    operationId: entry.operationId,
    status: "indeterminate",
    reconciliation: {
      state: "ambiguous",
      message:
        "An earlier apply attempt is still in flight or ended before its result was recorded.",
    },
  };
}

function safeReconciliationMessage(code: AppError["code"]): string {
  switch (code) {
    case "CONFLICT":
      return "The provider itinerary revision changed before the approved operation completed.";
    case "PROVIDER_PARTIAL":
      return "The provider may have applied only part of the approved operation. Reconcile by reading the itinerary.";
    case "PROVIDER_ERROR":
    case "PROVIDER_INDETERMINATE":
      return "The provider write outcome could not be determined safely. Reconcile by reading the itinerary.";
    default:
      return "The approved operation failed without exposing provider diagnostics.";
  }
}

export class TripService implements TripServiceApi {
  constructor(
    private readonly transport: ChicTripTransport,
    private readonly store: JsonStateStore,
    private readonly approval: ApprovalService,
    private readonly config: AppConfig,
  ) {}

  capabilities() {
    return this.transport.getCapabilities();
  }

  async listTrips(input: ListTripsInput) {
    return this.transport.listTrips(ListTripsInputSchema.parse(input));
  }

  async getTrip(tripId: string) {
    if (!tripId) throw new AppError("VALIDATION_ERROR", "tripId is required.");
    return this.transport.getTrip(tripId);
  }

  async searchPlaces(input: SearchPlacesInput) {
    return this.transport.searchPlaces(SearchPlacesInputSchema.parse(input));
  }

  async searchDestinations(input: SearchDestinationsInput) {
    return this.transport.searchDestinations(
      SearchDestinationsInputSchema.parse(input),
    );
  }

  async preview(input: TripChangeIntent): Promise<ChangePreview> {
    const intent = TripChangeIntentSchema.parse(input);
    const capabilities = await this.transport.getCapabilities();
    if (!capabilities.authenticated || !capabilities.accountRefHash) {
      throw new AppError(
        "AUTH_REQUIRED",
        "Complete local chicTrip login before previewing account changes.",
      );
    }
    const diff: ChangeDiff[] = [];
    const blockers: ChangePreview["blockers"] = [];
    const warnings: ChangePreview["warnings"] = [
      {
        code: "UNDOCUMENTED_PROVIDER_API",
        message:
          "This preview targets undocumented chicTrip web endpoints. Review it carefully.",
      },
    ];
    let desired: TripDraft;
    let baseRevision: TripRecord["revision"] | undefined;

    if (intent.kind === "create") {
      desired = structuredClone(intent.desired);
      diff.push({ path: "/trip", action: "add", after: desired });
      if (!capabilities.write.createTrip) {
        blockers.push({
          code: "CREATE_DISABLED",
          message: "Creating trips is disabled for the current transport configuration.",
        });
      }
      const items = desired.days.flatMap((day) => day.items);
      if (items.length > 0 && !capabilities.write.addItem) {
        blockers.push({
          code: "ADD_ITEM_DISABLED",
          message:
            "The plan contains itinerary items, but experimental item adds are not enabled.",
        });
      }
      if (items.some((item) => item.note)) {
        blockers.push({
          code: "ITEM_NOTE_UNSUPPORTED",
          message: "Item notes are not covered by a verified write contract.",
        });
      }
    } else {
      const current = await this.transport.getTrip(intent.tripId);
      baseRevision = current.revision;
      if (
        current.revision.contentHash !== intent.baseRevision.contentHash ||
        (intent.baseRevision.providerVersion &&
          current.revision.providerVersion !== intent.baseRevision.providerVersion)
      ) {
        throw new AppError(
          "CONFLICT",
          "The itinerary changed since it was read. Fetch it again and create a new preview.",
          {
            details: {
              expectedRevision: intent.baseRevision,
              currentRevision: current.revision,
            },
          },
        );
      }
      desired = {
        title: current.title,
        startDate: current.startDate,
        endDate: current.endDate,
        timezone: current.timezone,
        destinations: structuredClone(current.destinations),
        trafficType: current.trafficType,
        days: structuredClone(current.days),
      };
      if (current.permission === "viewer" || current.permission === "unknown") {
        blockers.push({
          code: "TRIP_NOT_EDITABLE",
          message:
            "The current chicTrip permission does not allow this itinerary to be edited.",
        });
      }
      for (const operation of intent.operations) {
        applyOperation(desired, operation, diff, blockers);
        if (
          operation.op === "set_trip_fields" &&
          !capabilities.write.updateTripFields
        ) {
          blockers.push({
            code: "UPDATE_FIELDS_DISABLED",
            message: "Trip field updates are disabled.",
          });
        }
        if (operation.op === "add_item" && !capabilities.write.addItem) {
          blockers.push({
            code: "ADD_ITEM_DISABLED",
            message: "Adding itinerary items is disabled.",
          });
        }
        if (operation.op === "update_item" && !capabilities.write.updateItem) {
          blockers.push({
            code: "UPDATE_ITEM_DISABLED",
            message: "Updating itinerary items is disabled.",
          });
        }
        if (
          operation.op === "update_item" &&
          operation.fields.note !== undefined
        ) {
          blockers.push({
            code: "ITEM_NOTE_UNSUPPORTED",
            message: "Updating item notes is not covered by a verified contract.",
          });
        }
        if (operation.op === "move_item" && !capabilities.write.moveItem) {
          blockers.push({
            code: "MOVE_ITEM_DISABLED",
            message: "Moving itinerary items is disabled.",
          });
        }
        if (operation.op === "remove_item" && !capabilities.write.removeItem) {
          blockers.push({
            code: "REMOVE_ITEM_DISABLED",
            message: "Removing itinerary items is disabled.",
          });
        }
      }
      if (current.ownership === "collaborating") {
        warnings.push({
          code: "COLLABORATIVE_TRIP",
          message:
            "This is a collaborative trip. Apply will re-check its revision immediately before writing.",
        });
      }
    }

    desired = TripDraftSchema.parse(desired);
    const now = Date.now();
    const previewId = randomUUID();
    const intentHash = sha256(intent);
    const estimatedProviderWrites =
      intent.kind === "create"
        ? 1 +
          intent.desired.days.reduce(
            (sum, day) =>
              sum +
              day.items.reduce(
                (itemSum, item) =>
                  itemSum +
                  1 +
                  Number(
                    item.durationMinutes !== undefined ||
                      item.startsAt !== undefined ||
                      item.categoryId !== undefined,
                  ),
                0,
              ),
            0,
          )
        : intent.operations.reduce((sum, operation) => {
            if (operation.op !== "add_item") return sum + 1;
            return (
              sum +
              1 +
              Number(
                operation.item.durationMinutes !== undefined ||
                  operation.item.startsAt !== undefined ||
                  operation.item.categoryId !== undefined,
              ) +
              Number(operation.afterItemId !== undefined)
            );
          }, 0);
    const preview: ChangePreview = {
      schemaVersion: "1",
      previewId,
      intentHash,
      transport: this.transport.kind,
      accountRefHash: capabilities.accountRefHash,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.config.previewTtlMs).toISOString(),
      ...(baseRevision ? { baseRevision } : {}),
      diff,
      blockers,
      warnings,
      estimatedProviderWrites,
      approval: {
        required: true,
        reviewCode: reviewCode(previewId),
        cliCommand: `chictrip changes approve ${previewId}`,
      },
    };
    const storedPlan = {
      preview,
      intent,
      desired,
      desiredContentHash: tripContentHash(desired),
    };
    const stored: StoredPreview = {
      ...storedPlan,
      executionPlanDigest: executionPlanDigest(storedPlan),
    };
    await this.store.update((state) => {
      state.previews[previewId] = stored;
      for (const [id, candidate] of Object.entries(state.previews)) {
        if (Date.parse(candidate.preview.expiresAt) < Date.now() - 86_400_000) {
          delete state.previews[id];
        }
      }
    });
    return preview;
  }

  async approve(
    previewId: string,
    typedConfirmation: string,
  ): Promise<{
    previewId: string;
    intentHash: string;
    approvedAt: string;
    expiresAt: string;
  }> {
    const state = await this.store.read();
    const stored = state.previews[previewId];
    if (!stored) throw new AppError("NOT_FOUND", `Preview not found: ${previewId}`);
    assertStoredPreviewIntegrity(stored, previewId);
    if (stored.applyClaim) {
      throw new AppError(
        "IDEMPOTENCY_KEY_REUSED",
        "This preview already has a provider write attempt and cannot be approved again.",
      );
    }
    const issued = await this.approval.issue(
      stored.preview,
      stored.executionPlanDigest,
      typedConfirmation,
    );
    const approvedAt = new Date(issued.claims.issuedAt).toISOString();
    const expiresAt = new Date(issued.claims.expiresAt).toISOString();
    await this.store.update((currentState) => {
      const currentStored = currentState.previews[previewId];
      if (!currentStored) {
        throw new AppError("NOT_FOUND", `Preview not found: ${previewId}`);
      }
      assertStoredPreviewIntegrity(currentStored, previewId);
      if (
        currentStored.executionPlanDigest !== stored.executionPlanDigest ||
        currentStored.applyClaim
      ) {
        throw new AppError(
          "APPROVAL_INVALID",
          "The preview changed or was claimed while approval was being recorded.",
        );
      }
      currentStored.approvalGrant = {
        token: issued.token,
        issuedAt: approvedAt,
        expiresAt,
      };
    });
    return {
      previewId,
      intentHash: stored.preview.intentHash,
      approvedAt,
      expiresAt,
    };
  }

  async apply(input: ApplyTripChangeInput): Promise<ApplyTripChangeResult> {
    const request = ApplyTripChangeInputSchema.parse(input);
    const state = await this.store.read();
    const stored = state.previews[request.previewId];
    if (!stored) {
      throw new AppError("NOT_FOUND", `Preview not found: ${request.previewId}`);
    }
    assertStoredPreviewIntegrity(stored, request.previewId);
    if (stored.preview.intentHash !== request.intentHash) {
      throw new AppError("APPROVAL_INVALID", "intentHash does not match the preview.");
    }
    const capabilities = await this.transport.getCapabilities();
    if (!capabilities.authenticated || !capabilities.accountRefHash) {
      throw new AppError("AUTH_REQUIRED", "The chicTrip session is not authenticated.");
    }
    if (
      stored.preview.accountRefHash !== capabilities.accountRefHash ||
      stored.preview.transport !== this.transport.kind
    ) {
      throw new AppError(
        "APPROVAL_INVALID",
        "The preview is bound to a different chicTrip account or transport.",
      );
    }
    const ledgerBinding = {
      previewId: request.previewId,
      intentHash: request.intentHash,
      executionPlanDigest: stored.executionPlanDigest,
      accountRefHash: capabilities.accountRefHash,
      transport: this.transport.kind,
    } satisfies Parameters<typeof assertLedgerBinding>[1];
    const existing = state.ledger[request.idempotencyKey];
    if (existing) {
      assertLedgerBinding(existing, ledgerBinding);
      return ledgerResult(existing);
    }
    if (stored.applyClaim) {
      if (stored.applyClaim.idempotencyKey === request.idempotencyKey) {
        return {
          operationId: stored.applyClaim.operationId,
          status: "indeterminate",
          reconciliation: {
            state: "ambiguous",
            message:
              "This preview was already claimed, but its local ledger entry is unavailable. Do not retry it.",
          },
        };
      }
      throw new AppError(
        "IDEMPOTENCY_KEY_REUSED",
        "This preview already has a provider write attempt. Reconcile that attempt instead of retrying with a new key.",
      );
    }
    if (Date.parse(stored.preview.expiresAt) <= Date.now()) {
      throw new AppError("PREVIEW_EXPIRED", "The preview expired. Create a new one.");
    }
    if (stored.preview.blockers.length > 0) {
      throw new AppError("PREVIEW_BLOCKED", "The preview has unresolved blockers.", {
        details: stored.preview.blockers,
      });
    }
    if (!stored.approvalGrant) {
      throw new AppError(
        "APPROVAL_REQUIRED",
        `Run the interactive local approval command first: chictrip changes approve ${request.previewId}`,
      );
    }
    const approvalToken = stored.approvalGrant.token;
    const claims = await this.approval.verify(approvalToken, {
      ...ledgerBinding,
    });

    if (stored.intent.kind === "update") {
      const current = await this.transport.getTrip(stored.intent.tripId);
      const base = stored.intent.baseRevision;
      if (
        current.revision.contentHash !== base.contentHash ||
        (base.providerVersion &&
          current.revision.providerVersion !== base.providerVersion)
      ) {
        throw new AppError(
          "CONFLICT",
          "The itinerary changed after preview. No write was attempted.",
        );
      }
    }

    const operationId = randomUUID();
    const timestamp = new Date().toISOString();
    const claim = await this.store.update((currentState) => {
      const currentStored = currentState.previews[request.previewId];
      if (!currentStored) {
        throw new AppError("NOT_FOUND", `Preview not found: ${request.previewId}`);
      }
      assertStoredPreviewIntegrity(currentStored, request.previewId);
      if (
        currentStored.preview.intentHash !== request.intentHash ||
        currentStored.executionPlanDigest !== stored.executionPlanDigest ||
        currentStored.preview.accountRefHash !== capabilities.accountRefHash ||
        currentStored.preview.transport !== this.transport.kind
      ) {
        throw new AppError(
          "APPROVAL_INVALID",
          "The preview changed before the write attempt could be claimed.",
        );
      }
      if (Date.parse(currentStored.preview.expiresAt) <= Date.now()) {
        throw new AppError("PREVIEW_EXPIRED", "The preview expired. Create a new one.");
      }
      if (currentStored.preview.blockers.length > 0) {
        throw new AppError(
          "PREVIEW_BLOCKED",
          "The preview has unresolved blockers.",
          { details: currentStored.preview.blockers },
        );
      }
      const collision = currentState.ledger[request.idempotencyKey];
      if (collision) {
        assertLedgerBinding(collision, ledgerBinding);
        return { kind: "existing" as const, entry: structuredClone(collision) };
      }
      if (currentStored.applyClaim) {
        if (currentStored.applyClaim.idempotencyKey === request.idempotencyKey) {
          return {
            kind: "claimed-without-ledger" as const,
            operationId: currentStored.applyClaim.operationId,
          };
        }
        throw new AppError(
          "IDEMPOTENCY_KEY_REUSED",
          "This preview already has a provider write attempt. Reconcile that attempt instead of retrying with a new key.",
        );
      }
      if (currentState.usedApprovalNonces[claims.nonce]) {
        throw new AppError(
          "APPROVAL_INVALID",
          "The confirmation token was already used.",
        );
      }
      if (currentStored.approvalGrant?.token !== approvalToken) {
        throw new AppError(
          "APPROVAL_INVALID",
          "The local approval grant changed before the write attempt was claimed.",
        );
      }
      currentState.usedApprovalNonces[claims.nonce] = timestamp;
      delete currentStored.approvalGrant;
      currentStored.applyClaim = {
        idempotencyKey: request.idempotencyKey,
        operationId,
        approvalNonce: claims.nonce,
        claimedAt: timestamp,
      };
      currentState.ledger[request.idempotencyKey] = {
        idempotencyKey: request.idempotencyKey,
        previewId: request.previewId,
        intentHash: request.intentHash,
        executionPlanDigest: currentStored.executionPlanDigest,
        accountRefHash: capabilities.accountRefHash,
        transport: this.transport.kind,
        operationId,
        status: "in_flight",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return { kind: "claimed" as const, stored: structuredClone(currentStored) };
    });
    if (claim.kind === "existing") return ledgerResult(claim.entry);
    if (claim.kind === "claimed-without-ledger") {
      return {
        operationId: claim.operationId,
        status: "indeterminate",
        reconciliation: {
          state: "ambiguous",
          message:
            "This preview was already claimed, but its local ledger entry is unavailable. Do not retry it.",
        },
      };
    }
    const claimedStored = claim.stored;

    let result: ApplyTripChangeResult;
    let providerMutationReturned = false;
    try {
      const mutation =
        claimedStored.intent.kind === "create"
          ? await this.transport.createTrip(claimedStored.intent.desired, {
              requestId: operationId,
              idempotencyKey: request.idempotencyKey,
              expectedAccountRefHash: capabilities.accountRefHash,
            })
          : await this.transport.updateTrip(
              claimedStored.intent.tripId,
              claimedStored.intent.operations,
              {
                requestId: operationId,
                idempotencyKey: request.idempotencyKey,
                expectedAccountRefHash: capabilities.accountRefHash,
                expectedRevision: claimedStored.intent.baseRevision,
              },
            );
      providerMutationReturned = true;
      const actual = await this.transport.getTrip(mutation.tripId);
      const verified =
        actual.revision.contentHash === claimedStored.desiredContentHash ||
        (tripMatchesDesired(actual, claimedStored.desired) &&
          explicitClearsMatch(actual, claimedStored.intent));
      result = {
        operationId,
        status: verified ? "applied" : "indeterminate",
        tripId: mutation.tripId,
        revision: actual.revision,
        completedSteps: mutation.completedSteps,
        totalSteps: mutation.totalSteps,
        reconciliation: verified
          ? {
              state: "verified",
              message: "The itinerary was read back and matches the approved preview.",
            }
          : {
              state: "ambiguous",
              message:
                "The provider accepted the writes, but the read-back content differs from the preview.",
            },
      };
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(
              "PROVIDER_INDETERMINATE",
              "The provider write outcome could not be determined.",
              {
              cause: error,
              },
            );
      const details =
        typeof appError.details === "object" && appError.details !== null
          ? (appError.details as Record<string, unknown>)
          : {};
      const status =
        providerMutationReturned
          ? "indeterminate"
          : appError.code === "CONFLICT"
            ? "conflict"
            : appError.code === "PROVIDER_PARTIAL"
              ? "partial"
              : appError.code === "PROVIDER_INDETERMINATE" ||
                  appError.code === "PROVIDER_ERROR"
                ? "indeterminate"
                : "failed";
      result = {
        operationId,
        status,
        ...(typeof details.tripId === "string" ? { tripId: details.tripId } : {}),
        ...(typeof details.completedSteps === "number"
          ? { completedSteps: details.completedSteps }
          : {}),
        ...(typeof details.totalSteps === "number"
          ? { totalSteps: details.totalSteps }
          : {}),
        reconciliation: {
          state: "ambiguous",
          message: safeReconciliationMessage(
            providerMutationReturned
              ? "PROVIDER_INDETERMINATE"
              : appError.code,
          ),
        },
      };
    }

    await this.store.update((currentState) => {
      const ledger = currentState.ledger[request.idempotencyKey];
      if (!ledger) return;
      ledger.status =
        result.status === "applied" || result.status === "already_applied"
          ? "applied"
          : result.status === "partial"
            ? "partial"
            : result.status === "indeterminate"
              ? "indeterminate"
              : "failed";
      ledger.result = result;
      ledger.updatedAt = new Date().toISOString();
    });
    return result;
  }
}
