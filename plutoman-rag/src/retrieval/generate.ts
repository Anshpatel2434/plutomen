/**
 * Grounded generation over retrieved chunks using self-hosted Ollama.
 *
 * We build a strict prompt: the model must answer ONLY from the supplied
 * sources and cite them with short markers ([S1], [S2], ...). After generation
 * the markers it used become the citations (only those — see citations.ts) and
 * are rewritten as readable labels, e.g. "[POID-4547081947.pdf p.2]". If the
 * context is insufficient it is told to say so, which limits hallucination for
 * an inspection-QA use case.
 */
import axios from "axios";
import { config } from "../config";
import { RetrievalHit } from "./hybrid";
import { Citation, sourceLabel, marker, renderCitations, citedSources } from "./citations";

// Re-exported for existing importers (conversation.ts, routes).
export type { Citation };
export { sourceLabel };

export interface GenerationResult {
  answer: string;
  /** Only the sources the answer cites (empty if it cites none). */
  citations: Citation[];
}

interface OllamaGenerateResponse {
  response: string;
}

/**
 * A single prior conversation turn (role + content). Kept structurally
 * compatible with conversation.ts's HistoryTurn so the /chat handler can pass
 * getRecentMessages() output straight through.
 */
export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Render the retrieved chunks into a context block where each source carries a
 * short citation marker the model can copy reliably: "[S1] POID-….pdf p.4 |
 * section", then the chunk text.
 */
function buildContext(hits: RetrievalHit[]): string {
  return hits
    .map((h, i) => {
      const where = `${sourceLabel(h.citation)} | ${h.citation.sectionPath ?? "n/a"}`;
      return `[${marker(i)}] ${where}\n${h.content}`;
    })
    .join("\n\n");
}

/** Render recent conversation turns into a plain transcript block. */
function buildHistory(history: HistoryTurn[]): string {
  return history
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");
}

/**
 * Generate a grounded answer. Returns the answer text plus the citation list
 * (the citations of the chunks we actually fed the model).
 *
 * Back-compat: `history` is OPTIONAL. Called as `generateAnswer(query, hits)`
 * (the existing /search path) it behaves exactly as before. The /chat path
 * additionally passes recent conversation `history` for conversational
 * coherence.
 *
 * GROUNDING INVARIANT (do not weaken): the answer must come STRICTLY from the
 * retrieved CONTEXT. Conversation HISTORY is provided ONLY so the model can
 * resolve pronouns / carry the topic across turns — it is NOT a source of facts.
 * The model must never answer from history alone; if the CONTEXT does not
 * support an answer it must say it lacks enough information (never invent).
 */
export async function generateAnswer(
  query: string,
  hits: RetrievalHit[],
  history: HistoryTurn[] = []
): Promise<GenerationResult> {
  if (hits.length === 0) {
    return {
      answer:
        "I could not find any relevant inspection records for that query in the index.",
      citations: [],
    };
  }

  const context = buildContext(hits);

  // Only include the history block when there is prior conversation. When
  // present, the system instruction explicitly scopes it to coherence so it can
  // never become an ungrounded answer source.
  const historyBlock =
    history.length > 0
      ? [
          "CONVERSATION HISTORY (for coherence and pronoun/topic resolution ONLY —",
          "NOT a source of facts; never answer from history alone):",
          buildHistory(history),
          "",
        ]
      : [];

  const prompt = [
    "You are an assistant answering questions about equipment inspection reports.",
    "Answer the QUESTION using ONLY the CONTEXT below. Do not use outside knowledge.",
    "Each source in the CONTEXT starts with a marker such as [S1]. Cite every fact",
    "you state with the marker of the source it comes from, e.g. [S1] or [S1][S3].",
    "Cite only sources you actually used.",
    "If the context does not contain the answer, say you don't have enough information.",
    "The CONVERSATION HISTORY, if any, is only to resolve pronouns and keep the",
    "topic consistent — do NOT treat it as factual evidence for your answer.",
    "",
    ...historyBlock,
    "CONTEXT:",
    context,
    "",
    `QUESTION: ${query}`,
    "",
    "ANSWER:",
  ].join("\n");

  const resp = await axios.post<OllamaGenerateResponse>(
    `${config.OLLAMA_URL}/api/generate`,
    {
      model: config.GEN_MODEL,
      prompt,
      stream: false, // Phase-1: single-shot. Streaming can be added later.
    }
  );

  // Citations = the sources the answer actually cites; markers become labels.
  const { text, cited } = renderCitations(resp.data.response.trim(), hits);
  return { answer: text, citations: citedSources(hits, cited) };
}
