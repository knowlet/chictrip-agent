import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import type { BrowserSession } from "../src/auth/browser-session.js";
import type { AppConfig } from "../src/config.js";
import {
  BrowserApiClient,
  requestInBrowserPage,
  serializeProviderEntries,
  type BrowserRequestPayload,
  type BrowserRequestResult,
} from "../src/provider/browser-api.js";

function config(): AppConfig {
  return {
    stateDir: "/private/tmp/chictrip-browser-api-test",
    browserProfileDir: "/private/tmp/chictrip-browser-api-test/browser",
    browserChannel: "chrome",
    enableUndocumentedWrites: false,
    enableExperimentalItemAdds: false,
    previewTtlMs: 15 * 60_000,
    approvalTtlMs: 5 * 60_000,
    apiBaseUrl: "https://api.chictrip.com.tw/",
    providerClientVersion: "2.0.38",
    siteUrl: "https://www.chictrip.com.tw/landing",
    httpHost: "127.0.0.1",
    httpPort: 3333,
  };
}

function jwt(subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString(
    "base64url",
  );
  return `${header}.${payload}.test-signature`;
}

function accountHash(memberId: string): string {
  return createHash("sha256").update(memberId).digest("hex");
}

function requestPayload(
  expectedAccountRefHash = accountHash("member-a"),
): BrowserRequestPayload {
  return {
    apiBaseUrl: "https://api.chictrip.com.tw/",
    providerClientVersion: "2.0.38",
    method: "PUT",
    path: "/TravelSchedule/UpdateV3",
    expectedAccountRefHash,
    bodyEntries: [["Name", "東京"]],
    bodyEncoding: "form",
  };
}

type FakeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

async function withFakeWindow<T>(
  values: {
    memberId: string;
    accessToken: string;
    refreshToken?: string;
  },
  fetch: FakeFetch,
  callback: (storage: Map<string, string>) => Promise<T>,
  crypto: Crypto = globalThis.crypto,
): Promise<T> {
  const storage = new Map<string, string>(
    Object.entries(values).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
      crypto,
      fetch,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
  });
  try {
    return await callback(storage);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "window", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
}

