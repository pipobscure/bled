import { Marked, type Tokens } from "marked";
import markedFootnote from "marked-footnote";

// Relative image paths resolve against the directory of the file being rendered,
// served by node under /files/.
let baseDir = "";

const marked = new Marked({
  gfm: true,
  walkTokens(token) {
    if (token.type === "image") {
      const image = token as Tokens.Image;
      if (!/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(image.href)) image.href = `/files/${joinPath(baseDir, image.href)}`;
    }
  },
}).use(markedFootnote());

/**
 * Renders markdown to HTML. Raw HTML in the markdown is passed through; the
 * page's Content-Security-Policy keeps any scripts in it from running.
 */
export function renderMarkdown(markdown: string, fileDir = ""): string {
  baseDir = fileDir;
  return marked.parse(stripFrontmatter(markdown), { async: false });
}

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

export function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export function joinPath(dir: string, path: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}
