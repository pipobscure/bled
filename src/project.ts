import { readdir, readFile } from "node:fs/promises";
import { basename, posix } from "node:path";
import { lexer, type Token, type Tokens } from "marked";
import type { Card, Project, ResearchSection, Source } from "./types.ts";

const RESEARCH_FILE = "research.md";
const PREFERRED_ARTICLES = ["index.md", "post.md", "article.md", "draft.md"];

/** Reads the project directory: picks the article and turns research.md's links into card decks. */
export async function loadProject(root: string): Promise<Project> {
  const entries = await readdir(root, { withFileTypes: true });
  const topLevelMarkdown = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort();

  const research = topLevelMarkdown.find((name) => name.toLowerCase() === RESEARCH_FILE) ?? null;
  const sections = research ? await loadResearch(root, research) : [];

  const sourcePaths = new Set(sections.flatMap((section) => section.sources.map((source) => source.path)));
  const articleCandidates = topLevelMarkdown.filter((name) => name !== research && !sourcePaths.has(name));
  const article =
    PREFERRED_ARTICLES.find((name) => articleCandidates.includes(name)) ?? articleCandidates[0] ?? "post.md";

  return { root, name: basename(root), article, articleCandidates, research, sections };
}

async function loadResearch(root: string, researchPath: string): Promise<ResearchSection[]> {
  const markdown = await readFile(posix.join(root, researchPath), "utf8");
  const sections: ResearchSection[] = [{ heading: null, sources: [] }];
  const seen = new Set<string>();
  const ids = new Set<string>();

  const addLinks = (inline: Token[]) => {
    const links = findLinks(inline);
    if (links.length === 0) return;
    // Whatever surrounds the link(s) in this list item / paragraph is the researcher's note.
    let note = inline.map((token) => token.raw).join("");
    for (const link of links) note = note.replace(link.raw, "");
    note = note.replace(/^[\s\-–—:,;]+|[\s\-–—:,;]+$/g, "");

    for (const link of links) {
      const target = resolveHref(link.href, posix.dirname(researchPath));
      if (!target || seen.has(target.key)) continue;
      seen.add(target.key);
      sections.at(-1)!.sources.push({
        id: "",
        path: target.path,
        title: link.text,
        url: target.url,
        author: null,
        date: null,
        note: note || null,
        missing: false,
        cards: [],
      });
    }
  };

  const visit = (token: Token) => {
    switch (token.type) {
      case "heading":
        sections.push({ heading: (token as Tokens.Heading).text, sources: [] });
        break;
      case "paragraph":
        addLinks((token as Tokens.Paragraph).tokens);
        break;
      case "list":
        for (const item of (token as Tokens.List).items) {
          addLinks(item.tokens.filter((child) => child.type !== "list"));
          item.tokens.filter((child) => child.type === "list").forEach(visit);
        }
        break;
      case "blockquote":
        (token as Tokens.Blockquote).tokens.forEach(visit);
        break;
    }
  };
  lexer(stripFrontmatter(markdown).body).forEach(visit);

  for (const source of sections.flatMap((section) => section.sources)) {
    if (source.path) await loadSourceFile(root, source);
    source.id = uniqueId(source.id || slugify(source.path ? basename(source.path, ".md") : source.title), ids);
  }
  return sections.filter((section) => section.sources.length > 0);
}

/** Fills in a source's metadata and cards from its markdown file. */
async function loadSourceFile(root: string, source: Source): Promise<void> {
  let markdown: string;
  try {
    markdown = await readFile(posix.join(root, source.path!), "utf8");
  } catch {
    source.missing = true;
    return;
  }

  const { meta, body } = stripFrontmatter(markdown);
  const tokens = lexer(body);
  const h1 = tokens.find((token): token is Tokens.Heading => token.type === "heading" && token.depth === 1);

  source.title = meta.title ?? h1?.text ?? source.title;
  source.url = meta.url ?? meta.source ?? meta.link ?? source.url;
  source.author = meta.author ?? meta.authors ?? null;
  source.date = meta.date ?? meta.published ?? null;
  if (meta.id) source.id = slugify(meta.id);

  // Every blockquote is a quote card; other content is grouped into one note card per heading.
  let heading: string | null = null;
  let note: string[] = [];
  const flushNote = () => {
    const markdown = note.join("").trim();
    if (markdown) source.cards.push({ id: "", kind: "note", heading, markdown });
    note = [];
  };

  for (const token of tokens) {
    if (token === h1) continue;
    switch (token.type) {
      case "heading":
        flushNote();
        heading = (token as Tokens.Heading).text;
        break;
      case "blockquote":
        flushNote();
        source.cards.push({ id: "", kind: "quote", heading, markdown: unquote(token.raw) });
        break;
      case "hr":
        flushNote();
        break;
      default:
        note.push(token.raw);
    }
  }
  flushNote();
  source.cards.forEach((card, index) => (card.id = `${source.path}#${index}`));
}

function findLinks(tokens: Token[]): Tokens.Link[] {
  const links: Tokens.Link[] = [];
  for (const token of tokens) {
    if (token.type === "link") links.push(token as Tokens.Link);
    else if ("tokens" in token && Array.isArray(token.tokens)) links.push(...findLinks(token.tokens));
  }
  return links;
}

function resolveHref(href: string, fromDir: string): { key: string; path: string | null; url: string | null } | null {
  if (/^https?:\/\//i.test(href)) return { key: href, path: null, url: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  const path = posix.normalize(posix.join(fromDir, decodeURI(href.split("#")[0]!)));
  if (!path.toLowerCase().endsWith(".md") || path.startsWith("..")) return null;
  return { key: path, path, url: null };
}

/** Splits off a `---` YAML-style header. Only flat `key: value` pairs are supported. */
function stripFrontmatter(markdown: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) return { meta: {}, body: markdown };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (pair?.[2]) meta[pair[1]!.toLowerCase()] = pair[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: markdown.slice(match[0].length) };
}

function unquote(raw: string): string {
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => line.replace(/^ {0,3}> ?/, ""))
    .join("\n");
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 40) || "source"
  );
}

function uniqueId(id: string, taken: Set<string>): string {
  let candidate = id;
  for (let n = 2; taken.has(candidate); n++) candidate = `${id}-${n}`;
  taken.add(candidate);
  return candidate;
}
