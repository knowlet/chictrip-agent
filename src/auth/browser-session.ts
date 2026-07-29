import { chmod, mkdir } from "node:fs/promises";
import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright-core";
import type { AppConfig } from "../config.js";
import { AppError } from "../domain/errors.js";

export interface BrowserAuthStatus {
  authenticated: boolean;
  accountRefHash?: string;
}

export async function readBrowserAuthStatusInPage(): Promise<BrowserAuthStatus> {
  const accessToken = window.localStorage.getItem("accessToken");
  const memberId = window.localStorage.getItem("memberId");
  if (!accessToken || !memberId) return { authenticated: false };

  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) return { authenticated: false };
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const payload = JSON.parse(window.atob(padded)) as Record<string, unknown>;
    if (String(payload.sub ?? "") !== memberId) {
      return { authenticated: false };
    }
  } catch {
    return { authenticated: false };
  }

  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(memberId),
  );
  if (
    window.localStorage.getItem("memberId") !== memberId ||
    window.localStorage.getItem("accessToken") !== accessToken
  ) {
    return { authenticated: false };
  }
  const accountRefHash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { authenticated: true, accountRefHash };
}

export class BrowserSession {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfig) {}

  async status(): Promise<BrowserAuthStatus> {
    return this.withPage(true, (page) => this.readAuthStatus(page));
  }

  async login(options: { timeoutMs?: number } = {}): Promise<BrowserAuthStatus> {
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    return this.withPage(false, async (page, context) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const candidates = context
          .pages()
          .filter(
            (candidate) =>
              !candidate.isClosed() &&
              candidate.url().startsWith("https://www.chictrip.com.tw/"),
          );
        if (
          candidates.length === 0 &&
          !page.isClosed() &&
          page.url().startsWith("https://www.chictrip.com.tw/")
        ) {
          candidates.push(page);
        }
        for (const candidate of candidates) {
          try {
            const status = await this.readAuthStatus(candidate);
            if (status.authenticated) return status;
          } catch (error) {
            if (!this.isTransientNavigationError(error)) throw error;
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
      throw new AppError(
        "AUTH_REQUIRED",
        "Timed out waiting for chicTrip login. Run the login command again.",
      );
    });
  }

  async withAuthenticatedPage<T>(
    callback: (page: Page) => Promise<T>,
  ): Promise<T> {
    return this.withPage(true, async (page) => {
      const status = await this.readAuthStatus(page);
      if (!status.authenticated) {
        throw new AppError(
          "AUTH_REQUIRED",
          "chicTrip login is required. Run `chictrip auth login` locally first.",
        );
      }
      return callback(page);
    });
  }

  private async withPage<T>(
    headless: boolean,
    callback: (page: Page, context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.withExclusivePage(headless, callback);
    } finally {
      release();
    }
  }

  private async withExclusivePage<T>(
    headless: boolean,
    callback: (page: Page, context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.config.browserProfileDir, { recursive: true, mode: 0o700 });
    await chmod(this.config.browserProfileDir, 0o700);
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(this.config.browserProfileDir, {
        channel: this.config.browserChannel,
        headless,
        viewport: { width: 1280, height: 900 },
      });
    } catch (error) {
      throw new AppError(
        "AUTH_REQUIRED",
        `Unable to launch the dedicated chicTrip browser profile with channel "${this.config.browserChannel}".`,
        {
          cause: error,
          details: {
            hint:
              "Set CHICTRIP_BROWSER_CHANNEL to an installed Playwright browser channel, such as chrome or msedge.",
          },
        },
      );
    }
    try {
      const existing = context.pages()[0];
      const page = existing ?? (await context.newPage());
      if (!page.url().startsWith("https://www.chictrip.com.tw/")) {
        await page.goto(this.config.siteUrl, { waitUntil: "domcontentloaded" });
      }
      return await callback(page, context);
    } finally {
      await context.close();
    }
  }

  private async readAuthStatus(page: Page): Promise<BrowserAuthStatus> {
    return page.evaluate(readBrowserAuthStatusInPage);
  }

  private isTransientNavigationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("Execution context was destroyed") ||
      message.includes("Cannot find context with specified id") ||
      message.includes("Target page, context or browser has been closed")
    );
  }
}
