import { EventEmitter } from "node:events";

interface Pipes {
  incoming: NodeJS.ReadableStream;
  outgoing: NodeJS.WritableStream;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

/**
 * Minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`.
 * Messages are JSON, terminated by a NUL byte. Events are emitted as
 * `(method, params, sessionId)` on the "event" channel.
 */
export class CdpConnection extends EventEmitter {
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #buffer = "";
  #outgoing: NodeJS.WritableStream;

  constructor({ incoming, outgoing }: Pipes) {
    super();
    this.#outgoing = outgoing;
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => this.#onData(chunk));
    incoming.on("close", () => this.#onClose());
    // Chrome closing the pipe first can surface as EPIPE on write; treat it as a close.
    outgoing.on("error", () => this.#onClose());
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.#nextId++;
    const message = JSON.stringify({ id, method, params, sessionId });
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#outgoing.write(message + "\0");
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let end: number;
    while ((end = this.#buffer.indexOf("\0")) !== -1) {
      const raw = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      this.#dispatch(JSON.parse(raw) as CdpResponse);
    }
  }

  #dispatch(message: CdpResponse): void {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    } else if (message.method) {
      this.emit("event", message.method, message.params, message.sessionId);
    }
  }

  #onClose(): void {
    for (const { reject } of this.#pending.values()) reject(new Error("CDP connection closed"));
    this.#pending.clear();
    this.emit("close");
  }
}
