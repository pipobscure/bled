import type { EditorView } from "@codemirror/view";
import type { Project, Source } from "../src/types.ts";
import { Assistant } from "./assistant.ts";
import { bridge } from "./bridge.ts";
import { CARD_MIME, ResearchPanel, type CardDrag } from "./cards.ts";
import { clipboardText, Usage } from "./citations.ts";
import { commands, createEditor, insertCitation, insertQuote, loadDocument, replaceDocument } from "./editor.ts";
import { pickFolder } from "./folder-picker.ts";
import { dirOf, joinPath, renderMarkdown } from "./markdown.ts";
import { suggestionsExtension } from "./suggestions.ts";

type Layout = "edit" | "split" | "preview";
type Tab = "research" | "assistant";

const AUTOSAVE_DELAY = 800;
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const workspace = $("#workspace");
const docSelect = $<HTMLSelectElement>("#doc-select");
const saveStatus = $("#save-status");
const preview = $("#preview");
const cardFilter = $<HTMLInputElement>("#card-filter");
const cardCount = $("#card-count");

let project: Project | null = null;
/** The open file, and its content as last read from / written to disk. */
let doc = { path: "", saved: "" };
let articleText = "";
let saveTimer: number | undefined;
let refreshTimer: number | undefined;
/** Last thing copied from a card, so pasting it into the article can add the footnote definition. */
let lastCopy: { text: string; source: Source; quote: string } | null = null;

const editor = createEditor($("#editor"), {
  onChange: (text) => {
    setStatus(text === doc.saved ? "saved" : "unsaved");
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, AUTOSAVE_DELAY);
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => refreshDerived(text), 150);
  },
  onSave: () => void save(),
  onDrop: (event, view) => {
    const payload = event.dataTransfer?.getData(CARD_MIME);
    if (!payload || !isArticleOpen()) return false;
    event.preventDefault();
    const drag = JSON.parse(payload) as CardDrag;
    const entry = research.card(drag.cardId);
    if (!entry) return true;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    insertQuote(view, pos, drag.text, entry.source);
    return true;
  },
  onPaste: (event, view) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!lastCopy || text !== lastCopy.text || !isArticleOpen()) return false;
    event.preventDefault();
    insertQuote(view, view.state.selection.main.head, lastCopy.quote, lastCopy.source);
    return true;
  },
  onSelectionChange: () => assistant.updateScope(),
  extensions: [suggestionsExtension((id) => assistant.focusSuggestion(id))],
});

const research = new ResearchPanel($("#decks"), {
  insert: (source, text) => insertQuote(editor, editor.state.selection.main.head, text, source),
  cite: (source) => insertCitation(editor, source),
  copy: async (source, quote) => {
    const text = clipboardText(quote, source);
    await navigator.clipboard.writeText(text);
    lastCopy = { text, source, quote };
    flash("Copied quote with footnote");
  },
  openFile: (path) => void openDocument(path),
  openUrl: (url) => void bridge.invoke("shell.openExternal", { url }),
});

const assistant = new Assistant($("#assistant-view"), {
  editor,
  project: () => project,
  docPath: () => doc.path,
  isArticleOpen,
  reveal: () => showTab("assistant"),
  flash,
});

// --- Documents ---------------------------------------------------------------

/** Any top-level markdown file that isn't research can be the article being written. */
function isArticleOpen(): boolean {
  return project !== null && (doc.path === project.article || project.articleCandidates.includes(doc.path));
}

async function openDocument(path: string): Promise<void> {
  if (path === doc.path || !project) return;
  await save();
  const content = (await bridge.invoke<string | null>("file.read", { path })) ?? "";
  doc = { path, saved: content };
  loadDocument(editor, content);
  assistant.documentChanged();
  refreshDerived(content);
  research.setCanInsert(isArticleOpen());
  assistant.updateScope();
  renderDocSelect();
  setStatus("saved");
  editor.focus();
}

/** Loads the open folder (after startup or switching), or shows the welcome screen if none. */
async function loadWorkspace(): Promise<void> {
  await save();
  doc = { path: "", saved: "" };
  articleText = "";
  lastCopy = null;
  assistant.reset();
  await reloadProject();
  $("#welcome").hidden = project !== null;
  $("#project-name").textContent = project?.name ?? "Open folder";
  $("#open-folder").title = project ? `${project.root} — open another folder (Ctrl+O)` : "Open folder (Ctrl+O)";
  if (project) {
    await openDocument(project.article);
  } else {
    loadDocument(editor, "");
  }
}

async function chooseFolder(): Promise<void> {
  const folder = await pickFolder(project ? dirOf(project.root) || project.root : null);
  if (!folder) return;
  try {
    await bridge.invoke("workspace.open", { path: folder });
    await loadWorkspace();
  } catch (error) {
    flash((error as Error).message);
  }
}

async function save(): Promise<void> {
  clearTimeout(saveTimer);
  const text = editor.state.doc.toString();
  if (!doc.path || text === doc.saved) return;
  const path = doc.path;
  setStatus("saving");
  try {
    await bridge.invoke("file.write", { path, content: text });
    if (doc.path === path) doc.saved = text;
    setStatus(editor.state.doc.toString() === doc.saved ? "saved" : "unsaved");
  } catch (error) {
    setStatus("error", (error as Error).message);
  }
}

