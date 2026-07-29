import type {
  ApplyTripChangeInput,
  Destination,
  ListTripsInput,
  PlaceRef,
  SearchDestinationsInput,
  SearchPlacesInput,
  TripChangeIntent,
  TripDraft,
  TripPatchOperation,
  TripRecord,
  TripRevision,
  TripSummary,
} from "./schemas.js";

export type TransportKind = "browser" | "official-api";

export interface TransportCapabilities {
  transport: TransportKind;
  supportLevel: "experimental-undocumented" | "official";
  authenticated: boolean;
  accountRefHash?: string;
  read: {
    listTrips: boolean;
    getTrip: boolean;
    searchPlaces: boolean;
    searchDestinations: boolean;
  };
  write: {
    createTrip: boolean;
    updateTripFields: boolean;
    addItem: boolean;
    updateItem: boolean;
    moveItem: boolean;
    removeItem: boolean;
    deleteTrip: false;
    requiresApproval: true;
    idempotency: "native" | "local-ledger" | "none";
    atomicity: "atomic" | "multi-step";
  };
  caveats: string[];
}

export interface MutationContext {
  requestId: string;
  idempotencyKey: string;
  expectedAccountRefHash: string;
  expectedRevision?: TripRevision;
}

export interface ProviderMutationResult {
  tripId: string;
  providerVersion?: string;
  completedSteps: number;
  totalSteps: number;
}

export interface ChicTripTransport {
  readonly kind: TransportKind;
  getCapabilities(): Promise<TransportCapabilities>;
  listTrips(input: ListTripsInput): Promise<TripSummary[]>;
  getTrip(tripId: string): Promise<TripRecord>;
  searchPlaces(input: SearchPlacesInput): Promise<PlaceRef[]>;
  searchDestinations(input: SearchDestinationsInput): Promise<Destination[]>;
  createTrip(input: TripDraft, context: MutationContext): Promise<ProviderMutationResult>;
  updateTrip(
    tripId: string,
    operations: TripPatchOperation[],
    context: MutationContext,
  ): Promise<ProviderMutationResult>;
}

export interface ChangeDiff {
  path: string;
  action: "add" | "update" | "move" | "remove";
  before?: unknown;
  after?: unknown;
}

export interface PreviewMessage {
  code: string;
  message: string;
}

export interface ChangePreview {
  schemaVersion: "1";
  previewId: string;
  intentHash: string;
  transport: TransportKind;
  accountRefHash: string;
  createdAt: string;
  expiresAt: string;
  baseRevision?: TripRevision;
  diff: ChangeDiff[];
  blockers: PreviewMessage[];
  warnings: PreviewMessage[];
  estimatedProviderWrites: number;
  approval: {
    required: true;
    reviewCode: string;
    cliCommand: string;
  };
}

export type ApplyStatus =
  | "applied"
  | "already_applied"
  | "approval_required"
  | "conflict"
  | "partial"
  | "indeterminate"
  | "failed";

export interface ApplyTripChangeResult {
  operationId: string;
  status: ApplyStatus;
  tripId?: string;
  revision?: TripRevision;
  completedSteps?: number;
  totalSteps?: number;
  reconciliation?: {
    state: "verified" | "not_found" | "ambiguous";
    message: string;
  };
}

export interface ApprovalClaims {
  type: "chictrip-change-approval";
  previewId: string;
  intentHash: string;
  executionPlanDigest: string;
  accountRefHash: string;
  transport: TransportKind;
  audience: "chictrip-apply";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface StoredPreview {
  preview: ChangePreview;
  intent: TripChangeIntent;
  desired: TripDraft;
  desiredContentHash: string;
  executionPlanDigest: string;
  approvalGrant?: {
    token: string;
    issuedAt: string;
    expiresAt: string;
  };
  applyClaim?: {
    idempotencyKey: string;
    operationId: string;
    approvalNonce: string;
    claimedAt: string;
  };
}

export interface MutationLedgerEntry {
  idempotencyKey: string;
  previewId: string;
  intentHash: string;
  executionPlanDigest: string;
  accountRefHash: string;
  transport: TransportKind;
  operationId: string;
  status: "in_flight" | "applied" | "partial" | "indeterminate" | "failed";
  result?: ApplyTripChangeResult;
  createdAt: string;
  updatedAt: string;
}

export interface AgentState {
  schemaVersion: 1;
  previews: Record<string, StoredPreview>;
  usedApprovalNonces: Record<string, string>;
  ledger: Record<string, MutationLedgerEntry>;
}

export interface TripServiceApi {
  capabilities(): Promise<TransportCapabilities>;
  listTrips(input: ListTripsInput): Promise<TripSummary[]>;
  getTrip(tripId: string): Promise<TripRecord>;
  searchPlaces(input: SearchPlacesInput): Promise<PlaceRef[]>;
  searchDestinations(input: SearchDestinationsInput): Promise<Destination[]>;
  preview(intent: TripChangeIntent): Promise<ChangePreview>;
  apply(input: ApplyTripChangeInput): Promise<ApplyTripChangeResult>;
}
