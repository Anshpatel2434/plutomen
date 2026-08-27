/**
 * Embedding client for self-hosted Ollama.
 *
 * nomic-embed-text is trained with TASK PREFIXES: documents must be prefixed
 * with "search_document: " and queries with "search_query: ". Skipping these
 * measurably degrades retrieval quality, so we apply them here centrally.
 */
import axios from "axios";
import { config } from "./config";

/** Provenance constants stamped onto every chunk row (see chunks.embed_*). */
export const EMBED_MODEL = config.EMBED_MODEL;
export const EMBED_VERSION = config.EMBED_VERSION;

type EmbedKind = "document" | "query";

const PREFIX: Record<EmbedKind, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

interface OllamaEmbeddingResponse {
  embedding: number[];
}

/**
 * Embed a batch of texts. Ollama's /api/embeddings takes one prompt per call,
 * so we issue calls in parallel-bounded batches. Returns vectors aligned to the
 * input order.
 */
export async function embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
  if (texts.length === 0) return [];

  const prefix = PREFIX[kind];
  const url = `${config.OLLAMA_URL}/api/embeddings`;

  // Bound concurrency so a large ingest batch does not overwhelm Ollama.
  const CONCURRENCY = 8;
  const out: number[][] = new Array(texts.length);

  for (let start = 0; start < texts.length; start += CONCURRENCY) {
    const slice = texts.slice(start, start + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (text) => {
        const resp = await axios.post<OllamaEmbeddingResponse>(url, {
          model: config.EMBED_MODEL,
          prompt: prefix + text,
        });
        return resp.data.embedding;
      })
    );
    results.forEach((vec, i) => {
      out[start + i] = vec;
    });
  }

  return out;
}

/**
 * Format a JS number[] as a pgvector literal string: "[0.1,0.2,...]".
 * We pass this as a normal bound parameter and cast it with `::vector` in SQL,
 * which keeps queries parameterized (no string interpolation into SQL text).
 */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
