import type { Card, Project, Source } from "../src/types.ts";
import type { Usage } from "./citations.ts";
import { dirOf, renderMarkdown } from "./markdown.ts";

/** Drag payload type for cards (and text selections inside cards). */
export const CARD_MIME = "application/x-research-card";

export interface CardDrag {
  cardId: string;
  text: string;
}

export interface ResearchActions {
  insert(source: Source, text: string): void;
  cite(source: Source): void;
  copy(source: Source, text: string): void;
  openFile(path: string): void;
  openUrl(url: string): void;
}

const COLLAPSED_KEY = "collapsed-decks";

/** The research panel: one deck of index cards per source linked from research.md. */
export class ResearchPanel {
  #root: HTMLElement;
  #actions: ResearchActions;
  #cards = new Map<string, { card: Card; source: Source }>();
  #sources = new Map<string, Source>();
  #filter = "";
  #usage: Usage | null = null;
  #canInsert = true;
  #collapsed = new Set<string>(loadCollapsed());

  constructor(root: HTMLElement, actions: ResearchActions) {
    this.#root = root;
    this.#actions = actions;
    root.addEventListener("click", (event) => this.#onClick(event));
    // Keep the text selection inside a card when its buttons are pressed.
    root.addEventListener("mousedown", (event) => {
      if ((event.target as Element).closest("button")) event.preventDefault();
    });
    root.addEventListener("dragstart", (event) => this.#onDragStart(event));
  }

  get cardCount(): number {
    return this.#cards.size;
  }

  card(id: string): { card: Card; source: Source } | undefined {
    return this.#cards.get(id);
  }

  setProject(project: Project): void {
    this.#cards.clear();
    this.#sources.clear();
    const sections = project.sections.map((section) => {
      const element = h("section", { class: "research-section" });
      if (section.heading) element.append(h("h2", { class: "section-heading" }, section.heading));
      element.append(...section.sources.map((source) => this.#renderDeck(source)));
      return element;
    });

    if (sections.length === 0) {
      const hint = project.research
        ? "research.md doesn't link to any sources yet. Add links like [Title](sources/title.md)."
        : "No research.md in this folder. Create one with links to markdown files holding your sources.";
      sections.push(h("p", { class: "empty" }, hint));
    }
    this.#root.replaceChildren(...sections);
    this.#applyFilter();
    this.#applyUsage();
  }

  setUsage(usage: Usage): void {
    this.#usage = usage;
    this.#applyUsage();
  }

  /** Insert/Cite only make sense while the article is open. */
  setCanInsert(canInsert: boolean): void {
    this.#canInsert = canInsert;
    this.#root.classList.toggle("read-only", !canInsert);
  }

  setFilter(filter: string): void {
    this.#filter = filter.trim().toLowerCase();
    this.#applyFilter();
  }

  #renderDeck(source: Source): HTMLElement {
    this.#sources.set(source.id, source);
    const meta = [source.author, source.date].filter(Boolean).join(" · ");
    const deck = h("section", { class: "deck", "data-source": source.id });
    deck.classList.toggle("collapsed", this.#collapsed.has(source.id));

    const title = source.url
      ? h("a", { href: source.url, class: "deck-title", title: source.url }, source.title)
      : h("span", { class: "deck-title" }, source.title);
    deck.append(
      h(
        "header",
        { class: "deck-head" },
        h("button", { class: "deck-toggle", "data-action": "toggle", title: "Collapse" }),
        h(
          "div",
          { class: "deck-info" },
          title,
          meta ? h("div", { class: "deck-meta" }, meta) : "",
          source.note ? h("div", { class: "deck-note" }, source.note) : "",
        ),
        h(
          "div",
          { class: "deck-actions" },
          h("span", { class: "cited-badge", title: "Footnote references in the article" }),
          h("button", { "data-action": "cite", class: "insert-only", title: `Insert [^${source.id}] at the cursor` }, "Cite"),
          source.path && !source.missing
            ? h("button", { "data-action": "open", title: `Edit ${source.path}` }, "Edit")
            : "",
        ),
      ),
    );

    const cards = h("div", { class: "cards" });
    if (source.missing) cards.append(h("p", { class: "empty" }, `Not found: ${source.path}`));
    else if (source.path && source.cards.length === 0) cards.append(h("p", { class: "empty" }, "No notes or quotes yet."));
    for (const card of source.cards) {
      this.#cards.set(card.id, { card, source });
      const body = h("div", { class: "card-body prose" });
      body.innerHTML = renderMarkdown(card.markdown, dirOf(source.path ?? ""));
      cards.append(
        h(
          "article",
          { class: `card ${card.kind}`, "data-card": card.id },
          h(
            "div",
            { class: "card-head" },
            h("span", { class: "card-grip", draggable: "true", title: "Drag into the article" }, "⠿"),
            h("span", { class: "card-heading" }, card.heading ?? (card.kind === "quote" ? "Quote" : "Note")),
            h("span", { class: "used-badge", title: "This quote appears in the article" }, "used"),
            h(
              "span",
              { class: "card-actions" },
              h("button", { "data-action": "insert", class: "insert-only", title: "Insert as a quote with footnote (or just the selected text)" }, "Insert"),
              h("button", { "data-action": "copy", title: "Copy quote and footnote as markdown" }, "Copy"),
            ),
          ),
          body,
        ),
      );
    }
    deck.append(cards);
    return deck;
  }

  #onClick(event: MouseEvent): void {
    const target = event.target as Element;
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (link) {
      event.preventDefault();
      if (/^https?:|^mailto:/i.test(link.getAttribute("href")!)) this.#actions.openUrl(link.href);
      return;
    }

    const button = target.closest<HTMLButtonElement>("button[data-action]");
    if (!button) return;
    const deck = button.closest<HTMLElement>(".deck")!;
    const source = this.#sources.get(deck.dataset.source!)!;
    const cardElement = button.closest<HTMLElement>(".card");
    const entry = cardElement ? this.#cards.get(cardElement.dataset.card!) : undefined;

    switch (button.dataset.action) {
      case "toggle":
        deck.classList.toggle("collapsed");
        if (deck.classList.contains("collapsed")) this.#collapsed.add(source.id);
        else this.#collapsed.delete(source.id);
        saveCollapsed(this.#collapsed);
        break;
      case "cite":
        this.#actions.cite(source);
        break;
      case "open":
        this.#actions.openFile(source.path!);
        break;
      case "insert":
        if (entry) this.#actions.insert(source, selectedText(cardElement!) ?? entry.card.markdown);
        break;
      case "copy":
        if (entry) this.#actions.copy(source, selectedText(cardElement!) ?? entry.card.markdown);
        break;
    }
  }

  #onDragStart(event: DragEvent): void {
    const target = event.target instanceof Element ? event.target : (event.target as Node).parentElement;
    const cardElement = target?.closest<HTMLElement>(".card");
    const entry = cardElement && this.#cards.get(cardElement.dataset.card!);
    if (!entry || !event.dataTransfer || !this.#canInsert) return;
    const text = selectedText(cardElement) ?? entry.card.markdown;
    const drag: CardDrag = { cardId: entry.card.id, text };
    event.dataTransfer.setData(CARD_MIME, JSON.stringify(drag));
    event.dataTransfer.setData("text/plain", text);
    event.dataTransfer.effectAllowed = "copy";
    if (target?.classList.contains("card-grip")) event.dataTransfer.setDragImage(cardElement, 16, 16);
  }

  #applyFilter(): void {
    const filter = this.#filter;
    for (const deck of this.#root.querySelectorAll<HTMLElement>(".deck")) {
      const source = this.#sources.get(deck.dataset.source!)!;
      const deckMatches = !filter || matches(filter, source.title, source.author, source.note, source.id);
      let visibleCards = 0;
      for (const cardElement of deck.querySelectorAll<HTMLElement>(".card")) {
        const { card } = this.#cards.get(cardElement.dataset.card!)!;
        const visible = deckMatches || matches(filter, card.markdown, card.heading);
        cardElement.hidden = !visible;
        if (visible) visibleCards++;
      }
      deck.hidden = !deckMatches && visibleCards === 0;
      // Show matching cards even in collapsed decks.
      deck.classList.toggle("filtering", Boolean(filter) && visibleCards > 0);
    }
    for (const section of this.#root.querySelectorAll<HTMLElement>(".research-section")) {
      section.hidden = !section.querySelector(".deck:not([hidden])") && Boolean(section.querySelector(".deck"));
    }
  }

  #applyUsage(): void {
    const usage = this.#usage;
    if (!usage) return;
    for (const deck of this.#root.querySelectorAll<HTMLElement>(".deck")) {
      const source = this.#sources.get(deck.dataset.source!)!;
      const count = usage.citedCount(source);
      deck.classList.toggle("cited", count > 0);
      deck.querySelector(".cited-badge")!.textContent = count > 0 ? `cited ${count}×` : "";
    }
    for (const cardElement of this.#root.querySelectorAll<HTMLElement>(".card")) {
      const { card } = this.#cards.get(cardElement.dataset.card!)!;
      cardElement.classList.toggle("used", usage.quotes(card));
    }
  }
}

/** Text selected inside `element`, if the selection is entirely within it. */
function selectedText(element: Element): string | null {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().trim();
  return text || null;
}

function matches(filter: string, ...fields: (string | null)[]): boolean {
  return fields.some((field) => field?.toLowerCase().includes(filter));
}

function h(tag: string, attributes: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}

function loadCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Per-session only, then.
  }
}
