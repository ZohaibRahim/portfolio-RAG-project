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
 * Number of candidate chunks pulled from Azure AI Search
 * in the first retrieval stage.
 *
 * We deliberately over-fetch here. Azure's hybrid ranking
 * is strong on recall but only moderate on fine-grained
 * relevance ordering, so grabbing a broader pool gives the
 * LLM reranker enough material to promote the truly best
 * chunks even when Azure ranks them mid-list.
 *
 * The rerankService pre-filter typically drops ~5 meta
 * chunks from this pool before the LLM sees them, so 15
 * here corresponds to roughly 10 chunks reaching the LLM.
 *
 * Empirically 15 is the sweet spot: pool sizes of 12 and
 * 10 still passed the regression suite's hard checks, but
 * introduced visible precision loss — most notably the
 * "My Contribution" chunk falling out of the top 5 on the
 * jailbreak F1 question, and unrelated project chunks
 * being padded into Gradified / Roshtay answers.
 */
const CANDIDATE_POOL_SIZE = 15;

/**
 * Number of chunks the reranker keeps as the final
 * grounding context for answer generation.
 *
 * Kept small so the answer model stays focused and so
 * citation labels ([1]..[5]) remain readable in the UI.
 */
const FINAL_TOP_K = 5;

/**
 * Retrieve the most relevant portfolio context
 * for a natural-language question.
 *
 * This service coordinates a two-stage retrieval pipeline:
 *
 * 1. LLM query rewriting
 * 2. semantic embedding generation
 * 3. provider-specific dimension validation
 * 4. Azure AI Search hybrid retrieval (recall-heavy top ~20)
 * 5. LLM reranking (precision-heavy top 5)
 */
export async function retrieveContext(
  question: string,
  topK = FINAL_TOP_K
): Promise<SearchMatch[]> {
  // Remove unnecessary whitespace from the question.
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new Error(
      "Question cannot be empty"
    );
  }

  /**
   * Rewrite the natural-language question into a concise,
   * search-oriented query. The rewrite is generic: no
   * hard-coded project names, employers, or question types.
   *
   * Gated by env.queryRewriteEnabled so we can A/B the
   * pipeline with rewrite on vs off without touching code.
   * When disabled, the trimmed original question is passed
   * straight to the BM25 side of hybrid search.
   *
   * Examples of the rewrite output:
   *
   * "What's Zohaib's current job?"
   * -> "current employment position role"
   *
   * "What was his jailbreak contribution?"
   * -> "LLM jailbreak detection individual contribution"
   */
  const searchQuery = env.queryRewriteEnabled
    ? await rewriteQuery(trimmedQuestion)
    : trimmedQuestion;

  /**
   * Generate the semantic embedding from the
   * complete original question.
   *
   * Embedding the original preserves full context that
   * the rewrite may compress away.
   *
   * During development:
   * Qwen3-Embedding-0.6B -> 1024 dimensions
   *
   * During production:
   * Azure text-embedding-3-small -> 1536 dimensions
   */
  const queryVector =
    await createEmbedding(
      trimmedQuestion
    );

  /**
   * Ask the currently selected embedding provider
   * how many dimensions its vector should contain.
   */
  const expectedDimensions =
    getEmbeddingDimensions();

  /**
   * Protect against accidentally querying an index
   * with vectors from the wrong embedding model.
   */
  if (
    queryVector.length !==
    expectedDimensions
  ) {
    throw new Error(
      `Expected ${expectedDimensions}-dimensional ` +
      `query embedding, received ${queryVector.length}`
    );
  }

  /**
   * Stage 1 — Azure AI Search hybrid retrieval.
   *
   * We over-fetch a broad candidate pool (CANDIDATE_POOL_SIZE)
   * so recall stays high even when Azure's own ranking
   * places the ideal chunk outside the top 5.
   */
  const candidates = await searchHybrid(
    searchQuery,
    queryVector,
    CANDIDATE_POOL_SIZE
  );

  /**
   * Stage 2 — LLM reranking.
   *
   * The reranker reads the full candidate content and
   * reorders it by how directly each chunk answers the
   * original user question. Only the top `topK` chunks
   * survive to become the grounding context.
   */
  return rerank(
    trimmedQuestion,
    candidates,
    topK
  );
}