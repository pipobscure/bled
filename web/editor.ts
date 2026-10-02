import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { ChangeSet, EditorSelection, EditorState, type ChangeSpec, type Extension, type Text } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder,
  type Command,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Source } from "../src/types.ts";
import { footnoteDefinition, footnoteMarker, hasDefinition, quoteBlock } from "./citations.ts";

export interface EditorOptions {
  onChange: (text: string) => void;
  onSave: () => void;
  /** Lets the host turn drops and pastes from the research panel into citations. Return true if handled. */
  onDrop: (event: DragEvent, view: EditorView) => boolean;
  onPaste: (event: ClipboardEvent, view: EditorView) => boolean;
  onSelectionChange?: () => void;
  extensions?: Extension[];
}

const markdownHighlighting = HighlightStyle.define([
  { tag: tags.heading1, class: "md-h md-h1" },
  { tag: tags.heading2, class: "md-h md-h2" },
  { tag: tags.heading3, class: "md-h md-h3" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: "md-h" },
  { tag: tags.strong, class: "md-strong" },
  { tag: tags.emphasis, class: "md-em" },
  { tag: tags.strikethrough, class: "md-strike" },
  { tag: tags.link, class: "md-link" },
  { tag: tags.url, class: "md-url" },
  { tag: tags.quote, class: "md-quote" },
  { tag: tags.monospace, class: "md-code" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], class: "md-mark" },
  { tag: tags.comment, class: "md-comment" },
]);

// Colors come from CSS variables in styles.css so the editor follows the page theme.
const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--text)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-editor)", fontSize: "15px", lineHeight: "1.75" },
  ".cm-content": {
    maxWidth: "calc(72ch + 64px)",
    margin: "0 auto",
    padding: "40px 32px 50vh",
    caretColor: "var(--accent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--selection)",
  },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--match)" },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)", borderColor: "var(--border)" },
});

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorView {
  const extensions = [
    theme,
    history(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(markdownHighlighting),
    placeholder("Start writing…"),
    keymap.of([
      { key: "Mod-s", run: () => (options.onSave(), true), preventDefault: true },
      { key: "Mod-b", run: toggleInline("**") },
      { key: "Mod-i", run: toggleInline("*") },
      { key: "Mod-e", run: toggleInline("`") },
      { key: "Mod-k", run: insertLink },
      { key: "Mod-Shift-.", run: toggleLinePrefix("> ") },
      { key: "Mod-Shift-8", run: toggleLinePrefix("- ") },
      { key: "Mod-Shift-7", run: toggleLinePrefix("1. ") },
      { key: "Mod-Alt-1", run: setHeading(1) },
      { key: "Mod-Alt-2", run: setHeading(2) },
      { key: "Mod-Alt-3", run: setHeading(3) },
      { key: "Mod-Alt-0", run: setHeading(0) },
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
      if (update.selectionSet || update.docChanged) options.onSelectionChange?.();
    }),
    EditorView.domEventHandlers({
      drop: (event, view) => options.onDrop(event, view),
      paste: (event, view) => options.onPaste(event, view),
    }),
    ...(options.extensions ?? []),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ extensions }) });
  // Keep the extensions so documents can be swapped without sharing undo history.
  stateExtensions.set(view, extensions);
  return view;
}

const stateExtensions = new WeakMap<EditorView, Extension[]>();

/** Replaces the document and resets undo history (switching files). */
export function loadDocument(view: EditorView, text: string): void {
  view.setState(EditorState.create({ doc: text, extensions: stateExtensions.get(view) }));
}

/** Replaces the document as an undoable edit, keeping the cursor nearby (file changed on disk). */
export function replaceDocument(view: EditorView, text: string): void {
  const { head } = view.state.selection.main;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: Math.min(head, text.length) },
  });
}

// --- Citations ---------------------------------------------------------------

