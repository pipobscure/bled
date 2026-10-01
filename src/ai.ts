import type { SettingsStore } from "./settings.ts";
import type { AppWindow } from "./window.ts";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** How often streamed text is forwarded to the page. */
const FLUSH_INTERVAL = 50;

/**
 * Proxies an OpenAI-compatible chat completions API. The API key stays in node;
 * the page builds prompts and receives streamed text as "ai.delta" events.
 */
export function registerAi(window: AppWindow, settings: SettingsStore): void {
  const running = new Map<string, AbortController>();

  window
    .handle("ai.settings.get", () => {
      const { baseUrl, model, apiKey, extraBody } = settings.get().ai;
      return { baseUrl, model, extraBody, hasKey: apiKey !== "" };
    })
    .handle("ai.settings.set", async ({ baseUrl, model, apiKey, extraBody }) => {
      if (extraBody !== undefined && (typeof extraBody !== "object" || extraBody === null || Array.isArray(extraBody))) {
        throw new Error("Extra parameters must be a JSON object");
      }
      await settings.update(({ ai }) => {
        if (typeof baseUrl === "string") ai.baseUrl = normalizeBaseUrl(baseUrl);
        if (typeof model === "string") ai.model = model.trim();
        if (extraBody !== undefined) ai.extraBody = extraBody;
        // undefined keeps the stored key; "" clears it.
        if (typeof apiKey === "string") ai.apiKey = apiKey.trim();
      });
    })
    .handle("ai.models", async ({ baseUrl, apiKey }) => {
      // Lets the settings dialog test values before saving them.
      const saved = settings.get().ai;
      const response = await request(
        `${normalizeBaseUrl(baseUrl ?? saved.baseUrl)}/models`,
        typeof apiKey === "string" && apiKey ? apiKey : saved.apiKey,
      );
      const body = (await response.json()) as { data?: { id: string }[] };
      return (body.data ?? []).map((model) => model.id).sort();
    })
    .handle("ai.chat", async ({ id, messages, temperature }) => {
      const { baseUrl, apiKey, model, extraBody } = settings.get().ai;
      if (!model) throw new Error("No AI model configured. Open the assistant settings.");
      const controller = new AbortController();
      running.set(id, controller);
      const started = Date.now();
      try {
        const result = await streamChat(
          `${baseUrl}/chat/completions`,
          apiKey,
          {
            model,
            messages: messages as ChatMessage[],
            stream: true,
            ...(temperature !== undefined && { temperature }),
            ...extraBody,
          },
          controller.signal,
          (progress) => void window.send("ai.delta", { id, ...progress }),
        );
        console.log(
          `[ai] ${model}: ${seconds(started)}, ${result.text.length} characters` +
            (result.reasoning ? ` (+${result.reasoning} thinking)` : "") +
            `, finish: ${result.finish ?? "?"}`,
        );
        if (!result.text && result.reasoning) {
          throw new Error(
            result.finish === "length"
              ? `The model spent its whole output budget thinking (${result.reasoning.toLocaleString()} characters) and wrote no answer. Try a smaller selection, a model without reasoning, or lower the reasoning effort under Extra parameters in the AI settings.`
              : "The model only produced reasoning, no answer.",
          );
        }
        return result.text;
      } catch (error) {
        if (controller.signal.aborted) throw new Error("Cancelled");
        console.error(`[ai] ${model}: failed after ${seconds(started)}: ${(error as Error).message}`);
        throw error;
      } finally {
        running.delete(id);
      }
    })
    .handle("ai.cancel", ({ id }) => {
      running.get(id)?.abort();
    });
}

/** Accepts the base URL with or without a trailing `/chat/completions`. */
function normalizeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "");
}

async function request(url: string, apiKey: string, body?: object, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).error?.message ?? message;
    } catch {
      // Not JSON; use the raw text.
    }
    throw new Error(`AI request failed (${response.status}): ${message}`);
  }
  return response;
}

interface StreamResult {
  text: string;
  /** Characters of reasoning ("thinking") the model streamed before or alongside its answer. */
  reasoning: number;
  finish: string | null;
}

/** Progress sent to the page: new answer text, and the running reasoning count. */
interface Progress {
  text: string;
  reasoning: number;
}

/** Streams a chat completion, calling `onProgress` with batched deltas. */
async function streamChat(
  url: string,
  apiKey: string,
  body: object,
  signal: AbortSignal,
  onProgress: (progress: Progress) => void,
): Promise<StreamResult> {
  const response = await request(url, apiKey, body, signal);

  // Some compatible servers ignore `stream` and answer with plain JSON.
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const json = (await response.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
    };
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? "";
    const reasoning = choice?.message?.reasoning_content?.length ?? 0;
    onProgress({ text, reasoning });
    return { text, reasoning, finish: choice?.finish_reason ?? null };
  }

  let text = "";
  let reasoning = 0;
  let finish: string | null = null;
  let pending = "";
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    onProgress({ text: pending, reasoning });
    pending = "";
  };

  let buffer = "";
  for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      const data = line.match(/^data:\s?(.*)$/)?.[1]?.trim();
      if (!data || data === "[DONE]") continue;
      let choice: { delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string };
      try {
        choice = JSON.parse(data).choices?.[0] ?? {};
      } catch {
        continue;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      // Reasoning models stream their thinking separately (field name varies by server).
      const thinking = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (thinking) reasoning += thinking.length;
      const delta = choice.delta?.content;
      if (delta) {
        text += delta;
        pending += delta;
      }
      if (thinking || delta) timer ??= setTimeout(flush, FLUSH_INTERVAL);
    }
  }
  clearTimeout(timer);
  flush();
  return { text, reasoning, finish };
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}
