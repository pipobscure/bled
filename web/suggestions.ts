import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

// AI suggestions are underlined in the editor. Their ranges live in the editor
// state, so they move with the text as the author keeps typing.

interface Range {
  id: string;
  from: number;
  to: number;
}

const addRanges = StateEffect.define<Range[]>();
const removeRange = StateEffect.define<string>();
const clearRanges = StateEffect.define<null>();
const setActive = StateEffect.define<string | null>();

const mark = (id: string, active: boolean) =>
  Decoration.mark({
    class: active ? "cm-suggestion cm-suggestion-active" : "cm-suggestion",
    attributes: { "data-suggestion": id },
    id,
  });

const suggestionField = StateField.define<{ ranges: DecorationSet; active: string | null }>({
  create: () => ({ ranges: Decoration.none, active: null }),
  update({ ranges, active }, transaction) {
    ranges = ranges.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(addRanges)) {
        ranges = ranges.update({
          add: effect.value.filter((r) => r.to > r.from).map((r) => mark(r.id, r.id === active).range(r.from, r.to)),
          sort: true,
        });
      } else if (effect.is(removeRange)) {
        ranges = ranges.update({ filter: (_from, _to, value) => value.spec.id !== effect.value });
      } else if (effect.is(clearRanges)) {
        ranges = Decoration.none;
      } else if (effect.is(setActive)) {
        active = effect.value;
        const rebuilt: ReturnType<ReturnType<typeof mark>["range"]>[] = [];
        ranges.between(0, transaction.state.doc.length, (from, to, value) => {
          rebuilt.push(mark(value.spec.id, value.spec.id === active).range(from, to));
        });
        ranges = Decoration.set(rebuilt, true);
      }
    }
    return { ranges, active };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.ranges),
});

/** Editor extension; `onClick` fires when an underlined suggestion is clicked. */
export function suggestionsExtension(onClick: (id: string) => void): Extension {
  return [
    suggestionField,
    EditorView.domEventHandlers({
      click: (event) => {
        const id = (event.target as Element).closest<HTMLElement>("[data-suggestion]")?.dataset.suggestion;
        if (id) onClick(id);
        return false;
      },
    }),
  ];
}

export function addSuggestionRanges(view: EditorView, ranges: Range[]): void {
  view.dispatch({ effects: addRanges.of(ranges) });
}

export function removeSuggestionRange(view: EditorView, id: string): void {
  view.dispatch({ effects: removeRange.of(id) });
}

export function clearSuggestionRanges(view: EditorView): void {
  view.dispatch({ effects: clearRanges.of(null) });
}

export function setActiveSuggestion(view: EditorView, id: string | null): void {
  view.dispatch({ effects: setActive.of(id) });
}

/** Current position of a suggestion, or null if it was removed or its text deleted. */
export function suggestionRange(state: EditorState, id: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.field(suggestionField, false)?.ranges.between(0, state.doc.length, (from, to, value) => {
    if (value.spec.id === id) {
      found = { from, to };
      return false;
    }
  });
  return found;
}

/**
 * Finds each `original` in `text[from, to)`, in order, so repeated phrases map
 * to successive occurrences. Falls back to whitespace-insensitive matching.
 */
export function locate(text: string, originals: string[], from = 0, to = text.length): ({ from: number; to: number } | null)[] {
  let cursor = from;
  return originals.map((original) => {
    if (!original) return null;
    const found = findFrom(text, original, cursor, to) ?? findFrom(text, original, from, to);
    if (found) cursor = found.to;
    return found;
  });
}

function findFrom(text: string, needle: string, from: number, to: number): { from: number; to: number } | null {
  const index = text.indexOf(needle, from);
  if (index !== -1 && index + needle.length <= to) return { from: index, to: index + needle.length };
  // Models often re-wrap lines or collapse spaces; match any whitespace run.
  const pattern = new RegExp(needle.trim().split(/\s+/).map(escapeRegExp).join("\\s+"), "g");
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match && match.index + match[0].length <= to ? { from: match.index, to: match.index + match[0].length } : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type DiffPart = { type: "same" | "del" | "ins"; text: string };

/** Word-level diff for showing a suggestion. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = before.match(/\s+|\w+|[^\s\w]/g) ?? [];
  const b = after.match(/\s+|\w+|[^\s\w]/g) ?? [];
  if (a.length * b.length > 4_000_000) return [{ type: "del", text: before }, { type: "ins", text: after }];
  // Longest common subsequence table, filled from the end.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const parts: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string) => {
    const last = parts.at(-1);
    if (last?.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) push("same", a[i++]!), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push("del", a[i++]!);
    else push("ins", b[j++]!);
  }
  while (i < a.length) push("del", a[i++]!);
  while (j < b.length) push("ins", b[j++]!);
  return parts;
}