/**
 * Inserts `text` as a blockquote near `pos`, citing `source`, and adds the footnote
 * definition if missing. The quote goes after the current line (never inside the
 * footnotes at the end), and the cursor lands on an empty line below it.
 */
export function insertQuote(view: EditorView, pos: number, text: string, source: Source): void {
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  const at = Math.min(line.text.trim() ? line.to : pos, footnotesStart(doc));
  const before = at === 0 ? "" : blankLinesBefore(doc, at);
  const block = before + quoteBlock(text, source) + "\n\n";
  // Keep a blank line between the cursor's line and whatever follows.
  const following = doc.sliceString(at, at + 2);
  const newlines = following === "\n\n" ? 2 : following.startsWith("\n") ? 1 : 0;
  const tail = "\n".repeat(2 - newlines);
  view.dispatch({
    changes: withDefinition(doc, { from: at, insert: block + tail }, source),
    selection: { anchor: at + block.length },
    scrollIntoView: true,
    userEvent: "input.cite",
  });
  view.focus();
}

/**
 * Inserts markdown as its own block: replaces the selection if there is one,
 * otherwise goes after the current line, separated by blank lines.
 */
export function insertBlock(view: EditorView, markdown: string): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  if (from !== to) {
    view.dispatch(state.replaceSelection(markdown.trim()), { scrollIntoView: true, userEvent: "input.paste" });
    view.focus();
    return;
  }
  const doc = state.doc;
  const line = doc.lineAt(from);
  const at = Math.min(line.text.trim() ? line.to : from, footnotesStart(doc));
  const before = at === 0 ? "" : blankLinesBefore(doc, at);
  const following = doc.sliceString(at, at + 2);
  const newlines = following === "\n\n" ? 2 : following.startsWith("\n") ? 1 : 0;
  const block = before + markdown.trim();
  view.dispatch({
    changes: { from: at, insert: block + "\n".repeat(Math.max(0, 2 - newlines)) },
    selection: { anchor: at + block.length },
    scrollIntoView: true,
    userEvent: "input.paste",
  });
  view.focus();
}

/** Inserts a footnote marker at the cursor, adding the definition if missing. */
export function insertCitation(view: EditorView, source: Source): void {
  const { from, to } = view.state.selection.main;
  const marker = footnoteMarker(source);
  view.dispatch({
    changes: withDefinition(view.state.doc, { from, to, insert: marker }, source),
    selection: { anchor: from + marker.length },
    scrollIntoView: true,
    userEvent: "input.cite",
  });
  view.focus();
}

/** `change`, followed by appending the source's footnote definition if the result lacks one. */
function withDefinition(doc: Text, change: ChangeSpec, source: Source): ChangeSet {
  return withFootnoteDefinition(doc, change, footnoteDefinition(source));
}

/** `change`, followed by appending `definition` (a `[^id]: …` line) if the result has none for that id. */
export function withFootnoteDefinition(doc: Text, change: ChangeSpec, definition: string): ChangeSet {
  const first = ChangeSet.of(change, doc.length);
  const next = first.apply(doc);
  const text = next.toString();
  const id = /^\[\^([^\]]+)\]:/.exec(definition)![1]!;
  if (hasDefinition(text, { id })) return first;
  // Footnote definitions collect at the end of the article: one per line,
  // with a blank line between them and the body.
  const content = text.replace(/\n+$/, "");
  const lastLine = content.slice(content.lastIndexOf("\n") + 1);
  const newlines = content === "" ? 0 : FOOTNOTE_DEFINITION.test(lastLine) ? 1 : 2;
  const separator = "\n".repeat(Math.max(0, newlines - (text.length - content.length)));
  const appended = { from: next.length, insert: separator + definition + "\n" };
  return first.compose(ChangeSet.of(appended, next.length));
}

const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:/;

