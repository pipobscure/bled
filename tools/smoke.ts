#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Starts a packed archive on the example project in a headless browser and waits
// for the page to report that it loaded. That only happens once every module the
// server and the page import has been found inside the archive, so it is the
// check that the manifest is complete.
//
//   node tools/smoke.ts build/bled.run
//
// The archive is mounted directly with --vfs-load, so it can be unsigned.

const archive = process.argv[2];
if (!archive) {
  console.error("usage: node tools/smoke.ts <archive>");
  process.exit(64);
}

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "bled-smoke-"));
const project = join(scratch, "example");
cpSync(join(ROOT, "example"), project, { recursive: true });

const child = spawn(
  process.execPath,
  ["--no-warnings", "--experimental-vfs", `--vfs-load=${resolve(archive)}`, "--", project],
  {
    // A temporary config dir, so the run neither reads nor records real settings.
    env: { ...process.env, HEADLESS: "1", BLED_EXIT_AFTER_LOAD: "1", BLED_CONFIG_DIR: join(scratch, "config") },
    stdio: ["ignore", "pipe", "inherit"],
  },
);

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
const timeout = setTimeout(() => {
  console.error("error: the app did not finish loading within 60s");
  child.kill();
}, 60_000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  rmSync(scratch, { recursive: true, force: true });
  const loaded = /\[page\] loaded[\s\S]*cards: (\d+)/.exec(output);
  if (code !== 0 || !loaded || loaded[1] === "0") {
    console.error(`error: smoke test failed (exit ${code}${loaded ? `, ${loaded[1]} cards` : ", page never loaded"})`);
    process.exit(1);
  }
  console.error(`* ${archive}: the app started and loaded the example project (${loaded[1]} cards)`);
});
