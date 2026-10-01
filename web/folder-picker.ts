import { bridge } from "./bridge.ts";

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  project: boolean;
  folders: { name: string; project: boolean }[];
}

interface Recent {
  path: string;
  name: string;
}

const $ = <T extends HTMLElement>(root: ParentNode, selector: string) => root.querySelector<T>(selector)!;

/**
 * Lets the user pick a project folder: recent folders, plus a browser over the
 * file system that node lists for us. Resolves with the chosen path, or null.
 */
export function pickFolder(startAt: string | null): Promise<string | null> {
  const dialog = document.querySelector<HTMLDialogElement>("#folder-dialog")!;
  const pathInput = $<HTMLInputElement>(dialog, "#folder-path");
  const list = $(dialog, "#folder-list");
  const recentList = $(dialog, "#recent-list");
  const status = $(dialog, ".folder-status");
  const openButton = $<HTMLButtonElement>(dialog, "#folder-open");
  let current: Listing | null = null;

  const show = async (path: string | null) => {
    try {
      const listing = await bridge.invoke<Listing>("workspace.listDir", { path });
      current = listing;
      pathInput.value = listing.path;
      status.textContent = listing.project ? "This folder has a research.md." : "";
      openButton.textContent = `Open “${listing.path.split(/[\\/]/).pop() || listing.path}”`;
      const items = listing.folders.map((folder) =>
        item(folder.name, folder.project ? "research" : "", () => void show(join(listing.path, folder.name))),
      );
      if (listing.parent) items.unshift(item("..", "", () => void show(listing.parent)));
      if (items.length === 0) items.push(Object.assign(document.createElement("li"), { className: "empty", textContent: "No subfolders" }));
      list.replaceChildren(...items);
      list.scrollTop = 0;
    } catch (error) {
      status.textContent = (error as Error).message;
    }
  };

  return new Promise((resolve) => {
    const finish = (path: string | null) => {
      dialog.removeEventListener("close", onClose);
      pathInput.removeEventListener("keydown", onKey);
      openButton.removeEventListener("click", onOpen);
      $(dialog, "#folder-home").removeEventListener("click", onHome);
      if (dialog.open) dialog.close();
      resolve(path);
    };
    const onClose = () => finish(null);
    // Open what's in the path field, even if it was typed without pressing Enter.
    const onOpen = () => finish(pathInput.value.trim() || current?.path || null);
    const onHome = () => void show(current?.home ?? null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void show(pathInput.value.trim());
      }
    };
    dialog.addEventListener("close", onClose);
    pathInput.addEventListener("keydown", onKey);
    openButton.addEventListener("click", onOpen);
    $(dialog, "#folder-home").addEventListener("click", onHome);

    void bridge.invoke<Recent[]>("workspace.recent").then((recent) => {
      recentList.replaceChildren(
        ...recent.map((entry) => {
          const element = item(entry.name, "", () => finish(entry.path));
          element.title = entry.path;
          element.append(Object.assign(document.createElement("small"), { textContent: entry.path }));
          return element;
        }),
      );
      $(dialog, ".recent").hidden = recent.length === 0;
    });
    void show(startAt);
    dialog.showModal();
  });
}

function item(label: string, badge: string, onActivate: () => void): HTMLLIElement {
  const element = document.createElement("li");
  element.tabIndex = 0;
  element.append(Object.assign(document.createElement("span"), { textContent: label }));
  if (badge) element.append(Object.assign(document.createElement("em"), { textContent: badge }));
  element.addEventListener("click", onActivate);
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter") onActivate();
  });
  return element;
}

function join(dir: string, name: string): string {
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(separator) ? dir + name : dir + separator + name;
}
