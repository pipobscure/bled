import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadProject } from "../src/project.ts";
import type { Source } from "../src/types.ts";
import { parseSuggestions, splitIntoParts } from "../web/ai.ts";
import { footnoteDefinition, hasDefinition, quoteBlock, Usage } from "../web/citations.ts";
import { diffWords, locate } from "../web/suggestions.ts";

const EXAMPLE = fileURLToPath(new URL("../example/", import.meta.url));

test("research.md links become decks of cards", async () => {
  const project = await loadProject(EXAMPLE.replace(/[\\/]$/, ""));
  assert.equal(project.article, "post.md");
  assert.equal(project.research, "research.md");
  assert.deepEqual(project.sections.map((s) => s.heading), ["Background", "Counterpoints"]);

  const [method, linked, web] = project.sections[0]!.sources;
  assert.equal(method!.id, "card-method");
  assert.equal(method!.title, "The Card Method");
  assert.equal(method!.author, "Example Author");
  assert.equal(method!.note, "origin of the one-idea-per-card rule");
  assert.deepEqual(method!.cards.map((c) => c.kind), ["note", "quote", "quote", "note"]);
  assert.equal(method!.cards[1]!.heading, "Summary");
  assert.match(method!.cards[1]!.markdown, /^Put one idea on each card/);
  assert.ok(!method!.cards[1]!.markdown.includes(">"), "quote markers are stripped");

  assert.equal(linked!.id, "linked-notes");
  assert.equal(web!.path, null);
  assert.equal(web!.url, "https://en.wikipedia.org/wiki/Index_card");
});

const source: Source = {
  id: "smith",
  path: "sources/smith.md",
  title: "On Cards",
  url: "https://example.com/cards",
  author: "A. Smith",
  date: "2024",
  note: null,
  missing: false,
  cards: [{ id: "c1", kind: "quote", heading: null, markdown: "One idea per card,\nalways." }],
};

test("quotes and footnotes", () => {
  assert.equal(quoteBlock("One idea per card,\nalways.", source), "> One idea per card,\n> always.[^smith]");
  assert.equal(footnoteDefinition(source), "[^smith]: [On Cards](https://example.com/cards), A. Smith, 2024.");
  assert.ok(hasDefinition("Text.\n\n[^smith]: On Cards.", source));
  assert.ok(!hasDefinition("Text[^smith].", source));
});

test("usage counts citations and finds quoted cards", () => {
  const usage = new Usage("As noted:\n\n> One idea per *card*, always.[^smith]\n\nAgain[^smith].\n\n[^smith]: On Cards.");
  assert.equal(usage.citedCount(source), 2);
  assert.ok(usage.quotes(source.cards[0]!));
  assert.ok(!new Usage("Nothing here.").quotes(source.cards[0]!));
});

test("suggestions are located in order, tolerating rewrapped whitespace", () => {
  const text = "The cat sat.\nThe cat sat again.\nA dog  ran.";
  const [first, second, third, missing] = locate(text, ["The cat sat", "The cat sat", "A dog ran.", "a bird"]);
  assert.deepEqual(first, { from: 0, to: 11 });
  assert.deepEqual(second, { from: 13, to: 24 });
  assert.equal(text.slice(third!.from, third!.to), "A dog  ran.");
  assert.equal(missing, null);
  // Limited to a range (a selection).
  assert.deepEqual(locate(text, ["The cat sat"], 5, text.length), [{ from: 13, to: 24 }]);
});

test("word diff", () => {
  assert.deepEqual(diffWords("a quick fox", "a slow fox"), [
    { type: "same", text: "a " },
    { type: "del", text: "quick" },
    { type: "ins", text: "slow" },
    { type: "same", text: " fox" },
  ]);
});

test("model replies are parsed leniently", () => {
  const reply = 'Here you go:\n```json\n{"suggestions": [{"original": "teh", "replacement": "the", "reason": "typo", "kind": "spelling"}, {"original": "x", "replacement": "x"}, {"nope": 1}, {"original": "claim", "replacement": null}]}\n```';
  assert.deepEqual(parseSuggestions(reply), [
    { original: "teh", replacement: "the", reason: "typo", kind: "spelling" },
    { original: "claim", replacement: null, reason: "", kind: "" },
  ]);
  assert.throws(() => parseSuggestions("I can't help with that."), /didn't return JSON/);
});

test("long documents split into contiguous parts at paragraph breaks", () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} `.repeat(30).trim());
  const text = paragraphs.join("\n\n") + "\n";
  const parts = splitIntoParts(text, 3500);
  assert.ok(parts.length > 1);
  let position = 0;
  for (const part of parts) {
    assert.equal(part.from, position, "parts are contiguous");
    assert.ok(part.to === text.length || text.slice(part.to - 2, part.to) === "\n\n", "parts end at a paragraph break");
    position = part.to;
  }
  assert.equal(position, text.length);
});
