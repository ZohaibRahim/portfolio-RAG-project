import { env } from "../config/env.js";

import {
  createEmbedding,
  getEmbeddingDimensions,
} from "./embeddingService.js";

import { rewriteQuery } from "./queryRewriteService.js";
import { rerank } from "./rerankService.js";

import {
  searchHybrid,
  SearchMatch,
} from "./searchService.js";

/**
 * Candidate pool size for the recall stage of retrieval.
 * See docs/design-decisions.md for the sweep (20 / 15 / 12 / 10)
 * that landed on 15.
 */
const CANDIDATE_POOL_SIZE = 15;

/**
 * Number of chunks the reranker keeps as the final grounding
 * context for answer generation. Small so the answer stays
 * focused and citations [1]..[5] remain readable in the UI.
 */
const FINAL_TOP_K = 5;

/**
 * Approximate per-chunk overhead added by the surrounding
 * label block ("[N]\nSource: ...\nSection: ...\nContent:\n").
 * Used only by the telemetry estimate below.
 */
const CONTEXT_LABEL_OVERHEAD_CHARS = 40;

/**
 * Approximate per-candidate character cost of the rerank
 * prompt after RERANK_MAX_WORDS truncation (~150 words +
 * label overhead). Used only by the telemetry estimate.
 */
const RERANK_PROMPT_CHARS_PER_CANDIDATE = 1000;

/**
 * Retrieval telemetry emitted by retrieveContextWithTelemetry.
 * Intended for the regression harness; production callers use
 * retrieveContext() and do not pay any telemetry cost.
 */
export interface RetrievalTelemetry {
  poolRequested: number;
  poolReturned: number;
  rerankTopN: number;
  rerankReturned: number;
  finalCount: number;
  approxRerankPromptChars: number;
  approxFinalContextChars: number;
}

/**
 * Retrieve the most relevant portfolio context for a
 * natural-language question.
 *
 * Pipeline:
 *   1. optional LLM query rewrite (env-gated, default off)
 *   2. embed the original question
 *   3. Azure AI Search hybrid retrieval, top 15
 *   4. LLM reranker prunes to `topK` (default 5)
 *
 * The Projects Catalogue chunk is a normal document in the
 * index (source=catalogue, sourceType=catalogue). It surfaces
 * on its own retrieval merits for broad enumeration questions.
 * No question-shape detection or intent-driven widening — the
 * catalogue carries the enumeration payload as a single chunk.
 */
export async function retrieveContext(
  question: string,
  topK = FINAL_TOP_K
): Promise<SearchMatch[]> {
  const result = await retrieveContextCore(question, topK);
  return result.matches;
}

/**
 * Same pipeline as retrieveContext, but also returns the
 * telemetry struct. Intended for the regression harness so
 * we can report pool sizes, rerank counts, and approximate
 * context size per test case. Production callers should
 * use retrieveContext() instead.
 */
export async function retrieveContextWithTelemetry(
  question: string,
  topK = FINAL_TOP_K
): Promise<{ matches: SearchMatch[]; telemetry: RetrievalTelemetry }> {
  return retrieveContextCore(question, topK);
}

/**
 * Shared implementation. Always computes telemetry — the
 * struct is trivially small so this costs nothing on the
 * production hot path.
 */
async function retrieveContextCore(
  question: string,
  topK: number
): Promise<{ matches: SearchMatch[]; telemetry: RetrievalTelemetry }> {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new Error("Question cannot be empty");
  }

  /**
   * Optional LLM query rewrite. Gated by env.queryRewriteEnabled
   * (currently false by default — see docs/design-decisions.md).
   */
  const searchQuery = env.queryRewriteEnabled
    ? await rewriteQuery(trimmedQuestion)
    : trimmedQuestion;

  /**
   * Embed the full original question, not the rewrite —
   * this preserves context the rewrite may have compressed.
   */
  const queryVector = await createEmbedding(trimmedQuestion);
  const expectedDimensions = getEmbeddingDimensions();

  if (queryVector.length !== expectedDimensions) {
    throw new Error(
      `Expected ${expectedDimensions}-dimensional ` +
      `query embedding, received ${queryVector.length}`
    );
  }

  // Stage 1 — Azure AI Search hybrid retrieval.
  const candidates = await searchHybrid(
    searchQuery,
    queryVector,
    CANDIDATE_POOL_SIZE
  );

  // Stage 2 — LLM reranking to the requested topK.
  const ranked = await rerank(
    trimmedQuestion,
    candidates,
    topK
  );

  const approxFinalContextChars = ranked.reduce(
    (sum, match) => sum + match.content.length + CONTEXT_LABEL_OVERHEAD_CHARS,
    0
  );

  const telemetry: RetrievalTelemetry = {
    poolRequested: CANDIDATE_POOL_SIZE,
    poolReturned: candidates.length,
    rerankTopN: topK,
    rerankReturned: ranked.length,
    finalCount: ranked.length,
    approxRerankPromptChars:
      candidates.length * RERANK_PROMPT_CHARS_PER_CANDIDATE,
    approxFinalContextChars,
  };

  return { matches: ranked, telemetry };
}
