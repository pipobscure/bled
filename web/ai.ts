import type { Project, Source } from "../src/types.ts";
import { isPublished } from "./citations.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiSettings {
  baseUrl: string;
  model: string;
  extraBody: Record<string, unknown>;
  hasKey: boolean;
}

export interface AiProgress {
  /** Answer text so far. */
  text: string;
  /** Characters of reasoning so far (reasoning models think before answering). */
  reasoning: number;
}

// --- Prompts -------------------------------------------------------------------

/** Research beyond this size is trimmed to the sources the article already cites. */
const RESEARCH_BUDGET = 150_000;

const SYSTEM = `You are a writing assistant and editor built into a markdown editor for blog posts. The author is writing an article backed by research sources.

Rules:
- Match the author's voice and the article's language.
- Write markdown. Citations are footnotes: put [^id] right after the claim it supports, using only the source ids listed under "Research sources" that have a published URL. Sources marked "not citable" are the author's internal notes: use them for background, but never cite them. Never invent sources, ids, quotes, figures or dates. If a claim needs support that the research doesn't contain, say so plainly.
- Quotes from sources must be verbatim.
- Be concise. No preamble.`;

export function researchContext(project: Project, article: string): string {
  const sources = project.sections.flatMap((section) => section.sources);
  const full = sources.map((source) => describeSource(source, true)).join("\n\n");
  if (full.length <= RESEARCH_BUDGET) return full;
  // Too big: full text for cited sources, a summary line for the rest.
  return sources.map((source) => describeSource(source, article.includes(`[^${source.id}]`))).join("\n\n");
}

function describeSource(source: Source, withCards: boolean): string {
  const meta = [source.author, source.date, source.url].filter(Boolean).join(" · ");
  const lines = [`## [^${source.id}] ${source.title}${meta ? ` (${meta})` : ""}`];
  if (!isPublished(source)) lines.push("Not citable: an internal research note with no published URL.");
  if (source.note) lines.push(`Why it matters: ${source.note}`);
  if (withCards) {
    for (const card of source.cards) {
      const heading = card.heading ? ` — ${card.heading}` : "";
      lines.push(
        card.kind === "quote"
          ? `Quote${heading}:\n${card.markdown.replace(/^/gm, "> ")}`
          : `Notes${heading}:\n${card.markdown}`,
      );
    }
  } else {
    lines.push("(content omitted; not cited in the article yet)");
  }
  return lines.join("\n");
}

function contextMessage(project: Project, path: string, text: string): ChatMessage {
  return {
    role: "system",
    content: `${SYSTEM}\n\n# Research sources\n\n${researchContext(project, text)}\n\n# The document being edited (${path})\n\n<document>\n${text}\n</document>`,
  };
}

export function chatMessages(
  project: Project,
  doc: { path: string; text: string },
  history: ChatMessage[],
): ChatMessage[] {
  return [contextMessage(project, doc.path, doc.text), ...history];
}

/** User message for a chat turn, quoting the selection it refers to. */
export function chatTurn(question: string, selection: string | null): string {
  return selection ? `Selected passage:\n<selection>\n${selection}\n</selection>\n\n${question}` : question;
}

export function rewriteMessages(
  project: Project,
  doc: { path: string; text: string },
  selection: string,
  instruction: string,
): ChatMessage[] {
  return [
    contextMessage(project, doc.path, doc.text),
    {
      role: "user",
      content: `Rewrite this passage from the document:\n<selection>\n${selection}\n</selection>\n\nInstruction: ${instruction}\n\nReply with only the replacement markdown for the passage: no explanation, no code fences, no surrounding quotes. Keep existing footnote markers unless the instruction says otherwise.`,
    },
  ];
}

const SUGGESTION_FORMAT = `Reply with JSON only, no code fences, in this shape:
{"suggestions": [{"original": "...", "replacement": "...", "reason": "...", "kind": "..."}]}

- "original": text copied exactly, character for character, from the document. Keep it short (a phrase or one sentence) but long enough to be unique.
- "replacement": the corrected version of "original", or null when the author has to decide.
- "reason": one short sentence.
Return {"suggestions": []} if there is nothing to fix.`;

