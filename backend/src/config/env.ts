import dotenv from "dotenv";
import path from "path";

// Load the .env file from the repository root.
// Commands are currently run from the /backend directory,
// so ../.env points to portfolio-rag-assistant/.env.
dotenv.config({
  path: path.resolve(process.cwd(), "../.env"),
  quiet: true,
});

// The application currently supports two AI providers.
export type AIProvider = "azure" | "ollama";

/**
 * Read a required environment variable.
 * Throws immediately if the variable is missing.
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is missing`);
  }

  return value;
}

/**
 * Read an optional environment variable.
 *
 * Some Azure OpenAI values may intentionally be empty while
 * developing with Ollama, so we should not fail just because
 * an unused provider's credentials are missing.
 */
function optionalEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * Read and validate the selected AI provider.
 */
function getAIProvider(): AIProvider {
  const provider =
    process.env.AI_PROVIDER?.trim().toLowerCase() ?? "azure";

  if (provider !== "azure" && provider !== "ollama") {
    throw new Error(
      `AI_PROVIDER must be either "azure" or "ollama". Received: ${provider}`
    );
  }

  return provider;
}

const aiProvider = getAIProvider();

// Azure OpenAI values.
//
// These are optional while AI_PROVIDER=ollama.
// We validate them below only when Azure is actually selected.
const azureOpenAIEndpoint = optionalEnv(
  "AZURE_OPENAI_ENDPOINT"
);

const azureOpenAIApiKey = optionalEnv(
  "AZURE_OPENAI_API_KEY"
);

const embeddingDeployment = optionalEnv(
  "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"
);

const chatDeployment = optionalEnv(
  "AZURE_OPENAI_CHAT_DEPLOYMENT"
);

// Ollama values.
//
// These are optional while AI_PROVIDER=azure.
// We validate them below only when Ollama is selected.
const ollamaBaseUrl = optionalEnv(
  "OLLAMA_BASE_URL"
);

const ollamaChatModel = optionalEnv(
  "OLLAMA_CHAT_MODEL"
);

const ollamaEmbeddingModel = optionalEnv(
  "OLLAMA_EMBEDDING_MODEL"
);

// Validate only the provider that is currently active.
if (aiProvider === "azure") {
  if (!azureOpenAIEndpoint) {
    throw new Error(
      "AZURE_OPENAI_ENDPOINT is required when AI_PROVIDER=azure"
    );
  }

  if (!azureOpenAIApiKey) {
    throw new Error(
      "AZURE_OPENAI_API_KEY is required when AI_PROVIDER=azure"
    );
  }

  if (!embeddingDeployment) {
    throw new Error(
      "AZURE_OPENAI_EMBEDDING_DEPLOYMENT is required when AI_PROVIDER=azure"
    );
  }

  if (!chatDeployment) {
    throw new Error(
      "AZURE_OPENAI_CHAT_DEPLOYMENT is required when AI_PROVIDER=azure"
    );
  }
}

if (aiProvider === "ollama") {
  if (!ollamaBaseUrl) {
    throw new Error(
      "OLLAMA_BASE_URL is required when AI_PROVIDER=ollama"
    );
  }

  if (!ollamaEmbeddingModel) {
    throw new Error(
      "OLLAMA_EMBEDDING_MODEL is required when AI_PROVIDER=ollama"
    );
  }

  if (!ollamaChatModel) {
    throw new Error(
      "OLLAMA_CHAT_MODEL is required when AI_PROVIDER=ollama"
    );
  }
}

/**
 * Feature flag for the LLM query-rewrite stage.
 *
 * Defaults to true so historic behavior is preserved when
 * the variable isn't set. Set QUERY_REWRITE_ENABLED=false
 * to bypass the rewrite call and send the trimmed original
 * question straight to Azure Search. Useful for A/B'ing
 * retrieval quality with and without the rewrite step.
 */
const queryRewriteEnabled =
  (process.env.QUERY_REWRITE_ENABLED?.trim().toLowerCase() ??
    "true") !== "false";

export const env = {
  // Determines whether local Ollama or Azure OpenAI is used.
  aiProvider,

  // Azure OpenAI configuration.
  azureOpenAIEndpoint,
  azureOpenAIApiKey,
  embeddingDeployment,
  chatDeployment,

  // Ollama configuration.
  ollamaBaseUrl,
  ollamaChatModel,
  ollamaEmbeddingModel,

  // Azure AI Search is used by both development and production.
  azureSearchEndpoint: requireEnv(
    "AZURE_SEARCH_ENDPOINT"
  ),

  azureSearchApiKey: requireEnv(
    "AZURE_SEARCH_API_KEY"
  ),

  azureSearchIndexName: requireEnv(
    "AZURE_SEARCH_INDEX_NAME"
  ),

  // Feature flags.
  queryRewriteEnabled,

  // Port used by the local Express backend.
  port: Number(process.env.PORT ?? 3000),

  // Frontend origin allowed to call this API.
  allowedOrigin:
    process.env.ALLOWED_ORIGIN ??
    "http://localhost:5173",

};