# bled

A markdown editor for writing blog posts from your research.

Point bled at a folder holding an article and a `research.md` that links to your
source notes. It shows the sources as index cards next to the article, so you can
quote and cite them as you write, and every citation becomes a footnote. You can
also connect an AI model to help draft, proofread and check the article against
your sources.

bled runs locally: a small node process serves the editor to a Chrome window and
does all the file access. Your files stay plain markdown.

## A project folder

```
my-post/
├── article.md           the post (or index.md, post.md, …)
├── research.md          links to your sources, with a note on each
└── sources/
    ├── some-report.md
    └── an-interview.md
```

`research.md` is ordinary markdown. Each link to a markdown file becomes a deck of
cards, the text next to the link becomes the deck's note, and headings group the
decks:

```markdown
## Background

- [The Card Method](sources/card-method.md) — origin of the one-idea-per-card rule
- [Index card](https://en.wikipedia.org/wiki/Index_card) — history and sizes
```

In a source file, each blockquote becomes a quote card, and the text under each
heading becomes a note card. Optional frontmatter (`title`, `author`, `date`,
`url`) fills in the citation details. See [`example/`](example/) for a small
project.

## What you can do

- **Quote and cite.** Insert a card into the article as a blockquote with a
  footnote. bled adds the footnote definition if it's missing. You can also drag
  a card in, select part of a card to quote only that, cite a source with just a
  footnote marker, or copy a quote with its footnote.
- **See what you've used.** Decks show how often the article cites them, and
  quote cards already in the article are marked.
- **Write markdown comfortably.** Syntax highlighting, formatting shortcuts, a
  live preview with footnotes, and autosave. Files changed by other programs
  reload automatically.
- **Work with an AI assistant** (optional). Use any OpenAI-compatible API (OpenAI,
  OpenRouter, Ollama, LM Studio, …) to chat about the article, rewrite a
  selection, proofread, and check claims and citations against your sources.
  Suggestions appear in the editor, and you apply or dismiss each one.

## Running it

You need [Node.js](https://nodejs.org/) 26.10 or later and Chrome or Chromium.

From a release, download `bled.nzip` and run it with a project folder:

```sh
chmod +x bled.nzip
./bled.nzip path/to/my-post
```

Releases are signed. The release notes show how to verify a download, or how to
install it with [`bundle`](https://github.com/pipobscure/bundles), which checks
the signature for you.

From a checkout:

```sh
npm install
npm start -- path/to/my-post
```

Without a folder, bled reopens the last one you used, or asks you to pick one.
**Ctrl+O** opens another folder at any time.

To set up the assistant, open the **Assistant** tab and enter the API's base URL,
your API key and a model. The key is stored in your user config folder
(`~/.config/bled/settings.json` on Linux) and never reaches the page.

## Development

```sh
npm test            # typecheck, unit tests, and the app in a headless browser
npm run package     # build/bled.run, an unsigned archive
npm run smoke       # start the packed archive and check that it loads
```

Nothing is compiled or bundled: node runs `src/` directly, and serves the page's
modules from `web/` with their types stripped. After changing `web/`, reload the
window with Ctrl+R. After changing `src/`, restart the app.

## Licence

bled is licensed under the [European Union Public Licence v1.2](LICENSE)
(EUPL-1.2).
