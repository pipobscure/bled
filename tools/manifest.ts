#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleFiles } from "@pipobscure/bundle/files";

// Step 1 of packaging: the list of files that go into the archive, written to
// build/bled.manifest for `bundle create --files`.
//
// Nothing is compiled or bundled. The archive holds the sources node runs (src/),
// the page's modules and assets (web/, public/), and every runtime dependency
// with its own dependencies, because the page imports from node_modules too.
// `npm run smoke` checks the result by starting the packed app.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT = join(ROOT, "build", "bled.manifest");

const { dependencies } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

const files = moduleFiles({
  base: ROOT,
  files: ["package.json"],
  dirs: ["src", "web", "public"],
  dependencies: Object.keys(dependencies),
  // What runs, not what is read about it: no type declarations, source maps or
  // editor config. Licenses stay with the code they cover.
  filter: (name) =>
    !/\.(d\.ts|d\.mts|d\.cts|map|tsbuildinfo)$/.test(name) && name !== "web/tsconfig.json",
});

mkdirSync(join(ROOT, "build"), { recursive: true });
writeFileSync(OUTPUT, `${files.join("\n")}\n`);
const packages = new Set(
  files
    .filter((file) => file.startsWith("node_modules/"))
    .map((file) => {
      const [, scopeOrName, name] = file.split("/");
      return scopeOrName!.startsWith("@") ? `${scopeOrName}/${name}` : scopeOrName;
    }),
);
console.error(`* ${files.length} files (${packages.size} packages) -> build/bled.manifest`);
