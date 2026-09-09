import { answerQuestion } from "../services/ragService.js";

// Test question chosen because it requires careful
// distinction between team outcomes and individual work.
const question =
  "What did Zohaib contribute to the LLM jailbreak detection project?";

console.log(`Question: ${question}\n`);
console.log("Running RAG pipeline...\n");

// Run the full retrieval + generation pipeline.
const result = await answerQuestion(question);

console.log("ANSWER");
console.log("======");
console.log(result.answer);

console.log("\nSOURCES");
console.log("=======");

// Print structured source metadata separately.
for (const source of result.sources) {
  console.log(
    `[${source.citation}] ` +
    `${source.source} | ` +
    `${source.section} | ` +
    `chunk ${source.chunkIndex}`
  );
}