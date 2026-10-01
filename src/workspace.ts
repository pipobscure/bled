import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadProject } from "./project.ts";
import type { SettingsStore } from "./settings.ts";
import type { AppWindow } from "./window.ts";

const IGNORED = /(^|\/)(\.git|node_modules)(\/|$)/;

/** The open project folder (if any), with file access confined to it and changes pushed to the page. */
export class Workspace {
  root: string | null = null;
  #window: AppWindow;
  #settings: SettingsStore;
  #watcher: FSWatcher | null = null;

  constructor(window: AppWindow, settings: SettingsStore) {
    this.#window = window;
    this.#settings = settings;
  }

  async open(folder: string): Promise<void> {
    const root = resolve(folder.startsWith("~") ? join(homedir(), folder.slice(1)) : folder);
    if (!(await stat(root)).isDirectory()) throw new Error(`Not a folder: ${root}`);
    this.#watcher?.close();
    this.root = root;
    this.#watcher = this.#watch(root);
    await this.#settings.addRecent(root);
  }

  /** Resolves a project-relative path, refusing anything outside the project. */
  resolve(path: unknown): string {
    if (!this.root) throw new Error("No folder is open");
    if (typeof path !== "string" || path === "") throw new Error("Expected a non-empty path");
    const absolute = resolve(this.root, path);
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) throw new Error(`Outside the project: ${path}`);
    return absolute;
  }

  register(): void {
    this.#window
      .handle("workspace.open", async ({ path }) => {
        await this.open(path);
        return this.root;
      })
      .handle("workspace.recent", async () => {
        const recent = await Promise.all(
          this.#settings.get().recent.map(async (path) => ({ path, name: basename(path), exists: await exists(path) })),
        );
        return recent.filter((entry) => entry.exists);
      })
      .handle("workspace.listDir", ({ path }) => listDir(typeof path === "string" && path ? path : (this.root ?? homedir())))
      .handle("project.load", () => (this.root ? loadProject(this.root) : null))
      .handle("file.read", async ({ path }) => {
        try {
          return await readFile(this.resolve(path), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      })
      .handle("file.write", async ({ path, content }) => {
        const target = this.resolve(path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, String(content));
      })
      .handle("shell.openExternal", ({ url }) => {
        if (typeof url !== "string" || !/^(https?|mailto):/i.test(url)) throw new Error(`Refusing to open ${url}`);
        const [command, args] =
          process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
              : ["xdg-open", [url]];
        spawn(command, args as string[], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
      });
  }

  /** Batches file system events and tells the page which files changed. */
  #watch(root: string): FSWatcher {
    let changed = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename || this.root !== root) return;
      const path = relative(root, resolve(root, filename)).split(sep).join("/");
      if (IGNORED.test(path)) return;
      changed.add(path);
      clearTimeout(timer);
      timer = setTimeout(() => {
        void this.#window.send("project.changed", { paths: [...changed] });
        changed = new Set();
      }, 100);
    });
    watcher.unref();
    return watcher;
  }
}

/** Subfolders of `path` for the folder picker, flagging ones that look like projects. */
async function listDir(path: string) {
  const dir = resolve(path.startsWith("~") ? join(homedir(), path.slice(1)) : path);
  const entries = await readdir(dir, { withFileTypes: true });
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => ({
        name: entry.name,
        project: await exists(join(dir, entry.name, "research.md")),
      })),
  );
  folders.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    home: homedir(),
    project: await exists(join(dir, "research.md")),
    folders,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
