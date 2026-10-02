import type { Card, Project, Source } from "../src/types.ts";
import type { RawSuggestion } from "./ai.ts";

/** Only http(s) links lead readers to a published source; anything else is a local research file. */
export function isExternalUrl(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url);
}

/** A source the article may cite: it has a published, external URL. */
export function isPublished(source: Source): boolean {
  return isExternalUrl(source.url);
}

/** `[^id]: [Title](url), Author, Date.` */
export function footnoteDefinition(source: Source): string {
  const title = isPublished(source) ? `[${source.title}](${source.url})` : source.title;
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

export function hasDefinition(markdown: string, source: Pick<Source, "id">): boolean {
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

/**
 * Checks that every footnote in the article leads to a published, external
 * source, never to a research note: definitions must link with http(s), and
 * sources from the research must have a published URL.
 */
export function citationProblems(project: Project, article: string): RawSuggestion[] {
  const sources = new Map(project.sections.flatMap((section) => section.sources).map((s) => [s.id, s]));
  const definitions = new Map<string, string>();
  for (const match of article.matchAll(/^\[\^([^\]\s]+)\]:.*$/gm)) definitions.set(match[1]!, match[0]);
  const cited = new Set([...new Usage(article).citations.keys(), ...definitions.keys()]);

  const problems: RawSuggestion[] = [];
  for (const id of cited) {
    const source = sources.get(id);
    const definition = definitions.get(id);
    const marker = `[^${id}]`;
    // Anchor on the definition where there is one, otherwise on the first marker.
    const original = definition ?? marker;
    if (source && !isPublished(source)) {
      problems.push({
        original,
        replacement: null,
        kind: "unpublished source",
        reason: `${marker} cites “${source.title}”, a research note with no published URL${source.path ? ` (${source.path})` : ""}. Enter the original's URL${source.path ? " to record it in the note" : ""}, or cite the published source instead.`,
        withUrl: (url) => {
          const fixed = footnoteDefinition({ ...source, url });
          const note = source.path ?? undefined;
          return definition ? { replacement: fixed, note } : { replacement: marker, definition: fixed, note };
        },
      });
    } else if (!definition) {
      problems.push(
        source
          ? { original, replacement: marker, kind: "missing definition", reason: `${marker} has no footnote definition.`, definition: footnoteDefinition(source) }
          : {
              original,
              replacement: null,
              kind: "missing definition",
              reason: `${marker} has no footnote definition, so it doesn't lead readers to any source. Enter the source's URL.`,
              withUrl: (url) => ({ replacement: marker, definition: `${marker}: <${url}>.` }),
            },
      );
    } else {
      const links = [...definition.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]!);
      const bare = /https?:\/\/\S+/i.test(definition.replace(/\]\([^)]*\)/g, ""));
      const local = links.filter((link) => !isExternalUrl(link));
      const external = links.some(isExternalUrl) || bare;
      const linksSource = source && definition.includes(source.url!);
      if (local.length || (source ? !linksSource : !external)) {
        const reason = local.length
          ? `${marker} links to ${local.join(", ")}, a local file, not a published source.`
          : source
            ? `${marker} doesn't link to the published source (${source.url}).`
            : `${marker} doesn't link to a published, external source.`;
        problems.push(
          source
            ? { original: definition, replacement: footnoteDefinition(source), kind: "internal citation", reason }
            : {
                original: definition,
                replacement: null,
                kind: "internal citation",
                reason: `${reason} Enter the source's URL.`,
                withUrl: (url) => ({ replacement: linkDefinition(definition, url) }),
              },
        );
      }
    }
  }
  return problems;
}

/** Points a footnote definition's local links at `url`, or links its text if it has no links. */
export function linkDefinition(definition: string, url: string): string {
  const [, label, text] = /^(\[\^[^\]]+\]:)\s*(.*)$/.exec(definition)!;
  if (/\]\(/.test(text!)) return `${label} ${text!.replace(/\]\(\s*<?([^)\s>]+)>?/g, (link, target) => (isExternalUrl(target) ? link : `](${url}`))}`;
  const title = text!.replace(/\.$/, "").trim();
  return title ? `${label} [${title}](${url}).` : `${label} <${url}>.`;
}

/** Sets `url:` in a research note's front matter, adding front matter if it has none. */
export function withFrontmatterUrl(markdown: string, url: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) return `---\nurl: ${url}\n---\n\n${markdown}`;
  const lines = match[1]!.split(/\r?\n/);
  const existing = lines.findIndex((line) => /^url\s*:/i.test(line));
  if (existing === -1) lines.push(`url: ${url}`);
  else lines[existing] = `url: ${url}`;
  return `---\n${lines.join("\n")}\n---\n${markdown.slice(match[0].length)}`;
}

/**
 * True when a suggestion adds a footnote marker for anything but a published
 * source from the research (a research note, or an id the model made up).
 */
export function citesUnpublished(project: Project, suggestion: RawSuggestion): boolean {
  if (!suggestion.replacement) return false;
  const published = new Set(project.sections.flatMap((s) => s.sources).filter(isPublished).map((s) => s.id));
  const before = new Usage(suggestion.original).citations;
  return [...new Usage(suggestion.replacement).citations.keys()].some((id) => !before.has(id) && !published.has(id));
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
