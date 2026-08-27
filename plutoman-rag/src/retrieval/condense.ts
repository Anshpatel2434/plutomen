/**
 * History-aware query rewriting ("condensing").
 *
 * A follow-up question in a chat is usually NOT self-contained: "what about the
 * cables?" only makes sense given the prior turns. Retrieval, however, works
 * best on a standalone query. condenseQuery() rewrites the latest user message
 * into a standalone search query that folds in the entity/context it depends on,
 * using the same self-hosted Ollama generate endpoint (GEN_MODEL) as the answer
 * generator.
 *
 * This step is a retrieval optimization, NOT an answer step: its only output is
 * a search string. On ANY error (Ollama down, timeout, empty output) it FALLS
 * BACK to the original user message unchanged — condensing must never block the
 * chat.
 */
import axios from "axios";
import { config } from "../config";
import { HistoryTurn } from "../conversation";

interface OllamaGenerateResponse {
  response: string;
}

/** How many recent turns to include as context for the rewrite. */
const CONDENSE_CONTEXT_TURNS = 6;

/**
 * Rewrite `userMessage` into a standalone search query using `history`.
 *
 * - If `history` is empty, there is no context to fold in — return userMessage
 *   unchanged (and skip the LLM call entirely).
 * - Otherwise, prompt GEN_MODEL to emit ONLY the rewritten query, then sanitize
 *   and return it. Any failure falls back to the original userMessage.
 */
export async function condenseQuery(
  history: HistoryTurn[],
  userMessage: string
): Promise<string> {
  if (history.length === 0) {
    return userMessage;
  }

  // Only the last few turns matter for resolving pronouns / carried-over topic.
  const recent = history.slice(-CONDENSE_CONTEXT_TURNS);
  const transcript = recent
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  const prompt = [
    "Given the conversation so far and a follow-up question, rewrite the",
    "follow-up into a STANDALONE search query that includes any entity/context",
    "it depends on. Output ONLY the rewritten query, with no preamble or quotes.",
    "",
    "Conversation so far:",
    transcript,
    "",
    `Follow-up question: ${userMessage}`,
    "",
    "Standalone search query:",
  ].join("\n");

  try {
    const resp = await axios.post<OllamaGenerateResponse>(
      `${config.OLLAMA_URL}/api/generate`,
      {
        model: config.GEN_MODEL,
        prompt,
        stream: false,
      }
    );

    const rewritten = resp.data.response.trim();
    // Guard against an empty / whitespace-only rewrite — fall back rather than
    // running retrieval on a blank query.
    return rewritten.length > 0 ? rewritten : userMessage;
  } catch {
    // Never block the chat on a condensing failure.
    return userMessage;
  }
}
