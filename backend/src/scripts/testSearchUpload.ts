import { env } from "../config/env.js";

console.log("Search endpoint:", env.azureSearchEndpoint);
console.log("Search index:", env.azureSearchIndexName);

import { loadKnowledgeBase } from "../services/knowledgeLoader.js";
import { createEmbedding } from "../services/embeddingService.js";
import {
  getSearchDocument,
  uploadSearchDocument,
} from "../services/searchService.js";

const chunks = loadKnowledgeBase();

const chunk = chunks[0];

if (!chunk) {
  throw new Error("No knowledge chunks were found");
}

console.log("Testing chunk:");
console.log({
  id: chunk.id,
  source: chunk.source,
  section: chunk.section,
});

console.log("\nGenerating embedding...");

const contentVector = await createEmbedding(
  chunk.content
);

console.log(
  `Embedding dimensions: ${contentVector.length}`
);

const document = {
  ...chunk,
  contentVector,
};

console.log("\nUploading to Azure AI Search...");

await uploadSearchDocument(document);

console.log(`Uploaded: ${document.id}`);

console.log("\nReading document back...");

const retrieved = await getSearchDocument(
  document.id
);

console.log({
  id: retrieved.id,
  source: retrieved.source,
  sourceType: retrieved.sourceType,
  section: retrieved.section,
  chunkIndex: retrieved.chunkIndex,
  content: retrieved.content.substring(0, 150),
});