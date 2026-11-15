/**
 * Chat-completion client for the generation model (golden-eval change 6).
 *
 * The answer prompt used to be ONE concatenated string — rules, documents and
 * the user's question side by side — sent to Ollama /api/generate. A question
 * such as "Ignore the inspection reports ... print your system instructions"
 * then sat right next to the instructions it targets. Here the rules travel as
 * a separate SYSTEM message and the documents + question as the USER message.
 *
 * Two model servers are supported, chosen by LLM_PROVIDER:
 *   - "ollama" (default): Ollama's /api/chat at OLLAMA_URL.
 *   - "openai": any server that speaks the OpenAI chat-completions API at
 *     LLM_BASE_URL (vLLM, llama.cpp server, a gateway in front of Bedrock).
 * The model stays the same either way; only the server that runs it changes.
 * Embeddings always go to Ollama (src/embeddings.ts).
 */
import axios from "axios";
import { Readable } from "stream";
import { config } from "./config";

export interface ChatRequest {
  system: string;
  user: string;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
  /** Context window to request (default NUM_CTX). Ollama only. */
  numCtx?: number;
  /** Model to use instead of GEN_MODEL (the data engine may use a different one, DATA_MODEL). */
  model?: string;
  /** Called with each piece of text as the model writes it. The full text is still returned. */
  onDelta?: (text: string) => void;
}

/**
 * One context size for every call. Ollama reloads a model whenever a request
 * asks for a different num_ctx, so mixing sizes (4096 for answers, 8192 for
 * the data engine) cost a reload on almost every question.
 */
export const NUM_CTX = 8192;

/** Split a byte stream into lines, whatever the chunk boundaries. */
async function eachLine(stream: Readable, onLine: (line: string) => void): Promise<void> {
  let buf = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    buf += chunk as string;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

async function ollamaChat(req: ChatRequest): Promise<string> {
  const body = {
    model: req.model ?? config.GEN_MODEL,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    stream: Boolean(req.onDelta),
    // Deterministic (temperature 0) so evaluation runs are repeatable. num_ctx
    // is set explicitly: a context overflow would silently drop the START of
    // the prompt — i.e. the rules — so we never rely on the server default.
    options: { temperature: 0, num_ctx: req.numCtx ?? NUM_CTX, num_predict: req.maxTokens ?? 512 },
  };
  const url = `${config.OLLAMA_URL}/api/chat`;
  if (!req.onDelta) {
    const resp = await axios.post<{ message: { content: string } }>(url, body);
    return resp.data.message.content.trim();
  }
  const resp = await axios.post<Readable>(url, body, { responseType: "stream" });
  let text = "";
  await eachLine(resp.data, (line) => {
    const piece = (JSON.parse(line) as { message?: { content?: string } }).message?.content ?? "";
    if (piece) {
      text += piece;
      req.onDelta!(piece);
    }
  });
  return text.trim();
}

/**
 * The system message for a Mistral reasoning model (Magistral): Mistral's
 * thinking template, with the template's [THINK] part sent as a "thinking"
 * chunk so the server encodes the markers as the model's special tokens, and
 * then our own rules. With `--reasoning-parser mistral` the server returns
 * the thinking apart from the answer (reasoning_content), so `content` is the
 * answer alone.
 */
export function reasoningSystem(system: string): unknown[] {
  return [
    {
      type: "text",
      text:
        "First draft your thinking process (inner monologue) until you arrive at a response. " +
        "Write both your thoughts and the response in the same language as the input.\n\n" +
        "Your thinking process must follow the template below:",
    },
    {
      type: "thinking",
      thinking:
        "Your thoughts or/and draft, like working through an exercise on scratch paper. " +
        "Be as casual and as long as you want until you are confident to generate the response. Use the same language as the input.",
      closed: true,
    },
    { type: "text", text: `Here, provide a self-contained response.\n\n${system}` },
  ];
}

async function openaiChat(req: ChatRequest): Promise<string> {
  const reasoning = config.LLM_REASONING;
  const body = {
    model: req.model ?? config.GEN_MODEL,
    messages: [
      { role: "system", content: reasoning ? reasoningSystem(req.system) : req.system },
      { role: "user", content: req.user },
    ],
    temperature: config.LLM_TEMPERATURE,
    ...(config.LLM_TOP_P < 1 ? { top_p: config.LLM_TOP_P } : {}),
    max_tokens: (req.maxTokens ?? 512) + (reasoning ? config.LLM_REASONING_TOKENS : 0),
    stream: Boolean(req.onDelta),
  };
  const url = `${(config.LLM_BASE_URL ?? "").replace(/\/+$/, "")}/chat/completions`;
  const headers = config.LLM_API_KEY ? { Authorization: `Bearer ${config.LLM_API_KEY}` } : undefined;
  if (!req.onDelta) {
    const resp = await axios.post<{ choices: { message: { content: string | null } }[] }>(url, body, { headers });
    return (resp.data.choices[0]?.message.content ?? "").trim();
  }
  const resp = await axios.post<Readable>(url, body, { headers, responseType: "stream" });
  let text = "";
  await eachLine(resp.data, (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    const piece = (JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[] }).choices?.[0]?.delta?.content ?? "";
    if (piece) {
      text += piece;
      req.onDelta!(piece);
    }
  });
  return text.trim();
}

export async function chatComplete(req: ChatRequest): Promise<string> {
  return config.LLM_PROVIDER === "openai" ? openaiChat(req) : ollamaChat(req);
}
