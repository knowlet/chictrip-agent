import { describe, expect, test } from "bun:test";
import {
  hasDisallowedOrigin,
  isAuthorizedBearer,
  isJsonContentType,
  resolveHttpBearerCredential,
} from "../src/mcp/http.js";

const bearerToken = "test-bearer-token-that-is-at-least-32-characters";

describe("MCP HTTP security boundary", () => {
  test("generates a strong ephemeral bearer or accepts a configured one", () => {
    const generated = resolveHttpBearerCredential(undefined);
    expect(generated.generated).toBe(true);
    expect(generated.token.length).toBeGreaterThanOrEqual(43);

    const configured = resolveHttpBearerCredential(bearerToken);
    expect(configured).toEqual({ token: bearerToken, generated: false });
    expect(() => resolveHttpBearerCredential("too-short")).toThrow(
      /32-4096/,
    );
  });

  test("compares bearer credentials strictly", () => {
    expect(isAuthorizedBearer(`Bearer ${bearerToken}`, bearerToken)).toBe(true);
    expect(isAuthorizedBearer(`bearer ${bearerToken}`, bearerToken)).toBe(false);
    expect(isAuthorizedBearer(`Bearer ${bearerToken} extra`, bearerToken)).toBe(
      false,
    );
    expect(isAuthorizedBearer(undefined, bearerToken)).toBe(false);
  });

  test("accepts only JSON media types", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/problem+json")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });

  test("rejects every browser Origin and permits origin-less MCP clients", () => {
    expect(hasDisallowedOrigin("https://attacker.invalid")).toBe(true);
    expect(hasDisallowedOrigin("null")).toBe(true);
    expect(hasDisallowedOrigin(undefined)).toBe(false);
  });
});
