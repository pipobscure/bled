import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AiSettings {
  /** OpenAI-compatible API base, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Merged into every request body, e.g. `{"reasoning_effort": "low"}`. */
  extraBody: Record<string, unknown>;
}

export interface Settings {
  /** Most recently opened project folders, newest first. */
  recent: string[];
  ai: AiSettings;
}

const DEFAULTS: Settings = {
  recent: [],
  ai: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "", extraBody: {} },
};
const MAX_RECENT = 10;

function configDir(name = "bled"): string {
  if (process.env.BLED_CONFIG_DIR) return process.env.BLED_CONFIG_DIR;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), name);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", name);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), name);
}

/** Where settings lived before the app was called bled; read once if nothing newer exists. */
const LEGACY_PATH = join(configDir("blog-editor"), "settings.json");

/** User settings persisted as JSON. The file holds the API key, so it's written owner-only. */
export class SettingsStore {
  readonly path = join(configDir(), "settings.json");
  #settings: Settings = structuredClone(DEFAULTS);

  async load(): Promise<this> {
    try {
      const text = await readFile(this.path, "utf8").catch((error) => {
        if (error.code === "ENOENT" && !process.env.BLED_CONFIG_DIR) return readFile(LEGACY_PATH, "utf8");
        throw error;
      });
      const stored = JSON.parse(text) as Partial<Settings>;
      this.#settings = { ...DEFAULTS, ...stored, ai: { ...DEFAULTS.ai, ...stored.ai } };
    } catch {
      // Missing or unreadable: start from defaults.
    }
    return this;
  }

  get(): Settings {
    return this.#settings;
  }

  async update(change: (settings: Settings) => void): Promise<void> {
    change(this.#settings);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.#settings, null, 2) + "\n", { mode: 0o600 });
  }

  addRecent(folder: string): Promise<void> {
    return this.update((settings) => {
      settings.recent = [folder, ...settings.recent.filter((path) => path !== folder)].slice(0, MAX_RECENT);
    });
  }
}