export function proofreadMessages(text: string, isSelection: boolean): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You are a meticulous copy editor for blog posts written in markdown. Find spelling, grammar, punctuation, word-choice and clarity problems. Keep the author's voice: only suggest style changes where a sentence is clearly awkward or hard to follow. Never touch footnote markers like [^id], footnote definitions, link URLs, or text inside quotes from sources (lines starting with ">").

kind is one of: "spelling", "grammar", "punctuation", "word choice", "clarity", "style".

${SUGGESTION_FORMAT}`,
    },
    { role: "user", content: `${isSelection ? "Proofread this passage" : "Proofread this article"}:\n\n<document>\n${text}\n</document>` },
  ];
}

export function sourceCheckMessages(project: Project, path: string, text: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You are a fact-checker for a blog post written in markdown. Compare the document's claims with the research sources and report problems:
- "unsupported": a factual claim that no source supports
- "contradicted": a claim that a source contradicts
- "misquote": quoted text that differs from the source's wording
- "wrong citation": a footnote marker pointing at a source that doesn't support the claim
- "missing citation": a claim a source supports, but without its footnote marker

Footnote markers look like [^id]; ids belong to the sources below. Citations must lead readers to published, external sources: only sources with a URL may be cited, never those marked "not citable" (internal research notes). For "missing citation" and "wrong citation", the replacement is the original text with the right marker of a citable source; if only a non-citable note supports the claim, report it as "unsupported" instead. Don't report problems with footnote definitions; those are checked separately. For "misquote", it is the original with the source's exact wording. For "unsupported" and "contradicted", give a corrected wording only if a source supports one; otherwise null. Mention the relevant source id in "reason". Only report real problems; don't nitpick style.

${SUGGESTION_FORMAT}

# Research sources

${researchContext(project, text)}`,
    },
    { role: "user", content: `Check this document (${path}):\n\n<document>\n${text}\n</document>` },
  ];
}

export interface RawSuggestion {
  original: string;
  replacement: string | null;
  reason: string;
  kind: string;
  /** A footnote definition to add at the end of the document when applying (if it has none for that id). */
  definition?: string;
  /** Applicable once the author supplies a published URL. */
  withUrl?: (url: string) => UrlFix;
}

export interface UrlFix {
  replacement: string;
  definition?: string;
  /** Research note whose front matter should record the URL. */
  note?: string;
}

/** Parses the model's JSON reply, tolerating code fences and surrounding chatter. */
export function parseSuggestions(reply: string): RawSuggestion[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The model didn't return JSON.");
  const parsed = JSON.parse(reply.slice(start, end + 1)) as { suggestions?: unknown };
  if (!Array.isArray(parsed.suggestions)) throw new Error("The model's JSON has no suggestions list.");
  return parsed.suggestions
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null && typeof s.original === "string")
    .map((s) => ({
      original: s.original as string,
      replacement: typeof s.replacement === "string" ? s.replacement : null,
      reason: typeof s.reason === "string" ? s.reason : "",
      kind: typeof s.kind === "string" ? s.kind : "",
    }))
    .filter((s) => s.original !== s.replacement);
}

/** "Thinking… 12k" / "Writing… 1.2k" status for a run in progress. */
export function describeProgress({ text, reasoning }: AiProgress): string {
  const size = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);
  if (text) return `Writing… ${size(text.length)} characters`;
  if (reasoning) return `Thinking… ${size(reasoning)} characters`;
  return "Waiting for the model…";
}

/**
 * Splits a document into parts of roughly `size` characters at blank lines, so
 * long documents can be proofread in several smaller requests.
 */
export function splitIntoParts(text: string, size = 3500): { from: number; to: number }[] {
  const parts: { from: number; to: number }[] = [];
  let from = 0;
  while (from < text.length) {
    let to = Math.min(text.length, from + size);
    if (to < text.length) {
      const paragraphBreak = text.lastIndexOf("\n\n", to);
      const nextBreak = text.indexOf("\n\n", to);
      to = paragraphBreak > from + size / 3 ? paragraphBreak + 2 : nextBreak === -1 ? text.length : nextBreak + 2;
    }
    if (text.slice(from, to).trim()) parts.push({ from, to });
    from = to;
  }
  return parts;
}
