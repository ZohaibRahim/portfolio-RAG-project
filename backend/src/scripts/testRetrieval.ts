import { rewriteQuery } from "../services/queryRewriteService.js";
import { retrieveContext } from "../services/retrievalService.js";

/**
 * Questions used to test different retrieval situations.
 *
 * We call retrieveContext() rather than searchHybrid()
 * directly so the full generic retrieval pipeline is
 * exercised end-to-end.
 */
const questions = [
  "Who is Zohaib?",
  "What did Zohaib do at PHSA?",
  "What technologies did Zohaib use for JobTrackr?",
  "Tell me about Zohaib's Roshtay project.",
  "What did Zohaib contribute to the LLM jailbreak detection project?",
  "Does Zohaib have experience with Python?",
  "What is Zohaib's favorite movie?"
];

for (const question of questions) {
  console.log("\n======================================");
  console.log(`QUESTION: ${question}`);

  /**
   * Print the rewritten search query for debugging.
   *
   * retrieveContext() internally performs the same rewrite,
   * but surfacing it here shows how the question is
   * reshaped before hitting Azure AI Search.
   */
  const rewritten = await rewriteQuery(question);

  console.log(`REWRITE:  ${rewritten}`);

  /**
   * Run the real retrieval pipeline.
   *
   * This includes:
   * - LLM query rewriting
   * - local/Azure embedding generation
   * - Azure hybrid search
   */
  const matches =
    await retrieveContext(question, 5);

  for (
    let i = 0;
    i < matches.length;
    i++
  ) {
    const match = matches[i];

    if (!match) {
      continue;
    }

    console.log(
      `${i + 1}. ` +
      `[${match.score.toFixed(5)}] ` +
      `${match.source} | ` +
      `${match.section}`
    );
  }
}
