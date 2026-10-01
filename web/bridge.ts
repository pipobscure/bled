// Page side of the node bridge (see src/window.ts).
//   page -> node: window.__nodeBridge(json), installed by CDP Runtime.addBinding.
//   node -> page: "node:message" CustomEvents dispatched via Runtime.evaluate.

const BINDING_NAME = "__nodeBridge";

type NodeMessage =
  | { type: "ready" }
  | { type: "response"; id: number; result?: unknown; error?: string }
  | { type: "event"; name: string; data?: unknown };

const host = window as unknown as Record<string, ((json: string) => void) | undefined>;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const listeners = new Map<string, Set<(data: any) => void>>();
const queue: string[] = [];
let nextId = 1;
// The binding may be installed before or after this script runs. If after,
// node dispatches a "ready" message once it's in place.
let ready = typeof host[BINDING_NAME] === "function";

function post(message: object): void {
  const json = JSON.stringify(message);
  if (ready) host[BINDING_NAME]!(json);
  else queue.push(json);
}

addEventListener("node:message", (event) => {
  const message = (event as CustomEvent<NodeMessage>).detail;
  switch (message.type) {
    case "ready":
      ready = true;
      for (const json of queue.splice(0)) host[BINDING_NAME]!(json);
      break;
    case "response": {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error !== undefined) request.reject(new Error(message.error));
      else request.resolve(message.result);
      break;
    }
    case "event":
      for (const listener of listeners.get(message.name) ?? []) listener(message.data);
      break;
  }
});

export const bridge = {
  /** Calls a handler registered in node with `window.handle(method, ...)`. */
  invoke<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ type: "request", id, method, params });
    });
  },

  /** Fire-and-forget event to node (`window.on("event", ...)`). */
  emit(name: string, data?: unknown): void {
    post({ type: "event", name, data });
  },

  /** Listens for events node sends with `window.send(name, data)`. Returns an unsubscribe function. */
  on<T = unknown>(name: string, listener: (data: T) => void): () => void {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
    return () => listeners.get(name)!.delete(listener);
  },
};
