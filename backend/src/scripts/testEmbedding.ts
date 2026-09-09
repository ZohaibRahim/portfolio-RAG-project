import { env } from "../config/env.js";
import { createEmbedding } from "../services/embeddingService.js";

console.log("Endpoint:", env.azureOpenAIEndpoint);
console.log("Embedding deployment:", env.embeddingDeployment);

const testText =
  "Zohaib built a Power BI stock inventory dashboard at PHSA.";

const embedding = await createEmbedding(testText);

console.log(`Embedding dimensions: ${embedding.length}`);
console.log("First 5 values:");
console.log(embedding.slice(0, 5));