import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { AppError } from "../domain/errors.js";
import type {
  ApprovalClaims,
  ChangePreview,
  TransportKind,
} from "../domain/types.js";
import type { JsonStateStore } from "./store.js";

const ApprovalClaimsSchema = z.object({
  type: z.literal("chictrip-change-approval"),
  previewId: z.uuid(),
  intentHash: z.string(),
  executionPlanDigest: z.string(),
  accountRefHash: z.string(),
  transport: z.enum(["browser", "official-api"]),
  audience: z.literal("chictrip-apply"),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  nonce: z.uuid(),
});

function encode(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export class ApprovalService {
  private readonly secretPath: string;

  constructor(
    private readonly store: JsonStateStore,
    private readonly approvalTtlMs: number,
  ) {
    this.secretPath = join(store.stateDir, "approval-secret");
  }

  async issue(
    preview: ChangePreview,
    executionPlanDigest: string,
    typedConfirmation: string,
  ): Promise<{ token: string; claims: ApprovalClaims }> {
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      throw new AppError("PREVIEW_EXPIRED", "The preview has expired. Create a new preview.");
    }
    if (preview.blockers.length > 0) {
      throw new AppError("PREVIEW_BLOCKED", "The preview has unresolved blockers.", {
        details: preview.blockers,
      });
    }
    const expected = `APPLY ${preview.approval.reviewCode}`;
    if (typedConfirmation.trim() !== expected) {
      throw new AppError(
        "APPROVAL_INVALID",
        `Confirmation did not match. Type exactly: ${expected}`,
      );
    }
    const now = Date.now();
    const claims: ApprovalClaims = {
      type: "chictrip-change-approval",
      previewId: preview.previewId,
      intentHash: preview.intentHash,
      executionPlanDigest,
      accountRefHash: preview.accountRefHash,
      transport: preview.transport,
      audience: "chictrip-apply",
      issuedAt: now,
      expiresAt: now + this.approvalTtlMs,
      nonce: randomUUID(),
    };
    const payload = encode(JSON.stringify(claims));
    const signature = encode(createHmac("sha256", await this.secret()).update(payload).digest());
    return { token: `${payload}.${signature}`, claims };
  }

  async verify(
    token: string,
    expected: {
      previewId: string;
      intentHash: string;
      executionPlanDigest: string;
      accountRefHash: string;
      transport: TransportKind;
    },
  ): Promise<ApprovalClaims> {
    const [payload, suppliedSignature, extra] = token.split(".");
    if (!payload || !suppliedSignature || extra) {
      throw new AppError("APPROVAL_INVALID", "Malformed confirmation token.");
    }
    const expectedSignature = createHmac("sha256", await this.secret())
      .update(payload)
      .digest();
    const supplied = decode(suppliedSignature);
    if (
      supplied.length !== expectedSignature.length ||
      !timingSafeEqual(supplied, expectedSignature)
    ) {
      throw new AppError("APPROVAL_INVALID", "Invalid confirmation token signature.");
    }
    let claims: ApprovalClaims;
    try {
      claims = ApprovalClaimsSchema.parse(JSON.parse(decode(payload).toString("utf8")));
    } catch (error) {
      throw new AppError("APPROVAL_INVALID", "Invalid confirmation token claims.", {
        cause: error,
      });
    }
    if (claims.expiresAt <= Date.now()) {
      throw new AppError("APPROVAL_EXPIRED", "The confirmation token has expired.");
    }
    if (
      claims.previewId !== expected.previewId ||
      claims.intentHash !== expected.intentHash ||
      claims.executionPlanDigest !== expected.executionPlanDigest ||
      claims.accountRefHash !== expected.accountRefHash ||
      claims.transport !== expected.transport
    ) {
      throw new AppError(
        "APPROVAL_INVALID",
        "The confirmation token does not match this preview, account, or transport.",
      );
    }
    return claims;
  }

  private async secret(): Promise<Buffer> {
    await this.store.ensure();
    try {
      return await readFile(this.secretPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const secret = randomBytes(32);
      try {
        await writeFile(this.secretPath, secret, { flag: "wx", mode: 0o600 });
        await chmod(this.secretPath, 0o600);
        return secret;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        return readFile(this.secretPath);
      }
    }
  }
}