/** Start of the block of footnote definitions at the end of the document (or its end if none). */
function footnotesStart(doc: Text): number {
  let start = doc.length;
  for (let n = doc.lines; n >= 1; n--) {
    const line = doc.line(n);
    if (FOOTNOTE_DEFINITION.test(line.text)) start = line.from;
    else if (line.text.trim() && !/^( {4}|\t)/.test(line.text)) break; // not blank, not a continuation
  }
  return start;
}

function blankLinesBefore(doc: Text, pos: number): string {
  const preceding = doc.sliceString(Math.max(0, pos - 2), pos);
  return preceding.endsWith("\n\n") ? "" : preceding.endsWith("\n") ? "\n" : "\n\n";
}

// --- Formatting commands -----------------------------------------------------

export const commands: Record<string, Command> = {
  bold: toggleInline("**"),
  italic: toggleInline("*"),
  code: toggleInline("`"),
  link: insertLink,
  quote: toggleLinePrefix("> "),
  bullets: toggleLinePrefix("- "),
  numbers: toggleLinePrefix("1. "),
  h1: setHeading(1),
  h2: setHeading(2),
  h3: setHeading(3),
};

/** Wraps each selection in `marker`, or unwraps it if already wrapped. */
function toggleInline(marker: string): Command {
  return (view) => {
    const { state } = view;
    const n = marker.length;
    view.dispatch(
      state.changeByRange((range) => {
        const before = state.sliceDoc(range.from - n, range.from);
        const after = state.sliceDoc(range.to, range.to + n);
        if (before === marker && after === marker) {
          return {
            changes: [
              { from: range.from - n, to: range.from },
              { from: range.to, to: range.to + n },
            ],
            range: EditorSelection.range(range.from - n, range.to - n),
          };
        }
        return {
          changes: [
            { from: range.from, insert: marker },
            { from: range.to, insert: marker },
          ],
          range: EditorSelection.range(range.from + n, range.to + n),
        };
      }),
    );
    return true;
  };
}

/** `[selection](url)` with "url" selected, or `[](url)` with the cursor in the brackets. */
function insertLink(view: EditorView): boolean {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const insert = `[${text}](url)`;
      const selection = text
        ? EditorSelection.range(range.from + text.length + 3, range.from + text.length + 6)
        : EditorSelection.cursor(range.from + 1);
      return { changes: { from: range.from, to: range.to, insert }, range: selection };
    }),
  );
  return true;
}

/** Adds `prefix` to every selected line, or removes it if all lines already have it. */
function toggleLinePrefix(prefix: string): Command {
  const pattern = prefix === "1. " ? /^\d+\. / : new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  return (view) => {
    const lines = selectedLines(view.state);
    const all = lines.every((line) => pattern.test(line.text) || !line.text.trim());
    const changes: ChangeSpec[] = [];
    let number = 1;
    for (const line of lines) {
      if (!line.text.trim()) continue;
      const match = pattern.exec(line.text);
      if (all && match) changes.push({ from: line.from, to: line.from + match[0].length });
      else if (!all && !match) changes.push({ from: line.from, insert: prefix === "1. " ? `${number++}. ` : prefix });
    }
    view.dispatch({ changes });
    return true;
  };
}

/** Sets the selected lines to heading `level` (0 removes the heading). Repeating a level removes it. */
function setHeading(level: number): Command {
  return (view) => {
    const lines = selectedLines(view.state);
    const target = "#".repeat(level);
    const toggleOff = lines.every((line) => /^(#+) /.exec(line.text)?.[1] === target);
    view.dispatch({
      changes: lines.map((line) => {
        const existing = /^#+ /.exec(line.text)?.[0] ?? "";
        const insert = level === 0 || toggleOff ? "" : `${target} `;
        return { from: line.from, to: line.from + existing.length, insert };
      }),
    });
    return true;
  };
}

function selectedLines(state: EditorState) {
  const seen = new Set<number>();
  const lines = [];
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        lines.push(line);
      }
      pos = line.to + 1;
    }
  }
  return lines;
}
