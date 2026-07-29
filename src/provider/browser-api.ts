import type { Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import { AppError } from "../domain/errors.js";
import type { BrowserSession } from "../auth/browser-session.js";

export interface ProviderEnvelope<T = unknown> {
  apiStatus: string;
  data: T;
  message?: string | null;
}

export type BodyEncoding = "form" | "multipart" | "json";

export interface ProviderRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  expectedAccountRefHash?: string;
  language?: "zhtw" | "zh-tw";
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  bodyEncoding?: BodyEncoding;
  acceptedStatuses?: string[];
}

export interface ProviderApiClient {
  request<T = unknown>(
    request: ProviderRequest,
  ): Promise<ProviderEnvelope<T>>;
}

const ALLOWED_ENDPOINTS = new Set([
  "/Location/SearchV2",
  "/PoiSearch/SearchByKeyword",
  "/TravelSchedule/GetMyAndCollaboration",
  "/TravelSchedule/GetSystemCoverList",
  "/TravelScheduleUserLabel/Get",
  "/TravelSchedule/AddV2",
  "/TravelSchedule/UpdateV3",
  "/TravelScheduleDetail/Get",
  "/TravelScheduleDetail/GetAddWhere",
  "/TravelScheduleDetail/Add",
  "/TravelScheduleDetail/GetEditInfo",
  "/TravelScheduleDetail/Update",
  "/TravelScheduleDetail/Delete",
  "/TravelScheduleDetail/Sort",
  "/TravelScheduleDetail/VerifyUpdateTime",
]);

export interface BrowserRequestPayload {
  apiBaseUrl: string;
  providerClientVersion: string;
  method: ProviderRequest["method"];
  path: string;
  expectedAccountRefHash?: string;
  language?: "zhtw" | "zh-tw";
  queryEntries?: Array<[string, string]>;
  body?: Record<string, unknown>;
  bodyEntries?: Array<[string, string]>;
  bodyEncoding?: BodyEncoding;
}

export interface BrowserRequestResult {
  httpStatus: number;
  envelope: ProviderEnvelope;
  accountMismatch?: boolean;
}

export function serializeProviderEntries(
  values: Record<string, unknown>,
): Array<[string, string]> {
  const output: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const isArray = Array.isArray(value);
    const entries = isArray ? value : [value];
    const wireKey = isArray ? `${key}[]` : key;
    for (const entry of entries) {
      output.push([
        wireKey,
        typeof entry === "object" && entry !== null
          ? JSON.stringify(entry)
          : String(entry),
      ]);
    }
  }
  return output;
}

export async function requestInBrowserPage(
  input: BrowserRequestPayload,
): Promise<BrowserRequestResult> {
  interface CredentialSnapshot {
    memberId: string;
    accessToken: string;
    refreshToken: string | null;
  }

  const unauthorized = (): BrowserRequestResult => ({
    httpStatus: 401,
    envelope: { apiStatus: "003", data: null, message: null },
  });
  const accountMismatch = (): BrowserRequestResult => ({
    httpStatus: 409,
    accountMismatch: true,
    envelope: { apiStatus: "", data: null, message: null },
  });
  const tokenSubject = (accessToken: string): string | undefined => {
    try {
      const parts = accessToken.split(".");
      if (parts.length !== 3 || !parts[1]) return undefined;
      const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
      const payload = JSON.parse(window.atob(padded)) as Record<string, unknown>;
      return payload.sub === undefined ? undefined : String(payload.sub);
    } catch {
      return undefined;
    }
  };
  const captureCredentials = (): CredentialSnapshot | undefined => {
    const memberId = window.localStorage.getItem("memberId");
    const accessToken = window.localStorage.getItem("accessToken");
    if (!memberId || !accessToken) return undefined;
    return {
      memberId,
      accessToken,
      refreshToken: window.localStorage.getItem("refreshToken"),
    };
  };
  const snapshotIsCurrent = (snapshot: CredentialSnapshot): boolean =>
    window.localStorage.getItem("memberId") === snapshot.memberId &&
    window.localStorage.getItem("accessToken") === snapshot.accessToken &&
    window.localStorage.getItem("refreshToken") === snapshot.refreshToken;
  const credentialsMatch = async (
    snapshot: CredentialSnapshot,
  ): Promise<boolean> => {
    if (tokenSubject(snapshot.accessToken) !== snapshot.memberId) return false;
    if (input.expectedAccountRefHash) {
      const digest = await window.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(snapshot.memberId),
      );
      const actual = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (actual !== input.expectedAccountRefHash) return false;
    }
    return snapshotIsCurrent(snapshot);
  };
  const perform = async (accessToken: string): Promise<BrowserRequestResult> => {
    const url = new URL(input.path, input.apiBaseUrl);
    if (input.queryEntries) {
      for (const [key, value] of input.queryEntries) {
        url.searchParams.append(key, value);
      }
    }
    const headers = new Headers({
      Authorization: `Bearer ${accessToken}`,
      osType: "web",
      language: input.language ?? "zhtw",
      version: input.providerClientVersion,
    });
    let body: BodyInit | undefined;
    if (input.body || input.bodyEntries) {
      if (input.bodyEncoding === "form") {
        const form = new URLSearchParams();
        for (const [key, value] of input.bodyEntries ?? []) {
          form.append(key, value);
        }
        body = form;
        headers.set("Content-Type", "application/x-www-form-urlencoded");
      } else if (input.bodyEncoding === "json") {
        body = JSON.stringify(input.body);
        headers.set("Content-Type", "application/json");
      } else {
        const form = new FormData();
        for (const [key, value] of input.bodyEntries ?? []) {
          form.append(key, value);
        }
        body = form;
      }
    }
    const response = await window.fetch(url, {
      method: input.method,
      headers,
      ...(body ? { body } : {}),
    });
    const raw = (await response.json()) as Record<string, unknown>;
    const apiStatus = String(raw.apiStatus ?? raw.ApiStatus ?? "");
    return {
      httpStatus: response.status,
      envelope: {
        apiStatus,
        data: raw.data,
        message: typeof raw.message === "string" ? raw.message : null,
      },
    };
  };

  const snapshot = captureCredentials();
  if (!snapshot) return unauthorized();
  if (!(await credentialsMatch(snapshot))) {
    return input.expectedAccountRefHash ? accountMismatch() : unauthorized();
  }

  let result = await perform(snapshot.accessToken);
  if (result.envelope.apiStatus !== "003" || !snapshot.refreshToken) {
    return result;
  }

  const refreshBody = new FormData();
  refreshBody.append("refreshToken", snapshot.refreshToken);
  refreshBody.append("memberId", snapshot.memberId);
  const refreshResponse = await window.fetch(
    new URL("/Token/Refresh", input.apiBaseUrl),
    {
      method: "POST",
      headers: {
        osType: "web",
        language: "zhtw",
        version: input.providerClientVersion,
      },
      body: refreshBody,
    },
  );
  const refreshRaw = (await refreshResponse.json()) as Record<string, unknown>;
  const refreshStatus = String(refreshRaw.apiStatus ?? refreshRaw.ApiStatus ?? "");
  const refreshData =
    typeof refreshRaw.data === "object" && refreshRaw.data !== null
      ? (refreshRaw.data as Record<string, unknown>)
      : {};
  if (refreshStatus !== "001" || typeof refreshData.accessToken !== "string") {
    return result;
  }

  const refreshedAccessToken = refreshData.accessToken;
  const refreshedMemberId =
    typeof refreshData.memberId === "string"
      ? refreshData.memberId
      : snapshot.memberId;
  if (
    refreshedMemberId !== snapshot.memberId ||
    tokenSubject(refreshedAccessToken) !== snapshot.memberId ||
    !snapshotIsCurrent(snapshot)
  ) {
    return input.expectedAccountRefHash ? accountMismatch() : unauthorized();
  }

  window.localStorage.setItem("accessToken", refreshedAccessToken);
  if (typeof refreshData.refreshToken === "string") {
    window.localStorage.setItem("refreshToken", refreshData.refreshToken);
  }
  window.localStorage.setItem("memberId", refreshedMemberId);
  result = await perform(refreshedAccessToken);
  return result;
}