describe("BrowserApiClient wire contract", () => {
  test("serializes arrays with Axios-compatible bracket keys", () => {
    expect(
      serializeProviderEntries({
        LocationKey: ["7,7,0", "7,8,0"],
        destinationList: [],
        id: "",
        count: 2,
        skipped: null,
        object: { id: "x" },
      }),
    ).toEqual([
      ["LocationKey[]", "7,7,0"],
      ["LocationKey[]", "7,8,0"],
      ["id", ""],
      ["count", "2"],
      ["object", '{"id":"x"}'],
    ]);
  });

  test("passes the current client version, language, account binding, and serialized form to the page", async () => {
    let evaluatedInput: unknown;
    const page = {
      evaluate: async (_callback: unknown, input: unknown) => {
        evaluatedInput = input;
        return {
          httpStatus: 200,
          envelope: { apiStatus: "001", data: { ok: true }, message: null },
        };
      },
    } as unknown as Page;
    const session = {
      withAuthenticatedPage: async <T>(
        callback: (authenticatedPage: Page) => Promise<T>,
      ) => callback(page),
    } as unknown as BrowserSession;
    const client = new BrowserApiClient(session, config());

    await client.request({
      method: "POST",
      path: "/TravelSchedule/AddV2",
      expectedAccountRefHash: "account-a",
      language: "zh-tw",
      bodyEncoding: "form",
      body: {
        TravelScheduleUserLabelId: "system-unlabeled",
        LocationKey: ["7,7,0", "7,8,0"],
      },
    });

    expect(evaluatedInput).toMatchObject({
      providerClientVersion: "2.0.38",
      expectedAccountRefHash: "account-a",
      language: "zh-tw",
      bodyEncoding: "form",
      bodyEntries: [
        ["TravelScheduleUserLabelId", "system-unlabeled"],
        ["LocationKey[]", "7,7,0"],
        ["LocationKey[]", "7,8,0"],
      ],
    });
  });

  test("rejects an account mismatch reported inside the authenticated page before returning data", async () => {
    const page = {
      evaluate: async () => ({
        httpStatus: 409,
        accountMismatch: true,
        envelope: { apiStatus: "", data: null, message: null },
      }),
    } as unknown as Page;
    const session = {
      withAuthenticatedPage: async <T>(
        callback: (authenticatedPage: Page) => Promise<T>,
      ) => callback(page),
    } as unknown as BrowserSession;
    const client = new BrowserApiClient(session, config());

    await expect(
      client.request({
        method: "PUT",
        path: "/TravelSchedule/UpdateV3",
        expectedAccountRefHash: "account-a",
        bodyEncoding: "form",
        body: { Name: "不應送到其他帳號" },
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  test("marks a mutation evaluation failure as indeterminate", async () => {
    const page = {
      evaluate: async () => {
        throw new Error("response body ended before JSON parsing");
      },
    } as unknown as Page;
    const session = {
      withAuthenticatedPage: async <T>(
        callback: (authenticatedPage: Page) => Promise<T>,
      ) => callback(page),
    } as unknown as BrowserSession;
    const client = new BrowserApiClient(session, config());

    await expect(
      client.request({
        method: "PUT",
        path: "/TravelSchedule/UpdateV3",
        expectedAccountRefHash: accountHash("member-a"),
        bodyEncoding: "form",
        body: { Name: "結果不明" },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_INDETERMINATE" });
  });
});

describe("in-page account binding", () => {
  test("blocks a mixed member/token tuple before any provider fetch", async () => {
    let fetchCalls = 0;
    const result = await withFakeWindow<BrowserRequestResult>(
      {
        memberId: "member-a",
        accessToken: jwt("member-b"),
        refreshToken: "refresh-a",
      },
      async () => {
        fetchCalls += 1;
        throw new Error("fetch must not run");
      },
      () => requestInBrowserPage(requestPayload()),
    );

    expect(result.accountMismatch).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  test("blocks a token switch while the account digest is pending", async () => {
    let fetchCalls = 0;
    let storageRef: Map<string, string> | undefined;
    const delayedCrypto = {
      subtle: {
        digest: async (
          algorithm: AlgorithmIdentifier,
          data: BufferSource,
        ): Promise<ArrayBuffer> => {
          storageRef?.set("accessToken", jwt("member-b"));
          return globalThis.crypto.subtle.digest(algorithm, data);
        },
      },
    } as Crypto;
    const result = await withFakeWindow<BrowserRequestResult>(
      {
        memberId: "member-a",
        accessToken: jwt("member-a"),
        refreshToken: "refresh-a",
      },
      async () => {
        fetchCalls += 1;
        throw new Error("fetch must not run");
      },
      async (storage) => {
        storageRef = storage;
        return requestInBrowserPage(requestPayload());
      },
      delayedCrypto,
    );

    expect(result.accountMismatch).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  test("rejects a refreshed token for a different member before retrying", async () => {
    const urls: string[] = [];
    const result = await withFakeWindow<BrowserRequestResult>(
      {
        memberId: "member-a",
        accessToken: jwt("member-a"),
        refreshToken: "refresh-a",
      },
      async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/Token/Refresh")) {
          return new Response(
            JSON.stringify({
              apiStatus: "001",
              data: {
                memberId: "member-b",
                accessToken: jwt("member-b"),
                refreshToken: "refresh-b",
              },
            }),
          );
        }
        return new Response(JSON.stringify({ apiStatus: "003", data: null }));
      },
      () => requestInBrowserPage(requestPayload()),
    );

    expect(result.accountMismatch).toBe(true);
    expect(urls).toHaveLength(2);
    expect(urls.at(-1)).toEndWith("/Token/Refresh");
  });

  test("uses only a same-subject refreshed token for the mutation retry", async () => {
    const authorizations: string[] = [];
    const refreshedToken = jwt("member-a");
    const result = await withFakeWindow<BrowserRequestResult>(
      {
        memberId: "member-a",
        accessToken: jwt("member-a"),
        refreshToken: "refresh-a",
      },
      async (input, init) => {
        const url = String(input);
        if (url.endsWith("/Token/Refresh")) {
          return new Response(
            JSON.stringify({
              apiStatus: "001",
              data: {
                accessToken: refreshedToken,
                refreshToken: "refresh-next",
              },
            }),
          );
        }
        authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
        return new Response(
          JSON.stringify({
            apiStatus: authorizations.length === 1 ? "003" : "001",
            data: { travelScheduleUpdateTime: "2" },
          }),
        );
      },
      () => requestInBrowserPage(requestPayload()),
    );

    expect(result.envelope.apiStatus).toBe("001");
    expect(authorizations).toHaveLength(2);
    expect(authorizations[1]).toBe(`Bearer ${refreshedToken}`);
  });
});
