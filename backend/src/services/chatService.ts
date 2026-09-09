import OpenAI from "openai";

import { env } from "../config/env.js";

/**
 * System instructions shared by both Ollama and Azure.
 *
 * Keeping one prompt ensures that development and production
 * follow the same grounding and citation rules.
 */
const SYSTEM_INSTRUCTIONS = `
You are a portfolio Q&A assistant for Zohaib Rahim.

Answer the user's question using ONLY the provided portfolio context.

GROUNDING RULES:
- Do not use outside knowledge.
- Do not invent or assume facts.
- Do not exaggerate experience, responsibilities, results, or skills.
- Clearly distinguish individual contributions from team outcomes.
- If the provided context does not contain enough information to answer the question, say:
  "The portfolio does not contain enough information to answer that."

CITATION STYLE:
- Cite supporting context using the citation labels provided, such as [1] or [2].
- Place citations immediately after the specific claim they support.
- Do not place citations on a separate sentence by themselves.
- Do not leave a citation dangling after terminal punctuation such as a period.
- If multiple sources support the same claim, cite them together, for example: [1][2].
- Prefer one or two citations per paragraph rather than attaching citations to every sentence.

FORMATTING:
- Keep answers concise and professional.
- Use short paragraphs, and use bullet lists when enumerating multiple items.
- Broad questions ("who is X", "tell me about X") get concise summaries.
- Specific questions ("what did they do at X") may be somewhat longer when the context supports it.
`.trim();

/**
 * Generate a grounded portfolio answer using whichever
 * AI provider is currently selected in .env.
 *
 * Development:
 * AI_PROVIDER=ollama
 *
 * Production:
 * AI_PROVIDER=azure
 */
export async function generateGroundedAnswer(
  question: string,
  context: string
): Promise<string> {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new Error("Question cannot be empty");
  }

  if (!context.trim()) {
    throw new Error("Portfolio context cannot be empty");
  }

  // Use local Qwen during development.
  if (env.aiProvider === "ollama") {
    return generateOllamaAnswer(
      trimmedQuestion,
      context
    );
  }

  // Use Azure OpenAI for the deployed production version.
  return generateAzureAnswer(
    trimmedQuestion,
    context
  );
}

/**
 * Generate an answer locally with Ollama.
 *
 * This path does not consume Azure OpenAI tokens.
 */
async function generateOllamaAnswer(
  question: string,
  context: string
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

        // Disable streaming for now because our backend
        // currently expects one complete answer.
        stream: false,

        messages: [
          {
            role: "system",
            content: SYSTEM_INSTRUCTIONS,
          },
          {
            role: "user",
            content: buildUserPrompt(
              question,
              context
            ),
          },
        ],

        // A low temperature makes portfolio answers
        // more deterministic and less creative.
        //
        // `num_ctx` is bumped above Ollama's default 4096 so
        // the combined system prompt + up to 5 grounding chunks
        // + generated answer fits without spilling. Qwen 3 4B
        // natively supports 32K, so 8K here is safely within
        // range and matches the reranker's setting.
        options: {
          temperature: 0.2,
          num_ctx: 8192,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Ollama chat request failed (${response.status}): ${errorText}`
    );
  }

  // Define only the response structure we actually need.
  const data = (await response.json()) as {
    message?: {
      role?: string;
      content?: string;
    };
  };

  const answer = data.message?.content?.trim();

  if (!answer) {
    throw new Error(
      "Ollama returned an empty answer"
    );
  }

  return answer;
}

/**
 * Generate an answer with Azure OpenAI.
 *
 * We keep this path ready for the final production deployment.
 */
async function generateAzureAnswer(
  question: string,
  context: string
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

    instructions: SYSTEM_INSTRUCTIONS,

    input: buildUserPrompt(
      question,
      context
    ),

    // Enough for a concise portfolio answer while
    // leaving headroom for reasoning tokens (which
    // also count against this cap on gpt-5-mini).
    max_output_tokens: 1500,

    // A little reasoning helps the model reliably
    // apply the grounding, citation, and formatting
    // rules on multi-chunk contexts without going into
    // an expensive deep-think loop.
    reasoning: {
      effort: "low",
    },
  });

  const answer = response.output_text.trim();

  if (!answer) {
    throw new Error(
      "Azure OpenAI returned an empty answer"
    );
  }

  return answer;
}

/**
 * Build the user-facing portion of the RAG prompt.
 *
 * The retrieved chunks already contain citation labels
 * such as [1], [2], etc.
 */
function buildUserPrompt(
  question: string,
  context: string
): string {
  return `
USER QUESTION:
${question}

PORTFOLIO CONTEXT:
${context}
`.trim();
}