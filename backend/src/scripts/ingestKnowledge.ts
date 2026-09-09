import { loadKnowledgeBase } from "../services/knowledgeLoader.js";

import {
  createEmbedding,
  getEmbeddingDimensions,
} from "../services/embeddingService.js";

import { uploadSearchDocuments } from "../services/searchService.js";

import { PortfolioSearchDocument } from "../types/PortfolioSearchDocument.js";

import { env } from "../config/env.js";

// Upload documents to Azure AI Search in manageable batches.
const SEARCH_BATCH_SIZE = 20;

// Maximum number of retries if an embedding provider rate-limits us.
const MAX_RETRIES = 6;

/**
 * Pause execution for a specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate an embedding with retry support.
 *
 * Azure may occasionally return HTTP 429 if its rate limit
 * is reached. Ollama normally will not need this, but keeping
 * the retry logic makes the ingestion pipeline provider-independent.
 */
async function createEmbeddingWithRetry(
  text: string,
  chunkId: string
): Promise<number[]> {
  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      return await createEmbedding(text);
    } catch (error) {
      // Attempt to read an HTTP status code from the error.
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error
          ? (error as { status?: number }).status
          : undefined;

      // Only retry rate-limit errors.
      // Other failures should surface immediately.
      if (
        status !== 429 ||
        attempt === MAX_RETRIES
      ) {
        throw error;
      }

      // Exponential backoff:
      // 10s → 20s → 40s → 60s maximum.
      const waitSeconds = Math.min(
        10 * Math.pow(2, attempt - 1),
        60
      );

      console.log(
        `Rate limited on ${chunkId}. ` +
        `Waiting ${waitSeconds}s before retry ` +
        `${attempt + 1}/${MAX_RETRIES}...`
      );

      await sleep(waitSeconds * 1000);
    }
  }

  throw new Error(
    `Unable to generate embedding for ${chunkId}`
  );
}

/**
 * Run the complete knowledge ingestion pipeline.
 */
async function main(): Promise<void> {
  // Load and chunk all six knowledge files.
  const chunks = loadKnowledgeBase();

  // Ask the active provider what vector size it produces.
  //
  // Ollama/Qwen = 1024
  // Azure OpenAI = 1536
  const expectedDimensions =
    getEmbeddingDimensions();

  console.log(
    `AI provider: ${env.aiProvider}`
  );

  console.log(
    `Search index: ${env.azureSearchIndexName}`
  );

  console.log(
    `Expected embedding dimensions: ${expectedDimensions}`
  );

  console.log(
    `Loaded ${chunks.length} knowledge chunks.`
  );

  console.log("\nStarting ingestion...\n");

  let batch: PortfolioSearchDocument[] = [];
  let uploadedCount = 0;

  for (
    let i = 0;
    i < chunks.length;
    i++
  ) {
    const chunk = chunks[i];

    if (!chunk) {
      continue;
    }

    console.log(
      `[${i + 1}/${chunks.length}] ` +
      `Embedding ${chunk.id}`
    );

    // createEmbedding() automatically chooses
    // Ollama or Azure based on AI_PROVIDER.
    const contentVector =
      await createEmbeddingWithRetry(
        chunk.content,
        chunk.id
      );

    // Protect against accidentally uploading a vector
    // that does not match the selected Search index.
    if (
      contentVector.length !== expectedDimensions
    ) {
      throw new Error(
        `${chunk.id} produced ` +
        `${contentVector.length} dimensions ` +
        `instead of ${expectedDimensions}`
      );
    }

    // Convert the normal text chunk into a Search document
    // by attaching its generated vector.
    batch.push({
      ...chunk,
      contentVector,
    });

    // Upload once we have a full batch,
    // or when we reach the final chunk.
    if (
      batch.length === SEARCH_BATCH_SIZE ||
      i === chunks.length - 1
    ) {
      console.log(
        `Uploading batch of ${batch.length} documents...`
      );

      await uploadSearchDocuments(batch);

      uploadedCount += batch.length;

      console.log(
        `Uploaded ${uploadedCount}/${chunks.length}\n`
      );

      // Reset for the next batch.
      batch = [];
    }
  }

  console.log(
    "Knowledge ingestion complete."
  );
}

// Run the script and surface any failure clearly.
main().catch((error) => {
  console.error("\nIngestion failed:");
  console.error(error);

  process.exit(1);
});