export class BrowserApiClient implements ProviderApiClient {
  constructor(
    private readonly session: BrowserSession,
    private readonly config: AppConfig,
  ) {}

  async request<T = unknown>(request: ProviderRequest): Promise<ProviderEnvelope<T>> {
    if (!ALLOWED_ENDPOINTS.has(request.path)) {
      throw new AppError(
        "UNSUPPORTED_CAPABILITY",
        `Provider endpoint is not allowlisted: ${request.path}`,
      );
    }
    let pageEvaluationStarted = false;
    let result: BrowserRequestResult;
    try {
      result = await this.session.withAuthenticatedPage((page) => {
        pageEvaluationStarted = true;
        return this.requestInPage(page, {
          apiBaseUrl: this.config.apiBaseUrl,
          providerClientVersion: this.config.providerClientVersion,
          method: request.method,
          path: request.path,
          ...(request.expectedAccountRefHash
            ? { expectedAccountRefHash: request.expectedAccountRefHash }
            : {}),
          ...(request.language ? { language: request.language } : {}),
          ...(request.query
            ? { queryEntries: serializeProviderEntries(request.query) }
            : {}),
          ...(request.body && request.bodyEncoding === "json"
            ? { body: request.body }
            : request.body
              ? { bodyEntries: serializeProviderEntries(request.body) }
              : {}),
          ...(request.bodyEncoding ? { bodyEncoding: request.bodyEncoding } : {}),
        });
      });
    } catch (error) {
      if (request.method !== "GET" && pageEvaluationStarted) {
        throw new AppError(
          "PROVIDER_INDETERMINATE",
          "A chicTrip mutation may have been sent, but no parseable provider response was received.",
          { cause: error },
        );
      }
      throw error;
    }
    if (result.accountMismatch) {
      throw new AppError(
        "APPROVAL_INVALID",
        "The authenticated chicTrip account changed before the provider request.",
      );
    }
    const accepted = request.acceptedStatuses ?? ["001"];
    if (!accepted.includes(result.envelope.apiStatus)) {
      if (result.envelope.apiStatus === "003") {
        throw new AppError(
          "AUTH_REQUIRED",
          "The chicTrip browser session is no longer authenticated.",
        );
      }
      if (result.envelope.apiStatus === "004") {
        throw new AppError("CONFLICT", "chicTrip reports a newer itinerary revision.", {
          details: { providerStatus: result.envelope.apiStatus },
        });
      }
      if (result.envelope.apiStatus === "006") {
        throw new AppError(
          "CONFLICT",
          "This account no longer has permission to edit the itinerary.",
          { details: { providerStatus: result.envelope.apiStatus } },
        );
      }
      throw new AppError(
        "PROVIDER_ERROR",
        result.envelope.message || `chicTrip returned status ${result.envelope.apiStatus}.`,
        {
          retryable: result.httpStatus >= 500,
          details: {
            providerStatus: result.envelope.apiStatus,
            httpStatus: result.httpStatus,
          },
        },
      );
    }
    return result.envelope as ProviderEnvelope<T>;
  }

  private async requestInPage(
    page: Page,
    request: BrowserRequestPayload,
  ): Promise<BrowserRequestResult> {
    return page.evaluate(requestInBrowserPage, request);
  }
}
