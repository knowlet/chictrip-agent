import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AppConfig {
  stateDir: string;
  browserProfileDir: string;
  browserChannel: string;
  enableUndocumentedWrites: boolean;
  enableExperimentalItemAdds: boolean;
  previewTtlMs: number;
  approvalTtlMs: number;
  apiBaseUrl: string;
  providerClientVersion: string;
  siteUrl: string;
  httpHost: string;
  httpPort: number;
  httpBearerToken?: string;
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const stateDir = resolve(
    env.CHICTRIP_STATE_DIR ?? join(homedir(), ".local", "share", "chictrip-agent"),
  );
  return {
    stateDir,
    browserProfileDir: resolve(
      env.CHICTRIP_BROWSER_PROFILE_DIR ?? join(stateDir, "browser-profile"),
    ),
    browserChannel: env.CHICTRIP_BROWSER_CHANNEL ?? "chrome",
    enableUndocumentedWrites: envFlag(env.CHICTRIP_ENABLE_UNDOCUMENTED_WRITES),
    enableExperimentalItemAdds: envFlag(
      env.CHICTRIP_ENABLE_EXPERIMENTAL_ITEM_ADDS,
    ),
    previewTtlMs: 15 * 60_000,
    approvalTtlMs: 5 * 60_000,
    apiBaseUrl: "https://api.chictrip.com.tw/",
    providerClientVersion:
      env.CHICTRIP_PROVIDER_CLIENT_VERSION ?? "2.0.38",
    siteUrl: "https://www.chictrip.com.tw/landing",
    httpHost: env.CHICTRIP_MCP_HOST ?? "127.0.0.1",
    httpPort: Number.parseInt(env.CHICTRIP_MCP_PORT ?? "3333", 10),
    ...(env.CHICTRIP_MCP_BEARER_TOKEN
      ? { httpBearerToken: env.CHICTRIP_MCP_BEARER_TOKEN }
      : {}),
  };
}
