import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { AgentState } from "../domain/types.js";

const EMPTY_STATE: AgentState = {
  schemaVersion: 1,
  previews: {},
  usedApprovalNonces: {},
  ledger: {},
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class JsonStateStore {
  readonly stateDir: string;
  readonly statePath: string;
  readonly lockPath: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.statePath = join(stateDir, "state.json");
    this.lockPath = join(stateDir, "state.lock");
  }

  async ensure(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
  }

  async read(): Promise<AgentState> {
    await this.ensure();
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as AgentState;
      if (parsed.schemaVersion !== 1) throw new Error("Unsupported state schema.");
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  async update<T>(mutate: (state: AgentState) => T | Promise<T>): Promise<T> {
    await this.ensure();
    const release = await this.acquireLock();
    try {
      const state = await this.read();
      const result = await mutate(state);
      await this.write(state);
      return result;
    } finally {
      await release();
    }
  }

  private async write(state: AgentState): Promise<void> {
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.statePath);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
        return async () => {
          await handle.close();
          await unlink(this.lockPath).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > 30_000) {
            await unlink(this.lockPath);
            continue;
          }
        } catch {
          continue;
        }
        await delay(25);
      }
    }
    throw new Error("Timed out waiting for the local state lock.");
  }
}
