import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);

const commands: string[][] = [
  ["bun", "run", "check"],
  ["bun", "run", "test"],
  ["bun", "run", "build"],
  ["node", "dist/cli.mjs", "help"],
];

for (const command of commands) {
  const child = Bun.spawn(command, {
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

const launcherDir = await mkdtemp(join(tmpdir(), "chictrip-launcher-"));
try {
  const launcherPath = join(launcherDir, "chictrip");
  await symlink(resolve(projectRoot, "dist/cli.mjs"), launcherPath);
  const child = Bun.spawn([launcherPath, "help"], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
} finally {
  await rm(launcherDir, { recursive: true, force: true });
}
