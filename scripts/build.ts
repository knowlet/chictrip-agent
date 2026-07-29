import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const distDir = resolve(projectRoot, "dist");
const pluginMcpDir = resolve(projectRoot, "mcp");

await rm(distDir, { recursive: true, force: true });
await rm(resolve(pluginMcpDir, "node_modules"), {
  recursive: true,
  force: true,
});
await mkdir(distDir, { recursive: true });
await mkdir(pluginMcpDir, { recursive: true });

const targets = [
  {
    entrypoint: resolve(projectRoot, "src/cli.ts"),
    outdir: distDir,
    naming: "cli.mjs",
  },
  {
    entrypoint: resolve(projectRoot, "src/mcp/stdio.ts"),
    outdir: pluginMcpDir,
    naming: "server.mjs",
  },
  {
    entrypoint: resolve(projectRoot, "src/mcp/http.ts"),
    outdir: distDir,
    naming: "http.mjs",
  },
] as const;

for (const target of targets) {
  const result = await Bun.build({
    entrypoints: [target.entrypoint],
    outdir: target.outdir,
    naming: target.naming,
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "external",
    packages: "bundle",
    // playwright-core contains guarded runtime requires for optional BiDi
    // modules that static bundlers cannot resolve. Vendor the package beside
    // the plugin entrypoint instead.
    external: ["playwright-core"],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

await cp(
  resolve(projectRoot, "node_modules/playwright-core"),
  resolve(pluginMcpDir, "node_modules/playwright-core"),
  { recursive: true },
);
await cp(
  resolve(projectRoot, "node_modules/playwright-core"),
  resolve(distDir, "node_modules/playwright-core"),
  { recursive: true },
);
await chmod(resolve(distDir, "cli.mjs"), 0o755);
await chmod(resolve(pluginMcpDir, "server.mjs"), 0o755);

process.stderr.write(
  "Built self-contained dist/cli.mjs, dist/http.mjs, and mcp/server.mjs.\n",
);
