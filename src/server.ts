import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Everything is resolved from the app's own root, so it works the same from a
// checkout and from inside a mounted bundle.
const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC_DIR = join(APP_ROOT, "public");
const WEB_DIR = join(APP_ROOT, "web");
const NODE_MODULES = join(APP_ROOT, "node_modules");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8", // served with its types stripped
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

/**
 * Serves the UI on a random loopback port. Nothing is bundled:
 *  - `/`: public/index.html, with an import map for the page's npm dependencies
 *  - `/web/*`: the page's modules; TypeScript has its types stripped by node
 *  - `/node_modules/*`: the ES modules the import map points at
 *  - `/files/*`: the open project folder (images referenced from markdown)
 *  - everything else: `public/`
 */
export async function startServer(projectRoot: () => string | null): Promise<{ server: Server; url: string }> {
  const importMap = buildImportMap();

  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    try {
      let body: string | Uint8Array;
      let path: string;
      if (pathname === "/" || pathname === "/index.html") {
        path = join(PUBLIC_DIR, "index.html");
        body = withImportMap(await readFile(path, "utf8"), await importMap);
      } else if (pathname.startsWith("/web/")) {
        path = withinDir(WEB_DIR, pathname.slice("/web/".length));
        body = extname(path) === ".ts" ? stripTypeScriptTypes(await readFile(path, "utf8")) : await readFile(path);
      } else if (pathname.startsWith("/node_modules/")) {
        path = withinDir(NODE_MODULES, pathname.slice("/node_modules/".length));
        if (![".js", ".mjs", ".css"].includes(extname(path))) throw Object.assign(new Error("Not served"), { code: "OUTSIDE" });
        body = await readFile(path);
      } else if (pathname.startsWith("/files/")) {
        const root = projectRoot();
        if (!root) throw Object.assign(new Error("No folder open"), { code: "ENOENT" });
        path = withinDir(root, pathname.slice("/files/".length));
        body = await readFile(path);
      } else {
        path = withinDir(PUBLIC_DIR, pathname.slice(1));
        body = await readFile(path);
      }
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(path)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") res.writeHead(404).end();
      else if (code === "EACCES" || code === "OUTSIDE") res.writeHead(403).end();
      else {
        console.error(error);
        res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
      }
    }
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Unexpected server address");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

/**
 * Inlines the import map before the page's first script, and allows exactly
 * that script in the Content-Security-Policy by its hash.
 */
function withImportMap(html: string, importMap: string): string {
  const hash = createHash("sha256").update(importMap).digest("base64");
  return html
    .replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`)
    .replace("<!-- import map -->", `<script type="importmap">${importMap}</script>`);
}

/**
 * Maps every installed package to its ES module entry (and `name/` to its
 * directory, for subpath imports), so the page can import npm packages by name.
 */
async function buildImportMap(): Promise<string> {
  const imports: Record<string, string> = {};
  const names: string[] = [];
  for (const entry of await readdir(NODE_MODULES, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!entry.name.startsWith("@")) names.push(entry.name);
    else for (const scoped of await readdir(join(NODE_MODULES, entry.name))) names.push(`${entry.name}/${scoped}`);
  }
  for (const name of names) {
    let manifest: PackageJson;
    try {
      manifest = JSON.parse(await readFile(join(NODE_MODULES, name, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const entry = moduleEntry(manifest);
    if (entry) imports[name] = `/node_modules/${name}/${entry.replace(/^\.\//, "")}`;
    imports[`${name}/`] = `/node_modules/${name}/`;
  }
  return JSON.stringify({ imports });
}

interface PackageJson {
  exports?: unknown;
  module?: string;
  main?: string;
}

/** The file a browser should load for `import "name"`: the ESM side of `exports`, else `module`/`main`. */
function moduleEntry(manifest: PackageJson): string | null {
  const pick = (target: unknown): string | null => {
    if (typeof target === "string") return target;
    if (Array.isArray(target)) return pick(target[0]);
    if (target && typeof target === "object") {
      const conditions = target as Record<string, unknown>;
      for (const condition of ["browser", "import", "module", "default"]) {
        if (condition in conditions) return pick(conditions[condition]);
      }
    }
    return null;
  };
  const { exports } = manifest;
  const root =
    exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))
      ? (exports as Record<string, unknown>)["."]
      : exports;
  return pick(root) ?? manifest.module ?? manifest.main ?? null;
}

function withinDir(dir: string, path: string): string {
  const root = resolve(dir);
  const absolute = resolve(root, path);
  if (!absolute.startsWith(root + sep)) throw Object.assign(new Error("Outside served directory"), { code: "OUTSIDE" });
  return absolute;
}
