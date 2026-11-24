/**
 * Ollama Cloud through the gateway, native API: POST /api/chat (per the connector's usage_snippet).
 *
 * glm-5.3-flash is a thinking model. `think` defaults to false; turn it on only where reasoning
 * pays for itself (the lawyer's strategy). Thinking text is dropped and never stored or shown.
 */
import { z } from "zod";
import type { Budget } from "./budget.ts";
import { GatewayError, friendlyGatewayMessage, type Gateway } from "./gateway.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: unknown[];
  /** JSON schema for structured output. */
  format?: object;
  think?: boolean;
  options?: { temperature?: number; num_predict?: number };
}

export interface ChatResult {
  content: string;
  tool_calls: ToolCall[];
}

export interface Ollama {
  chat(opts: ChatOptions): Promise<ChatResult>;
  /** Structured output: sends the zod schema as `format` and validates the reply. */
  chatJson<T>(schema: z.ZodType<T>, opts: Omit<ChatOptions, "format" | "tools">): Promise<T>;
}

export class OllamaOutputError extends Error {}

/**
 * Parse a structured reply. glm-5.3-flash sometimes wraps JSON in ```json fences even with
 * `format` set, so strip fences, then fall back to the outermost {...}.
 */
export function parseJsonReply(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidates = [trimmed, fenced?.[1]];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {}
  }
  throw new OllamaOutputError("The model didn't return JSON.");
}

export function createOllama(opts: { gateway: Gateway; budget: Budget; model: string; timeoutMs?: number }): Ollama {
  const chat = async (o: ChatOptions): Promise<ChatResult> => {
    opts.budget.spend("ollama", 1);
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: o.messages,
      stream: false,
      think: o.think ?? false,
    };
    if (o.tools?.length) body.tools = o.tools;
    if (o.format) body.format = o.format;
    if (o.options) body.options = o.options;

    const res = await opts.gateway.gw("ollama", "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
    if (!res.ok) throw new GatewayError("ollama", res.status, friendlyGatewayMessage("Ollama", res.status));
    const data = (await res.json()) as { message?: { content?: string; tool_calls?: ToolCall[]; thinking?: string } };
    return { content: data.message?.content ?? "", tool_calls: data.message?.tool_calls ?? [] };
  };

  return {
    chat,
    async chatJson(schema, o) {
      const res = await chat({ ...o, format: z.toJSONSchema(schema) });
      const raw = parseJsonReply(res.content);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new OllamaOutputError(`The model's JSON didn't match: ${parsed.error.issues[0]?.message}`);
      return parsed.data;
    },
  };
}
