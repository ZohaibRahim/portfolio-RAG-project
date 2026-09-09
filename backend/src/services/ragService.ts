import { generateGroundedAnswer } from "./chatService.js";
import { validateCitations } from "./citationService.js";
import { retrieveContext } from "./retrievalService.js";

/**
 * Metadata for a source chunk used in the final answer.
 */
export interface RagSource {
  citation: number;
  source: string;
  section: string;
  chunkIndex: number;
}

/**
 * Shape returned by the complete RAG pipeline.
 */
export interface RagAnswer {
  answer: string;
  sources: RagSource[];
}

/**
 * Canonical response returned when the reranker judged
 * every retrieved candidate as "low" relevance.
 *
 * Short-circuiting here avoids sending an empty context
 * to the answer model, saving tokens and guaranteeing a
 * consistent phrasing across every unsupported question.
 */
const INSUFFICIENT_CONTEXT_ANSWER =
  "The portfolio does not contain enough information to answer that.";

/**
 * Run the complete RAG pipeline:
 *
 * question
 *   ↓
 * retrieve relevant chunks
 *   ↓
 * format grounded context
 *   ↓
 * generate answer with Ollama or Azure
 *   ↓
 * return answer + structured sources
 */
export async function answerQuestion(
  question: string
): Promise<RagAnswer> {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new Error("Question cannot be empty");
  }

  // Retrieve the five most relevant portfolio chunks.
  // May return fewer than five — or zero — if the reranker
  // rejected weak or unrelated candidates.
  const matches = await retrieveContext(
    trimmedQuestion,
    5
  );

  /**
   * Short-circuit when the reranker returned no relevant
   * context. Skipping the answer model here:
   *
   * - Saves an unnecessary LLM call (and Azure tokens
   *   in production).
   * - Guarantees the exact phrasing our system prompt
   *   promises for unsupported questions.
   * - Returns an empty sources array so the UI does not
   *   render misleading citation cards.
   */
  if (matches.length === 0) {
    return {
      answer: INSUFFICIENT_CONTEXT_ANSWER,
      sources: [],
    };
  }

  /**
   * Format the retrieved chunks into citation-labelled
   * context that the chat model can reference.
   */
  const context = matches
    .map(
      (match, index) => `
[${index + 1}]
Source: ${match.source}
Section: ${match.section}
Content:
${match.content}
`.trim()
    )
    .join("\n\n---\n\n");

  // Ask the currently selected AI provider to generate
  // a grounded answer using only the retrieved context.
  const rawAnswer = await generateGroundedAnswer(
    trimmedQuestion,
    context
  );

  // Every chunk we sent to the model gets a candidate source
  // record; the citation validation step below prunes this
  // down to the ones the model actually referenced.
  const allSources: RagSource[] = matches.map(
    (match, index) => ({
      citation: index + 1,
      source: match.source,
      section: match.section,
      chunkIndex: match.chunkIndex,
    })
  );

  /**
   * Validate the citations the model produced against the
   * chunks we actually sent it. Two things can go wrong:
   *
   * 1. The model can invent an out-of-range citation such
   *    as `[7]` when only five chunks were supplied. Those
   *    get stripped from the answer text so the UI never
   *    renders a citation with no matching source card.
   *
   * 2. The model may cite only a subset of the chunks we
   *    sent. The RAG contract is that the response's
   *    `sources` array lists only chunks the answer
   *    actually references, so we filter accordingly.
   *
   * All of that logic lives in citationService.ts and
   * is exercised directly by testCitationValidation.ts.
   */
  return validateCitations(rawAnswer, allSources);
}