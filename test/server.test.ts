import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
let server: Awaited<ReturnType<typeof startServer>>;

before(async () => {
  server = await startServer(() => fileURLToPath(new URL("../example/", import.meta.url)));
});
after(() => server.server.close());

const get = (path: string) => fetch(new URL(path, server.url));

test("the page carries an import map that its CSP allows by hash", async () => {
  const html = await (await get("/")).text();
  const importMap = /<script type="importmap">(.*?)<\/script>/s.exec(html)?.[1];
  assert.ok(importMap, "import map is inlined");
  const hash = createHash("sha256").update(importMap).digest("base64");
  assert.ok(html.includes(`script-src 'self' 'sha256-${hash}'`), "CSP allows exactly that script");
});

test("page modules are served as JavaScript with their types stripped", async () => {
  const response = await get("/web/citations.ts");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /javascript/);
  const code = await response.text();
  assert.ok(!code.includes("import type"), "type-only imports are removed");
  assert.ok(!code.includes("source: Source"), "annotations are removed");
});

test("every package the page imports resolves through the import map", async () => {
  const html = await (await get("/")).text();
  const { imports } = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(html)![1]!) as {
    imports: Record<string, string>;
  };
  const specifiers = new Set<string>();
  for (const file of readdirSync(WEB).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(WEB + file, "utf8");
    for (const match of source.matchAll(/^import (?!type\b)[^"']*["']([^."'][^"']*)["']/gm)) specifiers.add(match[1]!);
  }
  assert.ok(specifiers.size > 5);
  for (const specifier of specifiers) {
    assert.ok(imports[specifier], `${specifier} is in the import map`);
    assert.equal((await get(imports[specifier]!)).status, 200, `${specifier} -> ${imports[specifier]}`);
  }
});

test("only the served directories are reachable", async () => {
  assert.equal((await get("/files/post.md")).status, 200);
  assert.equal((await get("/files/../package.json")).status, 404);
  assert.equal((await get("/files/..%2Fpackage.json")).status, 403, "encoded traversal is refused");
  assert.equal((await get("/node_modules/marked/package.json")).status, 403);
  assert.equal((await get("/web/../src/settings.ts")).status, 404);
});
