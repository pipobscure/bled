// Shared between node (src/) and the page (web/). Paths are relative to the project root, using "/".

export interface Project {
  root: string;
  /** Project directory name, used as a fallback title. */
  name: string;
  /** The article being written. May not exist on disk yet. */
  article: string;
  /** Other top-level markdown files that could be the article. */
  articleCandidates: string[];
  /** `research.md`, if present. */
  research: string | null;
  sections: ResearchSection[];
}

/** A group of sources under one heading in research.md. */
export interface ResearchSection {
  heading: string | null;
  sources: Source[];
}

export interface Source {
  /** Footnote label, e.g. `[^smith-2024]`. Unique within the project. */
  id: string;
  /** Markdown file holding the source material; null for plain web links. */
  path: string | null;
  title: string;
  url: string | null;
  author: string | null;
  date: string | null;
  /** Text around the link in research.md, e.g. "- [Title](a.md) — why it matters". */
  note: string | null;
  /** Linked from research.md but not found on disk. */
  missing: boolean;
  cards: Card[];
}

export interface Card {
  id: string;
  kind: "quote" | "note";
  /** Nearest heading above the card in the source file. */
  heading: string | null;
  /** Card body as markdown (blockquote markers removed for quotes). */
  markdown: string;
}
