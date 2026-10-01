import type { Card, Source } from "../src/types.ts";

/** `[^id]: [Title](url), Author, Date.` */
export function footnoteDefinition(source: Source): string {
  const title = source.url ? `[${source.title}](${source.url})` : source.title;
  const details = [title, source.author, source.date].filter(Boolean).join(", ");
  return `[^${source.id}]: ${details}.`;
}

export function footnoteMarker(source: Source): string {
  return `[^${source.id}]`;
}

/** The quote as a markdown blockquote, with the footnote marker at the end. */
export function quoteBlock(text: string, source: Source): string {
  const lines = text.trim().split("\n");
  lines[lines.length - 1] += footnoteMarker(source);
  return lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
}

/** What a card's Copy button puts on the clipboard. */
export function clipboardText(text: string, source: Source): string {
  return `${quoteBlock(text, source)}\n\n${footnoteDefinition(source)}\n`;
}

export function hasDefinition(markdown: string, source: Source): boolean {
  return new RegExp(`^\\[\\^${escapeRegExp(source.id)}\\]:`, "m").test(markdown);
}

/** How the article references the research: footnote use per source, and which quotes it contains. */
export class Usage {
  readonly citations = new Map<string, number>();
  #normalized: string;

  constructor(article: string) {
    for (const match of article.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
      this.citations.set(match[1]!, (this.citations.get(match[1]!) ?? 0) + 1);
    }
    this.#normalized = normalize(article);
  }

  citedCount(source: Source): number {
    return this.citations.get(source.id) ?? 0;
  }

  /** True when the article contains the start of the card's text (ignoring markdown and whitespace). */
  quotes(card: Card): boolean {
    const needle = normalize(card.markdown).slice(0, 80);
    return needle.length >= 12 && this.#normalized.includes(needle);
  }
}

function normalize(markdown: string): string {
  return markdown
    .replace(/\[\^[^\]\s]+\]/g, "") // footnote markers
    .replace(/^ {0,3}>+ ?/gm, "") // blockquote markers
    .replace(/[*_`~]/g, "") // emphasis and code markers
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
