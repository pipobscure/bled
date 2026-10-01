import { EventEmitter } from "node:events";
import { Launcher, launch, type LaunchedChrome } from "chrome-launcher";
import { CdpConnection } from "./cdp.ts";

/** Name of the function `Runtime.addBinding` installs on the page's `window`. */
const BINDING_NAME = "__nodeBridge";
/** DOM event the page listens for; everything node sends travels in its `detail`. */
const PAGE_EVENT = "node:message";

type Handler = (params: any) => unknown;

/** Messages the page sends through the binding. */
type PageMessage =
  | { type: "request"; id: number; method: string; params?: unknown }
  | { type: "event"; name: string; data?: unknown };

/** Messages node sends to the page via `dispatchEvent`. */
type NodeMessage =
  | { type: "ready" }
  | { type: "response"; id: number; result?: unknown; error?: string }
  | { type: "event"; name: string; data?: unknown };

/**
 * A chromeless Chrome app window pointed at `url`, with a message bridge:
 *  - page -> node: the page calls `window.__nodeBridge(json)` (a CDP binding),
 *    which arrives here as `Runtime.bindingCalled`.
 *  - node -> page: `Runtime.evaluate` runs `dispatchEvent(new CustomEvent(...))`.
 *
 * Register handlers before calling `open()`: the page may call them as soon as it loads.
 * Emits "event" (name, data) for page events and "closed" when Chrome exits.
 */
export class AppWindow extends EventEmitter {
  #handlers = new Map<string, Handler>();
  #chrome?: LaunchedChrome;
  #cdp?: CdpConnection;
  #sessionId?: string;

  async open(url: string): Promise<void> {
    if (this.#chrome) throw new Error("Window is already open");
    const chrome = await launch({
      // Keep chrome-launcher's automation-friendly defaults, but allow audio.
      ignoreDefaultFlags: true,
      chromeFlags: [
        ...Launcher.defaultFlags().filter((flag) => flag !== "--mute-audio"),
        "--remote-debugging-pipe",
        `--app=${url}`,
        "--window-size=1200,800",
      ],
    });
    if (!chrome.remoteDebuggingPipes) throw new Error("Chrome started without debugging pipes");

    this.#chrome = chrome;
    chrome.process.once("exit", () => this.emit("closed"));

    const cdp = (this.#cdp = new CdpConnection(chrome.remoteDebuggingPipes));
    const sessionId = (this.#sessionId = await attachToApp(cdp));
    cdp.on("event", (method: string, params: any, eventSession?: string) => {
      if (method === "Runtime.bindingCalled" && eventSession === sessionId && params.name === BINDING_NAME) {
        void this.#onPageMessage(params.payload);
      }
    });

    // Runtime.bindingCalled is only reported once the Runtime domain is enabled.
    await cdp.send("Runtime.enable", {}, sessionId);
    // The binding survives reloads and navigations within this session. If the
    // page script already ran before it existed, the "ready" message tells it
    // the bridge is now usable (see public/bridge.js).
    await cdp.send("Runtime.addBinding", { name: BINDING_NAME }, sessionId);
    await this.#post({ type: "ready" });
  }

  /** Registers a handler for `bridge.invoke(method, params)` calls from the page. */
  handle(method: string, handler: Handler): this {
    this.#handlers.set(method, handler);
    return this;
  }

  /** Fires a named event in the page (`bridge.on(name, ...)`). */
  send(name: string, data?: unknown): Promise<void> {
    return this.#post({ type: "event", name, data });
  }

  /** Evaluates `expression` in the page and returns its (awaited, JSON-serializable) value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as T;
  }

  /** Sends a raw CDP command to the page's session. */
  command<T = any>(method: string, params: object = {}): Promise<T> {
    if (!this.#cdp) throw new Error("Window is not open");
    return this.#cdp.send<T>(method, params, this.#sessionId);
  }

  close(): void {
    this.#chrome?.kill();
    // Release everything that ties node to the Chrome process, so closing the
    // window never leaves this process waiting on it (seen on Windows).
    this.#cdp?.dispose();
    this.#chrome?.process.unref();
  }

  async #onPageMessage(payload: string): Promise<void> {
    let message: PageMessage;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }

    if (message.type === "event") {
      this.emit("event", message.name, message.data);
      return;
    }

    const handler = this.#handlers.get(message.method);
    try {
      if (!handler) throw new Error(`No handler for "${message.method}"`);
      const result = await handler(message.params);
      await this.#post({ type: "response", id: message.id, result });
    } catch (error) {
      await this.#post({
        type: "response",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #post(message: NodeMessage): Promise<void> {
    // JSON is a valid JS expression, so it can be inlined as the event detail.
    const expression = `dispatchEvent(new CustomEvent(${JSON.stringify(PAGE_EVENT)}, { detail: ${JSON.stringify(message)} }))`;
    if (!this.#cdp) return;
    try {
      await this.#cdp.send("Runtime.evaluate", { expression }, this.#sessionId);
    } catch {
      // Page is navigating or the window closed; the message has nowhere to go.
    }
  }
}

/** Finds the app's page target and attaches a flattened CDP session to it. */
async function attachToApp(cdp: CdpConnection): Promise<string> {
  const pageCreated = new Promise<string>((resolve) => {
    const onEvent = (method: string, params: any) => {
      if (method === "Target.targetCreated" && params.targetInfo.type === "page") {
        cdp.off("event", onEvent);
        resolve(params.targetInfo.targetId);
      }
    };
    cdp.on("event", onEvent);
  });
  // Replays targetCreated for targets that already exist, so there's no race.
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const targetId = await pageCreated;
  await cdp.send("Target.setDiscoverTargets", { discover: false });

  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return sessionId;
}
