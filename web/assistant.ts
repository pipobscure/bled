import type { EditorView } from "@codemirror/view";
import type { Project } from "../src/types.ts";
import {
  chatMessages,
  chatTurn,
  describeProgress,
  splitIntoParts,
  parseSuggestions,
  proofreadMessages,
  rewriteMessages,
  sourceCheckMessages,
  type AiSettings,
  type ChatMessage,
  type RawSuggestion,
} from "./ai.ts";

/** Parallel requests when proofreading a long document in parts. */
const PART_CONCURRENCY = 3;
import { runChat, type AiRun } from "./ai-client.ts";
import { bridge } from "./bridge.ts";
import { insertBlock } from "./editor.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  addSuggestionRanges,
  clearSuggestionRanges,
  diffWords,
  locate,
  removeSuggestionRange,
  setActiveSuggestion,
  suggestionRange,
} from "./suggestions.ts";

export interface AssistantHost {
  editor: EditorView;
  project(): Project | null;
  docPath(): string;
  isArticleOpen(): boolean;
  /** Called when the assistant needs to be visible (e.g. a suggestion was clicked in the editor). */
  reveal(): void;
  flash(message: string): void;
}

interface Suggestion {
  id: string;
  original: string;
  replacement: string | null;
  reason: string;
  kind: string;
  /** The document text the suggestion was anchored to. */
  anchored: string | null;
  status: "pending" | "applied" | "dismissed" | "stale";
  element: HTMLElement;
}

const $ = <T extends HTMLElement>(root: ParentNode, selector: string) => root.querySelector<T>(selector)!;

export class Assistant {
  #host: AssistantHost;
  #root: HTMLElement;
  #log: HTMLElement;
  #input: HTMLTextAreaElement;
  #scope: HTMLElement;
  #history: ChatMessage[] = [];
  #suggestions = new Map<string, Suggestion>();
  #run: AiRun | null = null;
  #settings: AiSettings | null = null;

