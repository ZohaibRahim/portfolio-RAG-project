import OpenAI from "openai";

import { env } from "../config/env.js";

/**
 * System instructions shared by both Ollama and Azure.
 *
 * The rewriter is intentionally generic: it must not encode
 * any specific portfolio facts, project names, or employers.
 * It only expands and normalizes the user's phrasing into a
 * short keyword-oriented query for hybrid BM25 + vector search.
 */
const REWRITE_INSTRUCTIONS = `
You rewrite a user's portfolio question into a concise search query
optimized for hybrid BM25 + vector retrieval over a portfolio
knowledge base.

Rules:
- Return ONLY the rewritten query. No prefixes like "Query:" or "Search:".
- Do not wrap the output in quotes, backticks, or any other punctuation.
- Do not add any explanation, reasoning, or commentary.
- Keep the query short: a handful of keywords or a short phrase.
- Prefer generic keyword expansion. For example, "current job" becomes
  "current employment position role".
- Do NOT invent facts, project names, employer names, technologies,
  or any details that are not present in the original question.
- Do NOT introduce topic constraints (like "employment", "skills",
  "projects") unless they are already present in the original question.
- If the question is short (roughly six words or fewer) or is a broad
  identity / overview question, return it essentially unchanged.
- If the question is already a good, concise search query, return it
  essentially unchanged.

Examples:
- "Who is Zohaib?" -> "Who is Zohaib"
- "Tell me about Zohaib" -> "Tell me about Zohaib"
- "What's Zohaib's current job?" -> "current employment position role"
- "Tell me about the jailbreak detection project"
    -> "LLM jailbreak detection project"
`.trim();

/**
 * Rewrite a natural-language portfolio question into a concise,
 * search-oriented query using whichever AI provider is currently
 * selected in .env.
 *
 * Development:
 * AI_PROVIDER=ollama
 *
 * Production:
 * AI_PROVIDER=azure
 */
export async function rewriteQuery(
  question: string
): Promise<string> {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new Error("Question cannot be empty");
  }

  // Use local Qwen during development.
  const rawRewrite =
    env.aiProvider === "ollama"
      ? await rewriteWithOllama(trimmedQuestion)
      : await rewriteWithAzure(trimmedQuestion);

  const cleaned = postProcess(rawRewrite);

  // Fallback to the original question if the model returned
  // nothing usable after post-processing.
  if (!cleaned) {
    return trimmedQuestion;
  }

  return cleaned;
}

/**
 * Rewrite the query locally with Ollama.
 *
 * This path does not consume Azure OpenAI tokens.
 */
async function rewriteWithOllama(
  question: string
): Promise<string> {
  // Remove a possible trailing slash to avoid URLs
  // such as http://localhost:11434//api/chat.
  const baseUrl = env.ollamaBaseUrl.replace(
    /\/$/,
    ""
  );

  const response = await fetch(
    `${baseUrl}/api/chat`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        // qwen3:4b-instruct from our .env file.
        model: env.ollamaChatModel,

        // Disable streaming because we only need the
        // final rewritten query as one string.
        stream: false,

        messages: [
          {
            role: "system",
            content: REWRITE_INSTRUCTIONS,
          },
          {
            role: "user",
            content: question,
          },
        ],

        // A low temperature keeps the rewrite deterministic
        // and prevents creative embellishment.
        options: {
          temperature: 0.1,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Ollama rewrite request failed (${response.status}): ${errorText}`
    );
  }

  // Define only the response structure we actually need.
  const data = (await response.json()) as {
    message?: {
      role?: string;
      content?: string;
    };
  };

  return data.message?.content ?? "";
}

/**
 * Rewrite the query with Azure OpenAI.
 *
 * We keep this path ready for the final production deployment.
 */
async function rewriteWithAzure(
  question: string
): Promise<string> {
  // Only create an Azure client if Azure is actually selected.
  const client = new OpenAI({
    apiKey: env.azureOpenAIApiKey,

    baseURL:
      `${env.azureOpenAIEndpoint.replace(
        /\/$/,
        ""
      )}/openai/v1/`,
  });

  const response = await client.responses.create({
    // In Azure, "model" refers to the deployment name.
    model: env.chatDeployment,

    instructions: REWRITE_INSTRUCTIONS,

    input: question,

    // A rewritten query is only a handful of keywords,
    // so we cap generation tightly.
    max_output_tokens: 60,

    // Query rewriting is a constrained keyword-expansion
    // task — no deep reasoning is required. `minimal`
    // avoids paying for reasoning tokens and keeps
    // latency low. Supported by gpt-5-mini.
    reasoning: {
      effort: "minimal",
    },
  });

  return response.output_text;
}

/**
 * Clean up the model's raw output so it can be safely
 * handed to the retrieval layer.
 *
 * Handles common issues:
 * - Surrounding whitespace.
 * - Surrounding quotes or backticks the model may add.
 * - Leading "Query:" or "Search:" prefixes.
 * - Collapsing internal whitespace to single spaces.
 */
function postProcess(raw: string): string {
  let out = raw.trim();

  // Strip a single pair of surrounding quotes or backticks.
  const surroundingPair = /^(['"`])([\s\S]*)\1$/;

  const match = out.match(surroundingPair);

  if (match) {
    out = match[2].trim();
  }

  // Strip a leading "Query:" or "Search:" prefix if present.
  out = out.replace(
    /^(query|search)\s*:\s*/i,
    ""
  );

  // Collapse any internal whitespace into single spaces.
  out = out.replace(/\s+/g, " ").trim();

  return out;
}
