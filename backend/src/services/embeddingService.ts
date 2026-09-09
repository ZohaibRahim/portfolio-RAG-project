import OpenAI from "openai";

import { env } from "../config/env.js";

// The embedding dimensions are different for our two models.
//
// Development:
// qwen3-embedding:0.6b -> 1024 dimensions
//
// Production:
// text-embedding-3-small -> 1536 dimensions
const OLLAMA_EMBEDDING_DIMENSIONS = 1024;
const AZURE_EMBEDDING_DIMENSIONS = 1536;

/**
 * Public embedding function used by the rest of the application.
 *
 * The calling code does not need to know whether the embedding
 * comes from Ollama or Azure OpenAI.
 */
export async function createEmbedding(
  text: string
): Promise<number[]> {
  const trimmedText = text.trim();

  if (!trimmedText) {
    throw new Error(
      "Cannot create an embedding for empty text"
    );
  }

  // During local development, use the free local Qwen model.
  if (env.aiProvider === "ollama") {
    return createOllamaEmbedding(trimmedText);
  }

  // In production, use Azure OpenAI.
  return createAzureEmbedding(trimmedText);
}

/**
 * Returns the expected vector size for the currently
 * selected embedding provider.
 *
 * This is useful during ingestion so we don't hardcode
 * 1536 when Ollama is producing 1024-dimensional vectors.
 */
export function getEmbeddingDimensions(): number {
  if (env.aiProvider === "ollama") {
    return OLLAMA_EMBEDDING_DIMENSIONS;
  }

  return AZURE_EMBEDDING_DIMENSIONS;
}

/**
 * Generate an embedding locally using Ollama.
 */
async function createOllamaEmbedding(
  text: string
): Promise<number[]> {
  // Remove a trailing slash so we don't accidentally create
  // a URL such as http://localhost:11434//api/embed.
  const baseUrl = env.ollamaBaseUrl.replace(
    /\/$/,
    ""
  );

  const response = await fetch(
    `${baseUrl}/api/embed`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model: env.ollamaEmbeddingModel,
        input: text,
      }),
    }
  );

  // Give a useful error if Ollama cannot process the request.
  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Ollama embedding request failed (${response.status}): ${errorText}`
    );
  }

  // Describe only the part of the Ollama response
  // that this service actually needs.
  const data = (await response.json()) as {
    embeddings?: number[][];
  };

  const embedding = data.embeddings?.[0];

  if (!embedding) {
    throw new Error(
      "Ollama returned no embedding"
    );
  }

  // Make sure the local model is producing vectors that match
  // the 1024-dimensional development Search index.
  if (
    embedding.length !==
    OLLAMA_EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Expected ${OLLAMA_EMBEDDING_DIMENSIONS} Ollama embedding dimensions, received ${embedding.length}`
    );
  }

  return embedding;
}

/**
 * Generate an embedding using Azure OpenAI.
 *
 * This path will be used again for the final deployed
 * production version of the portfolio assistant.
 */
async function createAzureEmbedding(
  text: string
): Promise<number[]> {
  // Create the Azure client only when Azure is actually used.
  // This avoids requiring an Azure API key during local
  // Ollama development.
  const client = new OpenAI({
    apiKey: env.azureOpenAIApiKey,

    baseURL:
      `${env.azureOpenAIEndpoint.replace(
        /\/$/,
        ""
      )}/openai/v1/`,
  });

  const response =
    await client.embeddings.create({
      // In Azure, "model" is the deployment name.
      model: env.embeddingDeployment,
      input: text,
    });

  const embedding =
    response.data[0]?.embedding;

  if (!embedding) {
    throw new Error(
      "Azure OpenAI returned no embedding"
    );
  }

  // Protect against accidentally sending a vector with the
  // wrong dimensions to the production Search index.
  if (
    embedding.length !==
    AZURE_EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Expected ${AZURE_EMBEDDING_DIMENSIONS} Azure embedding dimensions, received ${embedding.length}`
    );
  }

  return embedding;
}