/** Article-dependent UI: citation badges, used quotes, and the preview. */
function refreshDerived(text: string): void {
  if (isArticleOpen()) {
    articleText = text;
    research.setUsage(new Usage(text));
  }
  if (workspace.dataset.layout !== "edit") {
    preview.innerHTML = renderMarkdown(text, dirOf(doc.path));
  }
}

function renderDocSelect(): void {
  if (!project) {
    docSelect.replaceChildren();
    return;
  }
  const option = (path: string, label = path) => {
    const element = new Option(label, path, false, path === doc.path);
    return element;
  };
  const group = (label: string, options: HTMLOptionElement[]) => {
    const element = document.createElement("optgroup");
    element.label = label;
    element.append(...options);
    return element;
  };
  const articles = [...new Set([project.article, ...project.articleCandidates])];
  const { research: researchFile } = project;
  const sources = project.sections.flatMap((section) => section.sources).filter((s) => s.path && !s.missing);
  const groups = [group("Article", articles.map((path) => option(path)))];
  if (researchFile) groups.push(group("Research", [option(researchFile)]));
  if (sources.length) groups.push(group("Sources", sources.map((s) => option(s.path!, `${s.title} (${s.path})`))));
  docSelect.replaceChildren(...groups);
}

async function reloadProject(): Promise<void> {
  project = await bridge.invoke<Project | null>("project.load");
  if (!project) {
    $("#decks").replaceChildren();
    cardCount.textContent = "";
    renderDocSelect();
    return;
  }
  research.setProject(project);
  research.setUsage(new Usage(isArticleOpen() ? editor.state.doc.toString() : articleText));
  cardCount.textContent = String(research.cardCount);
  renderDocSelect();
}

bridge.on<{ paths: string[] }>("project.changed", async ({ paths }) => {
  await reloadProject();
  if (!doc.path || !paths.includes(doc.path)) return;
  const onDisk = (await bridge.invoke<string | null>("file.read", { path: doc.path })) ?? "";
  const current = editor.state.doc.toString();
  if (onDisk === doc.saved || onDisk === current) return;
  if (current === doc.saved) {
    // No local edits: take the version from disk.
    doc.saved = onDisk;
    replaceDocument(editor, onDisk);
    flash(`Reloaded ${doc.path} (changed on disk)`);
  } else {
    setStatus("error", `${doc.path} changed on disk; saving will overwrite it`);
  }
});

// --- Chrome ------------------------------------------------------------------

function setStatus(state: "saved" | "unsaved" | "saving" | "error", message?: string): void {
  saveStatus.dataset.state = state;
  saveStatus.textContent = message ?? { saved: "Saved", unsaved: "Edited", saving: "Saving…", error: "Error" }[state];
}

let flashTimer: number | undefined;
function flash(message: string): void {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => toast.classList.remove("visible"), 1800);
}

function setLayout(layout: Layout): void {
  workspace.dataset.layout = layout;
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-layout]")) {
    button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
  }
  refreshDerived(editor.state.doc.toString());
  if (layout !== "preview") editor.focus();
}

docSelect.addEventListener("change", () => void openDocument(docSelect.value));
cardFilter.addEventListener("input", () => research.setFilter(cardFilter.value));

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-command]")) {
  button.addEventListener("mousedown", (event) => event.preventDefault()); // keep editor focus
  button.addEventListener("click", () => {
    commands[button.dataset.command!]!(editor as EditorView);
    editor.focus();
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-layout]")) {
  button.addEventListener("click", () => setLayout(button.dataset.layout as Layout));
}
function togglePanel(): void {
  const hidden = workspace.toggleAttribute("data-panel-hidden");
  $("#toggle-panel").setAttribute("aria-pressed", String(!hidden));
}

function showTab(tab: Tab): void {
  if (workspace.hasAttribute("data-panel-hidden")) togglePanel();
  for (const button of document.querySelectorAll<HTMLElement>("[data-tab]")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  }
  $("#research-view").hidden = tab !== "research";
  $("#assistant-view").hidden = tab !== "assistant";
}

$("#toggle-panel").addEventListener("click", togglePanel);
for (const button of document.querySelectorAll<HTMLElement>("[data-tab]")) {
  button.addEventListener("click", () => showTab(button.dataset.tab as Tab));
}
$("#open-folder").addEventListener("click", () => void chooseFolder());
$("#welcome-open").addEventListener("click", () => void chooseFolder());

// Links in the preview: footnote anchors scroll, project markdown files open, the rest go to the system browser.
preview.addEventListener("click", (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!link) return;
  const href = link.getAttribute("href")!;
  if (href.startsWith("#")) return;
  event.preventDefault();
  if (/^https?:|^mailto:/i.test(href)) void bridge.invoke("shell.openExternal", { url: link.href });
  else if (/\.md$/i.test(href.split("#")[0]!)) void openDocument(joinPath(dirOf(doc.path), href.split("#")[0]!));
});

addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    void save();
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    showTab("research");
    cardFilter.focus();
    cardFilter.select();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void chooseFolder();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "\\") {
    event.preventDefault();
    togglePanel();
  }
});
addEventListener("blur", () => void save());

// --- Start -------------------------------------------------------------------

await assistant.init();
await loadWorkspace();
setLayout("edit");
// (Read through a cast: TypeScript can't see that loadWorkspace assigned it.)
const opened = project as Project | null;
if (!opened) void chooseFolder();
bridge.emit("loaded", { folder: opened?.root ?? null, article: opened?.article ?? null, cards: research.cardCount });
