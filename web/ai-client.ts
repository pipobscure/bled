import type { AiProgress, ChatMessage } from "./ai.ts";
import { bridge } from "./bridge.ts";

// Talks to the AI proxy in node (src/ai.ts). Prompts and parsing live in ai.ts,
// which has no page dependencies so it can be tested in node.

export interface AiRun {
  done: Promise<string>;
  cancel(): void;
}

const streams = new Map<string, (delta: AiProgress) => void>();
bridge.on<{ id: string } & AiProgress>("ai.delta", ({ id, ...delta }) => streams.get(id)?.(delta));

/** Runs a chat completion through node. `onProgress` receives the accumulated text as it streams. */
export function runChat(messages: ChatMessage[], onProgress: (progress: AiProgress) => void, temperature?: number): AiRun {
  const id = crypto.randomUUID();
  let text = "";
  streams.set(id, (delta) => onProgress({ text: (text += delta.text), reasoning: delta.reasoning }));
  const done = bridge.invoke<string>("ai.chat", { id, messages, temperature }).finally(() => streams.delete(id));
  return { done, cancel: () => void bridge.invoke("ai.cancel", { id }) };
}

