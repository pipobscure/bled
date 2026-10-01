import { registerAi } from "./ai.ts";
import { startServer } from "./server.ts";
import { SettingsStore } from "./settings.ts";
import { AppWindow } from "./window.ts";
import { Workspace } from "./workspace.ts";

const settings = await new SettingsStore().load();
const window = new AppWindow();
const workspace = new Workspace(window, settings);
workspace.register();
registerAi(window, settings);

// Open the folder given on the command line, else the last one used. With
// neither, the page shows the folder picker.
const folder = process.argv[2] ?? settings.get().recent[0];
if (folder) {
  try {
    await workspace.open(folder);
  } catch (error) {
    console.error(`Could not open ${folder}: ${(error as Error).message}`);
  }
}

const { server, url } = await startServer(() => workspace.root);

window.on("event", (name: string, data: unknown) => {
  console.log(`[page] ${name}`, data ?? "");
  // Smoke tests (tools/smoke.ts) only need to know the page came up.
  if (name === "loaded" && process.env.BLED_EXIT_AFTER_LOAD) window.close();
});
window.on("closed", () => {
  server.close();
  process.exit(0);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => window.close());
}

await window.open(url);
console.log(`Running at ${url}${workspace.root ? ` (${workspace.root})` : ""}`);