  constructor(root: HTMLElement, host: AssistantHost) {
    this.#root = root;
    this.#host = host;
    this.#log = $(root, "#assistant-log");
    this.#input = $(root, "#ai-input");
    this.#scope = $(root, "#ai-scope");

    $(root, "#assistant-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#chat();
    });
    this.#input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.#chat();
      }
    });
    $(root, "#ai-rewrite").addEventListener("click", () => void this.#rewrite());
    $(root, "#ai-proofread").addEventListener("click", () => void this.#proofread());
    $(root, "#ai-check").addEventListener("click", () => void this.#checkSources());
    $(root, "#ai-stop").addEventListener("click", () => this.#run?.cancel());
    $(root, "#ai-clear").addEventListener("click", () => this.reset());
    for (const button of root.querySelectorAll("[data-ai-settings]")) {
      button.addEventListener("click", () => void this.openSettings());
    }
    this.#log.addEventListener("click", (event) => this.#onLogClick(event));
    this.#setupSettingsDialog();
  }

  async init(): Promise<void> {
    this.#settings = await bridge.invoke<AiSettings>("ai.settings.get");
    this.#root.classList.toggle("unconfigured", !this.#settings.model);
    this.updateScope();
  }

  /** Clears the conversation and suggestions (e.g. when switching projects). */
  reset(): void {
    this.#run?.cancel();
    this.#history = [];
    this.#suggestions.clear();
    this.#log.replaceChildren();
    clearSuggestionRanges(this.#host.editor);
  }

  /** The editor loaded another file: suggestions for the old one can't be applied any more. */
  documentChanged(): void {
    for (const suggestion of this.#suggestions.values()) {
      if (suggestion.status === "pending") this.#setStatus(suggestion, "stale");
    }
  }

  /** Reflects the editor selection in the button labels and the scope chip. */
  updateScope(): void {
    const selection = this.#selection();
    const article = this.#host.isArticleOpen();
    this.#scope.hidden = !selection;
    if (selection) this.#scope.textContent = `Selection: “${truncate(selection.text, 60)}”`;
    $(this.#root, "#ai-proofread").textContent = selection ? "Proofread selection" : "Proofread";
    $<HTMLButtonElement>(this.#root, "#ai-rewrite").hidden = !selection;
    $<HTMLButtonElement>(this.#root, "#ai-check").disabled = !article || this.#run !== null;
    this.#input.placeholder = selection
      ? "Ask about the selection, or say how to rewrite it…"
      : "Ask for help with the article…";
  }

  /** An underlined suggestion was clicked in the editor. */
  focusSuggestion(id: string): void {
    const suggestion = this.#suggestions.get(id);
    if (!suggestion) return;
    this.#host.reveal();
    for (const element of this.#log.querySelectorAll(".suggestion.active")) element.classList.remove("active");
    suggestion.element.classList.add("active");
    suggestion.element.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setActiveSuggestion(this.#host.editor, id);
  }

  // --- Actions -------------------------------------------------------------------

  async #chat(): Promise<void> {
    const question = this.#input.value.trim();
    const project = this.#host.project();
    if (!question || !project || !this.#ready()) return;
    const selection = this.#selection();
    this.#input.value = "";

    const turn: ChatMessage = { role: "user", content: chatTurn(question, selection?.text ?? null) };
    this.#history.push(turn);
    this.#append(this.#userMessage(question, selection?.text ?? null));
    const reply = this.#append(h("div", { class: "msg assistant streaming" }, h("div", { class: "prose" })));
    const body = reply.firstElementChild as HTMLElement;

    const run = this.#start(
      runChat(chatMessages(project, this.#doc(), this.#history), (progress) => {
        if (progress.text) body.innerHTML = renderMarkdown(progress.text);
        else body.replaceChildren(h("span", { class: "thinking" }, describeProgress(progress)));
        this.#scrollToEnd();
      }),
    );
    try {
      const text = await run.done;
      this.#history.push({ role: "assistant", content: text });
      body.innerHTML = renderMarkdown(text);
      reply.append(
        h(
          "div",
          { class: "msg-actions" },
          h("button", { "data-action": "insert-reply", title: "Insert below the cursor's paragraph (or replace the selection)" }, "Insert"),
          h("button", { "data-action": "copy-reply" }, "Copy"),
        ),
      );
      reply.dataset.markdown = text;
    } catch (error) {
      this.#history.splice(this.#history.indexOf(turn), 1);
      reply.replaceWith(this.#error(error));
    } finally {
      reply.classList.remove("streaming");
      this.#finish(run);
    }
  }

  async #rewrite(): Promise<void> {
    const selection = this.#selection();
    const project = this.#host.project();
    if (!selection || !project || !this.#ready()) return;
    const instruction = this.#input.value.trim() || "Improve clarity and flow without changing the meaning.";
    this.#input.value = "";

    const group = this.#group(`Rewrite: ${truncate(instruction, 70)}`);
    const suggestion = this.#suggestion(group, {
      original: selection.text,
      replacement: "",
      reason: "",
      kind: "rewrite",
    });
    suggestion.anchored = selection.text;
    addSuggestionRanges(this.#host.editor, [{ id: suggestion.id, from: selection.from, to: selection.to }]);
    const diff = $(suggestion.element, ".suggestion-diff");

    const run = this.#start(
      runChat(rewriteMessages(project, this.#doc(), selection.text, instruction), (progress) => {
        diff.textContent = progress.text || describeProgress(progress);
        this.#scrollToEnd();
      }),
    );
    try {
      suggestion.replacement = stripFences(await run.done);
      this.#renderSuggestion(suggestion);
      this.#groupStatus(group, "");
    } catch (error) {
      this.#dismiss(suggestion);
      group.replaceWith(this.#error(error));
    } finally {
      this.#finish(run);
    }
  }

  #proofread(): Promise<void> {
    const selection = this.#selection();
    if (selection) return this.#review("Proofreading selection", [proofreadMessages(selection.text, true)], selection);
    // Whole documents go in parts: smaller requests finish sooner (and reasoning
    // models don't think themselves out of output tokens), and results arrive as they're done.
    const text = this.#host.editor.state.doc.toString();
    const parts = splitIntoParts(text);
    const requests = parts.length > 1
      ? parts.map((part) => proofreadMessages(text.slice(part.from, part.to), true))
      : [proofreadMessages(text, false)];
    const title = `Proofreading ${this.#host.docPath()}${parts.length > 1 ? ` in ${parts.length} parts` : ""}`;
    return this.#review(title, requests, null);
  }

  #checkSources(): Promise<void> {
    const project = this.#host.project();
    if (!project) return Promise.resolve();
    const { path, text } = this.#doc();
    return this.#review(`Checking ${path} against sources`, [sourceCheckMessages(project, path, text)], null);
  }

  /**
   * Runs prompts that return suggestions (a few at a time) and anchors the results
   * in the editor as each one finishes. `scope` limits where the text is looked up.
   */
  async #review(title: string, requests: ChatMessage[][], scope: { from: number; to: number } | null): Promise<void> {
    if (!this.#ready()) return;
    const group = this.#group(title);
    const runs = new Set<AiRun>();
    let cancelled = false;
    const all: AiRun = {
      done: Promise.resolve(""),
      cancel: () => {
        cancelled = true;
        for (const run of runs) run.cancel();
      },
    };
    this.#start(all);

    let next = 0;
    let finished = 0;
    let found = 0;
    let latest = "Waiting for the model…";
    const errors: string[] = [];
    const update = () => {
      const parts = requests.length > 1 ? `${finished} of ${requests.length} parts done · ` : "";
      this.#groupStatus(group, `${parts}${latest}`);
    };
    update();

    const worker = async () => {
      while (!cancelled && next < requests.length) {
        const run = runChat(requests[next++]!, (progress) => {
          latest = describeProgress(progress);
          update();
        }, 0.2);
        runs.add(run);
        try {
          found += this.#anchor(group, parseSuggestions(await run.done), scope);
        } catch (error) {
          if (!cancelled) errors.push((error as Error).message);
        } finally {
          runs.delete(run);
          finished++;
          update();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, requests.length) }, worker));

    if (errors.length === requests.length) {
      group.replaceWith(this.#error(new Error(errors[0])));
    } else {
      const summary = cancelled
        ? `Stopped · ${found} suggestion${found === 1 ? "" : "s"}`
        : found === 0
          ? "No problems found."
          : `${found} suggestion${found === 1 ? "" : "s"}`;
      const failed = errors.length ? ` · ${errors.length} part${errors.length === 1 ? "" : "s"} failed: ${errors[0]}` : "";
      this.#groupStatus(group, summary + failed);
      $<HTMLElement>(group, ".group-actions").hidden = !group.querySelector(
        ".suggestion[data-status=pending] [data-action=apply]:not([hidden])",
      );
    }
    this.#finish(all);
  }

  /** Adds suggestions to a group, underlining the ones found in the document. Returns how many were added. */
  #anchor(group: HTMLElement, raw: RawSuggestion[], scope: { from: number; to: number } | null): number {
    const doc = this.#host.editor.state.doc.toString();
    const positions = locate(doc, raw.map((s) => s.original), scope?.from, scope?.to);
    const ranges = [];
    for (const [index, data] of raw.entries()) {
      const suggestion = this.#suggestion(group, data);
      const position = positions[index];
      if (position) {
        suggestion.anchored = doc.slice(position.from, position.to);
        ranges.push({ id: suggestion.id, ...position });
      } else {
        this.#setStatus(suggestion, "stale", "Couldn't find this text in the document.");
      }
    }
    addSuggestionRanges(this.#host.editor, ranges);
    return raw.length;
  }

  // --- Suggestions ---------------------------------------------------------------

  #onLogClick(event: MouseEvent): void {
    const target = event.target as Element;
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (link) {
      event.preventDefault();
      if (/^https?:/i.test(link.href)) void bridge.invoke("shell.openExternal", { url: link.href });
      return;
    }
    const button = target.closest<HTMLButtonElement>("button[data-action]");
    const item = target.closest<HTMLElement>(".suggestion");
    const suggestion = item ? this.#suggestions.get(item.dataset.id!) : undefined;

    switch (button?.dataset.action) {
      case "apply":
        if (suggestion) this.#apply(suggestion);
        return;
      case "dismiss":
        if (suggestion) this.#dismiss(suggestion);
        return;
      case "apply-all":
      case "dismiss-all":
        for (const element of button.closest(".task")!.querySelectorAll<HTMLElement>(".suggestion")) {
          const each = this.#suggestions.get(element.dataset.id!)!;
          if (each.status !== "pending") continue;
          if (button.dataset.action === "dismiss-all") this.#dismiss(each);
          else if (each.replacement !== null) this.#apply(each);
        }
        return;
      case "insert-reply": {
        insertBlock(this.#host.editor, button.closest<HTMLElement>(".msg")!.dataset.markdown!);
        return;
      }
      case "copy-reply":
        void navigator.clipboard.writeText(button.closest<HTMLElement>(".msg")!.dataset.markdown!);
        this.#host.flash("Copied");
        return;
    }

    // Clicking a suggestion shows it in the editor.
    if (suggestion && suggestion.status === "pending") {
      const range = suggestionRange(this.#host.editor.state, suggestion.id);
      if (!range) return;
      const { editor } = this.#host;
      editor.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true });
      this.focusSuggestion(suggestion.id);
    }
  }

  #apply(suggestion: Suggestion): void {
    const { editor } = this.#host;
    const range = suggestionRange(editor.state, suggestion.id);
    if (!range || suggestion.replacement === null || editor.state.sliceDoc(range.from, range.to) !== suggestion.anchored) {
      this.#setStatus(suggestion, "stale", "The text changed since this was suggested.");
      return;
    }
    editor.dispatch({
      changes: { from: range.from, to: range.to, insert: suggestion.replacement },
      userEvent: "input.suggestion",
    });
    removeSuggestionRange(editor, suggestion.id);
    this.#setStatus(suggestion, "applied");
  }

  #dismiss(suggestion: Suggestion): void {
    removeSuggestionRange(this.#host.editor, suggestion.id);
    this.#setStatus(suggestion, "dismissed");
  }

  #setStatus(suggestion: Suggestion, status: Suggestion["status"], note?: string): void {
    suggestion.status = status;
    suggestion.element.dataset.status = status;
    if (status !== "pending") removeSuggestionRange(this.#host.editor, suggestion.id);
    const label = { pending: "", applied: "Applied", dismissed: "Dismissed", stale: note ?? "No longer applies." }[status];
    $(suggestion.element, ".suggestion-state").textContent = label;
  }

  #suggestion(group: HTMLElement, data: Pick<Suggestion, "original" | "replacement" | "reason" | "kind">): Suggestion {
    const id = crypto.randomUUID();
    const element = h(
      "div",
      { class: "suggestion", "data-id": id, "data-status": "pending" },
      h("div", { class: "suggestion-kind" }, data.kind),
      h("div", { class: "suggestion-diff" }),
      h("div", { class: "suggestion-reason" }),
      h(
        "div",
        { class: "suggestion-actions" },
        h("span", { class: "suggestion-state" }),
        h("button", { "data-action": "apply", class: "primary" }, "Apply"),
        h("button", { "data-action": "dismiss" }, "Dismiss"),
      ),
    );
    $(group, ".suggestion-list").append(element);
    const suggestion: Suggestion = { id, ...data, anchored: null, status: "pending", element };
    this.#suggestions.set(id, suggestion);
    this.#renderSuggestion(suggestion);
    return suggestion;
  }

  #renderSuggestion(suggestion: Suggestion): void {
    const diff = $(suggestion.element, ".suggestion-diff");
    if (suggestion.replacement === null) {
      diff.replaceChildren(h("span", { class: "flagged" }, suggestion.original));
    } else {
      const parts = diffWords(suggestion.original, suggestion.replacement);
      const kept = parts.filter((part) => part.type === "same").reduce((sum, part) => sum + part.text.length, 0);
      // Interleaved word changes are unreadable for heavy rewrites: show before and after instead.
      if (kept < 0.5 * Math.max(suggestion.original.length, suggestion.replacement.length)) {
        diff.replaceChildren(
          h("del", { class: "block" }, suggestion.original),
          h("ins", { class: "block" }, suggestion.replacement),
        );
      } else {
        diff.replaceChildren(
          ...parts.map((part) => (part.type === "same" ? document.createTextNode(part.text) : h(part.type, {}, part.text))),
        );
      }
    }
    $(suggestion.element, ".suggestion-reason").textContent = suggestion.reason;
    $<HTMLButtonElement>(suggestion.element, "[data-action=apply]").hidden = suggestion.replacement === null;
  }

  #group(title: string): HTMLElement {
    return this.#append(
      h(
        "div",
        { class: "task" },
        h(
          "header",
          {},
          h("div", { class: "task-title" }, title),
          h("div", { class: "task-status" }, "Working…"),
          h(
            "div",
            { class: "group-actions", hidden: "" },
            h("button", { "data-action": "apply-all" }, "Apply all"),
            h("button", { "data-action": "dismiss-all" }, "Dismiss all"),
          ),
        ),
        h("div", { class: "suggestion-list" }),
      ),
    );
  }

  #groupStatus(group: HTMLElement, status: string): void {
    $(group, ".task-status").textContent = status;
  }

  // --- Plumbing ------------------------------------------------------------------

  #ready(): boolean {
    if (this.#run) return false;
    if (!this.#settings?.model) {
      void this.openSettings();
      return false;
    }
    return true;
  }

  #start(run: AiRun): AiRun {
    this.#run = run;
    this.#root.classList.add("busy");
    this.updateScope();
    return run;
  }

  #finish(run: AiRun): void {
    if (this.#run !== run) return;
    this.#run = null;
    this.#root.classList.remove("busy");
    this.updateScope();
  }

  #selection(): { from: number; to: number; text: string } | null {
    const { state } = this.#host.editor;
    const { from, to } = state.selection.main;
    const text = state.sliceDoc(from, to);
    return text.trim() ? { from, to, text } : null;
  }

  #doc(): { path: string; text: string } {
    return { path: this.#host.docPath(), text: this.#host.editor.state.doc.toString() };
  }

  #append<T extends HTMLElement>(element: T): T {
    this.#log.append(element);
    this.#scrollToEnd();
    return element;
  }

  #scrollToEnd(): void {
    this.#log.scrollTop = this.#log.scrollHeight;
  }

  #userMessage(question: string, selection: string | null): HTMLElement {
    return h(
      "div",
      { class: "msg user" },
      selection ? h("div", { class: "msg-selection" }, truncate(selection, 140)) : "",
      h("div", {}, question),
    );
  }

  #error(error: unknown): HTMLElement {
    return h("div", { class: "msg error" }, (error as Error).message ?? String(error));
  }

  // --- Settings ------------------------------------------------------------------

  async openSettings(): Promise<void> {
    const dialog = document.querySelector<HTMLDialogElement>("#ai-settings-dialog")!;
    const settings = (this.#settings = await bridge.invoke<AiSettings>("ai.settings.get"));
    $<HTMLInputElement>(dialog, "[name=baseUrl]").value = settings.baseUrl;
    $<HTMLInputElement>(dialog, "[name=model]").value = settings.model;
    $<HTMLTextAreaElement>(dialog, "[name=extraBody]").value =
      Object.keys(settings.extraBody).length > 0 ? JSON.stringify(settings.extraBody, null, 1) : "";
    const key = $<HTMLInputElement>(dialog, "[name=apiKey]");
    key.value = "";
    key.placeholder = settings.hasKey ? "Saved (leave empty to keep)" : "sk-…";
    $(dialog, ".settings-status").textContent = "";
    dialog.showModal();
  }

  #setupSettingsDialog(): void {
    const dialog = document.querySelector<HTMLDialogElement>("#ai-settings-dialog")!;
    const form = $<HTMLFormElement>(dialog, "form");
    const status = $(dialog, ".settings-status");
    const field = (name: string) => $<HTMLInputElement>(dialog, `[name=${name}]`).value.trim();

    $(dialog, "#ai-load-models").addEventListener("click", async () => {
      status.textContent = "Connecting…";
      try {
        const models = await bridge.invoke<string[]>("ai.models", { baseUrl: field("baseUrl"), apiKey: field("apiKey") });
        $(dialog, "#ai-model-list").replaceChildren(...models.map((model) => new Option(model)));
        status.textContent = `Connected: ${models.length} models available.`;
      } catch (error) {
        status.textContent = (error as Error).message;
      }
    });
    $(dialog, "#ai-clear-key").addEventListener("click", async () => {
      await bridge.invoke("ai.settings.set", { apiKey: "" });
      $<HTMLInputElement>(dialog, "[name=apiKey]").placeholder = "sk-…";
      status.textContent = "API key removed.";
    });
    form.addEventListener("submit", async (event) => {
      if ((event.submitter as HTMLButtonElement | null)?.value !== "save") return;
      event.preventDefault();
      let extraBody: unknown = {};
      const extra = $<HTMLTextAreaElement>(dialog, "[name=extraBody]").value.trim();
      try {
        if (extra) extraBody = JSON.parse(extra);
        if (typeof extraBody !== "object" || extraBody === null || Array.isArray(extraBody)) throw new Error();
      } catch {
        status.textContent = 'Extra parameters must be a JSON object, e.g. {"reasoning_effort": "low"}.';
        return;
      }
      await bridge.invoke("ai.settings.set", {
        baseUrl: field("baseUrl"),
        model: field("model"),
        extraBody,
        ...(field("apiKey") && { apiKey: field("apiKey") }),
      });
      dialog.close();
      await this.init();
      this.#host.flash("AI settings saved");
    });
  }
}

/** Models sometimes wrap a rewrite in a code fence despite instructions. */
function stripFences(text: string): string {
  const match = /^\s*```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/.exec(text);
  return match ? match[1]! : text.trim();
}

function truncate(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? flat.slice(0, length - 1) + "…" : flat;
}

function h(tag: string, attributes: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}
