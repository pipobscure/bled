import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Launcher } from "chrome-launcher";

// The whole app in a headless browser: research cards, citations, the folder
// picker and the assistant against a mock OpenAI-compatible server. Skipped
// when there is no Chrome to drive.

const hasChrome = Launcher.getInstallations().length > 0;
const EXAMPLE = fileURLToPath(new URL("../example/", import.meta.url));

describe("app", { skip: !hasChrome && "no Chrome installation found" }, () => {
  let scratch: string;
  let project: string;
  let other: string;
  let ai: { server: Server; url: string; requests: any[] };
  let app: Awaited<ReturnType<typeof startApp>>;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "bled-test-"));
    project = join(scratch, "proj");
    other = join(scratch, "other");
    await cp(EXAMPLE, project, { recursive: true });
    await cp(EXAMPLE, other, { recursive: true });
    // Markup a clipped source might contain; the page's CSP must keep it inert.
    await appendFile(join(project, "sources", "against-fragments.md"), '\n<img src="x" onerror="window.__pwned = 1">\n');
    process.env.HEADLESS = "1";
    process.env.BLED_CONFIG_DIR = join(scratch, "config");
    ai = await startMockAi();
    app = await startApp();
  });

  after(async () => {
    app?.window.close();
    app?.server.close();
    ai?.server.close();
    await rm(scratch, { recursive: true, force: true });
  });

  const q = <T = any>(js: string) => app.window.evaluate<T>(js);
  const until = async (js: string, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await q(js)) return true;
    return false;
  };
  const setValue = (selector: string, value: string) =>
    q(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input')); })()`);
  const click = (selector: string) => q(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const openFolder = async (path: string) => {
    await until(`document.querySelector('#folder-dialog').open`);
    await setValue("#folder-path", path);
    await click("#folder-open");
  };
  const article = () => readFile(join(project, "post.md"), "utf8");

  test("starts with the folder picker, then opens a project", async () => {
    assert.ok(await q(`!document.querySelector('#welcome').hidden`));
    await openFolder(project);
    assert.ok(await until(`document.querySelectorAll('.card').length === 9 && document.querySelector('#doc-select').value === 'post.md'`));
    assert.equal(app.settings.get().recent[0], project);
  });

  test("shows research as cards and what the article already uses", async () => {
    assert.equal(await q(`document.querySelectorAll('.deck').length`), 4);
    assert.equal(await q(`document.querySelector('[data-source=card-method] .cited-badge').textContent`), "cited 1×");
    assert.equal(await q(`document.querySelector('.card.used')?.dataset.card`), "sources/card-method.md#1");
    assert.equal(await q(`window.__pwned`), undefined, "inline handlers in markdown don't run");
  });

  test("inserting a card adds the quote above the footnotes, and its definition", async () => {
    await q(`document.querySelector('.cm-content').focus()`);
    await app.window.command("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", modifiers: 2, windowsVirtualKeyCode: 35 });
    await click('[data-card="sources/linked-notes.md#1"] [data-action=insert]');
    await app.window.command("Input.insertText", { text: "Cards make this easy" });
    await click("[data-source=card-method] [data-action=cite]");
    await sleep(1200); // autosave
    const text = await article();
    assert.match(text, /> A note on its own is a fact\. Two linked notes are a question\.\[\^linked-notes\]\n\nCards make this easy\[\^card-method\]\n\n\[\^card-method\]: .*\n\[\^linked-notes\]: \[Notes That Link\]\(https:\/\/example\.com\/linked-notes\), Sample Writer\.\n$/);
    assert.equal(text.match(/\[\^card-method\]:/g)?.length, 1);
  });

  test("picks up changes made on disk", async () => {
    await appendFile(join(project, "sources", "linked-notes.md"), "\n> A quote added on disk.\n");
    assert.ok(await until(`document.querySelectorAll('.card').length === 10`));
    await writeFile(join(project, "post.md"), (await article()) + "\nAppended elsewhere.\n");
    assert.ok(await until(`document.querySelector('.cm-content').innerText.includes('Appended elsewhere.')`));
  });

  test("filters cards", async () => {
    await setValue("#card-filter", "fragments");
    assert.equal(await q(`[...document.querySelectorAll('.deck')].filter(d => !d.hidden).length`), 1);
    await setValue("#card-filter", "");
  });

  test("renders the preview with footnotes", async () => {
    await click("[data-layout=split]");
    assert.ok(await until(`document.querySelectorAll('#preview .footnotes li').length === 2`));
    await click("[data-layout=edit]");
  });

  test("configures the AI and keeps the key in node", async () => {
    await click("[data-tab=assistant]");
    assert.ok(await q(`document.querySelector('#assistant-view').classList.contains('unconfigured')`));
    await click(".assistant-setup button");
    await until(`document.querySelector('#ai-settings-dialog').open`);
    await setValue("[name=baseUrl]", `${ai.url}/chat/completions`);
    await setValue("[name=apiKey]", "test-key");
    await click("#ai-load-models");
    assert.ok(await until(`document.querySelector('.settings-status').textContent.includes('2 models')`));
    await setValue("[name=model]", "mock-model");
    await setValue("[name=extraBody]", '{"reasoning_effort": "low"}');
    await click("#ai-settings-dialog button[value=save]");
    assert.ok(await until(`!document.querySelector('#assistant-view').classList.contains('unconfigured')`));
    assert.deepEqual(app.settings.get().ai, {
      baseUrl: ai.url,
      apiKey: "test-key",
      model: "mock-model",
      extraBody: { reasoning_effort: "low" },
    });
    assert.ok(!(await q(`document.documentElement.outerHTML.includes('test-key')`)));
  });

  test("chats with the article and research as context", async () => {
    await setValue("#ai-input", "Why cards?");
    await click("#ai-send");
    assert.ok(await until(`document.querySelector('.msg.assistant:not(.streaming) strong')?.textContent === 'Cards'`));
    const request = ai.requests.at(-1);
    assert.equal(request.model, "mock-model");
    assert.equal(request.reasoning_effort, "low", "extra parameters are sent");
    assert.match(request.messages[0].content, /## \[\^card-method\] The Card Method/);
    assert.match(request.messages[0].content, /Every post I write/);
  });

  test("proofreads and applies a suggestion", async () => {
    await click("#ai-proofread");
    assert.ok(await until(`document.querySelectorAll('.suggestion').length === 2`));
    assert.ok(await q(`document.querySelectorAll('.cm-suggestion').length === 1 && document.querySelector('.suggestion[data-status=stale]') !== null`));
    await click(".suggestion[data-status=pending] [data-action=apply]");
    assert.ok(await until(`document.querySelector('.cm-content').innerText.includes('begins as a deck')`));
  });

  test("rewrites the selection", async () => {
    await q(`(() => { const line = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.startsWith('Every post')); const r = document.createRange(); r.selectNodeContents(line); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    assert.ok(await until(`!document.querySelector('#ai-rewrite').hidden`));
    await setValue("#ai-input", "Make it warmer");
    await click("#ai-rewrite");
    assert.ok(await until(`[...document.querySelectorAll('.suggestion-diff ins')].some(e => e.textContent.includes('index cards'))`));
    await q(`[...document.querySelectorAll('.suggestion[data-status=pending]')].at(-1).querySelector('[data-action=apply]').click()`);
    assert.ok(await until(`document.querySelector('.cm-content').innerText.includes('starts life as a deck of index cards')`));
  });

  test("checks the article against its sources", async () => {
    await click("#ai-check");
    assert.ok(await until(`[...document.querySelectorAll('.suggestion-kind')].some(k => k.textContent === 'unsupported')`));
    assert.match(ai.requests.at(-1).messages[0].content, /fact-checker[\s\S]*\[\^linked-notes\]/);
  });

  test("explains when a reasoning model never answers", async () => {
    await setValue("#ai-input", "OUT_OF_TOKENS");
    await click("#ai-send");
    assert.ok(await until(`document.querySelector('#assistant-log > .msg.error:last-child')?.textContent.includes('whole output budget thinking')`));
  });

  test("switches folders, and remembers recent ones", async () => {
    await q(`dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true }))`);
    await openFolder(other);
    assert.ok(await until(`document.querySelector('#project-name').textContent === 'other' && document.querySelector('#assistant-log').children.length === 0`));
    assert.deepEqual(app.settings.get().recent.slice(0, 2), [other, project]);
    await q(`dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true }))`);
    assert.ok(await until(`document.querySelectorAll('#recent-list li').length === 2`));
    await q(`document.querySelector('#recent-list li:nth-child(2)').click()`);
    assert.ok(await until(`document.querySelector('#project-name').textContent === 'proj'`));
  });
});

async function startApp() {
  // Imported here so BLED_CONFIG_DIR is set before settings are located.
  const { registerAi } = await import("../src/ai.ts");
  const { startServer } = await import("../src/server.ts");
  const { SettingsStore } = await import("../src/settings.ts");
  const { AppWindow } = await import("../src/window.ts");
  const { Workspace } = await import("../src/workspace.ts");

  const settings = await new SettingsStore().load();
  const window = new AppWindow();
  const workspace = new Workspace(window, settings);
  workspace.register();
  registerAi(window, settings);
  const { server, url } = await startServer(() => workspace.root);
  const loaded = new Promise((resolve) => window.on("event", (name: string) => name === "loaded" && resolve(null)));
  await window.open(url);
  await loaded;
  return { window, server, settings };
}

/** An OpenAI-compatible server that thinks first, like a reasoning model, then streams a canned answer. */
async function startMockAi() {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.headers.authorization !== "Bearer test-key") {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }, { id: "other-model" }] }));
      return;
    }
    const request = JSON.parse(body);
    requests.push(request);
    const system: string = request.messages[0].content;
    const last: string = request.messages.at(-1).content;
    const reply = system.includes("copy editor")
      ? "```json\n" + JSON.stringify({ suggestions: [
          { original: "Every post I write starts as a deck of cards.", replacement: "Every post I write begins as a deck of cards.", reason: "Livelier verb.", kind: "word choice" },
          { original: "text that is not in the article", replacement: "x", reason: "n/a", kind: "spelling" },
        ] }) + "\n```"
      : system.includes("fact-checker")
        ? JSON.stringify({ suggestions: [{ original: "Why I draft on index cards", replacement: null, reason: "Opinion, no source.", kind: "unsupported" }] })
        : last.includes("Rewrite this passage")
          ? "Each of my posts starts life as a deck of index cards."
          : "Sure. **Cards** keep each idea separate.[^card-method]";

    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (choice: object) => res.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
    for (let i = 0; i < 10; i++) send({ delta: { reasoning_content: "thinking about it " } });
    if (last.includes("OUT_OF_TOKENS")) send({ delta: {}, finish_reason: "length" });
    else {
      for (const piece of reply.match(/.{1,9}/gs)!) {
        send({ delta: { content: piece } });
        await sleep(2);
      }
      send({ delta: {}, finish_reason: "stop" });
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}/v1`, requests };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
