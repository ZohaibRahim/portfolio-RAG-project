import OpenAI from "openai";

import { env } from "../config/env.js";
import { SearchMatch } from "./searchService.js";

/**
 * System instructions shared by both Ollama and Azure.
 *
 * Rather than asking the model to tier every single candidate
 * exhaustively (which small local models like Qwen 4B routinely
 * truncate), we ask for a simpler contract: return the ranked
 * list of candidate numbers that ACTUALLY answer the question.
 *
 * Anything omitted is treated as "not relevant" and dropped.
 * If nothing is relevant, the model returns [] and the caller
 * short-circuits to a "not enough information" response.
 */
const RERANK_INSTRUCTIONS = `
You are a reranker for a portfolio retrieval system.

You will be shown a user's question and a numbered list of
candidate text chunks retrieved from a portfolio knowledge base.

Return a JSON array of the candidate numbers that answer the
user's question OR provide substantive direct information about
what the question is asking about, ordered from most relevant
to least relevant.

RELEVANCE RULES:
- Prefer chunks that directly answer the user's question.
- Also include chunks that provide useful supporting context for
  a complete answer.
- Prefer specific factual evidence over generic summaries when
  both are available.
- Prefer dedicated content about the requested employer, project,
  skill, role, or topic.
- For a broad "tell me about X", "who is X", or "what is X"
  question, include multiple chunks that together give a fuller
  picture rather than picking only one narrow answer.
- For a specific question ("what did they do at X", "what is
  their contribution to Y"), stay tight and only include chunks
  that speak to that specific point.

- Do NOT include README-style or site-maintenance metadata unless
  the user is explicitly asking about the website or repository
  itself. Examples of normally irrelevant metadata include:
    - License
    - Contact
    - Contents
    - Project structure
    - Asset/build scripts
    - Installation instructions
    - Generic project lists
    - Development workflow metadata
- Do NOT include a chunk merely because it contains "Zohaib",
  a project name, or another query term.
- Do NOT include unrelated team/member information unless the
  question concerns that team or attribution.
- Treat obvious minor spelling variations or typographical errors as
  referring to the matching entity when the surrounding evidence makes
  the intended referent clear.
- If no candidate meaningfully helps answer the question, return
  an empty array: []

OUTPUT RULES:
- Do not use outside knowledge.
- Format: [3, 7, 1]
- No explanation, no prose, no markdown code fences.
`.trim();

/**
 * Section names (matched against SearchMatch.section) that are
 * README / site-maintenance metadata rather than portfolio content.
 *
 * Small LLMs like Qwen 4B follow the prompt's meta-exclusion rule
 * inconsistently — Roshtay ran clean but "Who is Zohaib?" and
 * PHSA still slip in License / Contact / Design decisions chunks.
 *
 * This regex list is applied deterministically BEFORE the LLM
 * even sees the pool. Dropping meta chunks up front means we
 * spend fewer reranker tokens judging content we would filter
 * out anyway, and the LLM cannot pick a meta chunk it never
 * saw. The pre-filter is skipped entirely when the question
 * itself is about the portfolio site/repo (see
 * META_QUESTION_ESCAPE_WORDS below).
 */
const META_SECTION_BLOCKLIST: readonly RegExp[] = [
  /^License$/i,
  /^Contact$/i,
  /^Contents$/i,
  /^Project structure$/i,
  /^Getting started$/i,
  /^Design decisions$/i,
  /^Design system\b/i,
  /^Performance$/i,
  /^Accessibility$/i,
  /^Asset pipeline\b/i,
  /^Deploy\b/i,
  /^serve locally\b/i,
  /^install\s/i,
  /^or watch\b/i,
  /^Content model\b/i,
];

/**
 * Words that, if present in the user's question, disable the
 * meta-section blocklist entirely.
 *
 * When someone genuinely asks about the portfolio site or the
 * repository itself, License / Contact / Deploy / Design system
 * sections are legitimate answers rather than noise.
 */
const META_QUESTION_ESCAPE_WORDS: readonly string[] = [
  "portfolio site",
  "portfolio website",
  "website",
  "repository",
  "repo",
  "readme",
  "codebase",
  "source code",
];

/**
 * Does the question explicitly concern the portfolio site or
 * repository itself, rather than Zohaib's work?
 *
 * We match on lowercased whole-string containment. The two-word
 * "portfolio site" / "portfolio website" phrases are checked
 * explicitly because bare "portfolio" alone is too broad — the
 * word appears in normal work questions like "what's in his
 * portfolio of projects".
 */
function isMetaQuestion(question: string): boolean {
  const lower = question.toLowerCase();

  return META_QUESTION_ESCAPE_WORDS.some(
    (phrase) => lower.includes(phrase)
  );
}

/**
 * Is this section one of the README / site-maintenance chunks
 * that should be dropped from non-meta answers?
 */
function isMetaSection(section: string): boolean {
  return META_SECTION_BLOCKLIST.some(
    (pattern) => pattern.test(section)
  );
}

/**
 * Maximum number of words per candidate shown to the reranker.
 *
 * The reranker only needs enough text to judge relevance — a
 * section heading plus the opening paragraph is almost always
 * sufficient. Truncating here cuts the biggest LLM prompt in
 * the pipeline substantially while the FULL chunk text still
 * flows through to the answer generator via the returned
 * SearchMatch objects.
 */
const RERANK_MAX_WORDS = 150;

/**
 * Truncate a chunk's body to at most RERANK_MAX_WORDS words
 * for the rerank prompt. Adds a trailing ellipsis when
 * truncation actually happened so the LLM sees that more
 * content exists beyond what was shown.
 */
function truncateForRerank(content: string): string {
  const words = content.split(/\s+/);

  if (words.length <= RERANK_MAX_WORDS) {
    return content;
  }

  return `${words.slice(0, RERANK_MAX_WORDS).join(" ")} ...`;
}

/**
 * Rerank a candidate pool using an LLM and keep the top N.
 *
 * The rest of the application only sees the reranked context,
 * which lets us fetch a broad candidate pool (recall-heavy)
 * from Azure AI Search and then let a language model do the
 * fine-grained relevance judgement.
 *
 * Pipeline order inside this function:
 * 1. Deterministically pre-filter meta / site-maintenance
 *    chunks from the candidate pool (skipped for meta questions).
 * 2. Ask the LLM to select the truly relevant remaining chunks.
 * 3. Slice to the requested topN.
 *
 * Behaviour:
 * - Empty candidates (or pre-filter removed everything) -> [].
 * - topN >= filtered.length -> LLM is skipped entirely because
 *   there is nothing to prune; the pre-filtered order is kept.
 * - Otherwise: the LLM selects which candidates are relevant.
 *   Selected candidates survive in the model's ranked order;
 *   anything the model omitted is treated as "not relevant"
 *   and dropped.
 * - If the model selects nothing -> returns [] so the RAG
 *   service can respond with "not enough information".
 * - If the LLM call or parse fails -> falls back to the
 *   pre-filtered pool's own order truncated to topN, so the
 *   retrieval pipeline never crashes the whole request. This
 *   intentionally differs from "model selected nothing": an
 *   infrastructure failure must not silently look like an
 *   unsupported question.
 */
export async function rerank(
  question: string,
  candidates: SearchMatch[],
  topN: number
): Promise<SearchMatch[]> {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new Error("Question cannot be empty");
  }

  // Nothing to rerank.
  if (candidates.length === 0) {
    return [];
  }

  /**
   * Deterministic meta-section pre-filter.
   *
   * Unless the user is explicitly asking about the portfolio
   * site or repository, drop every candidate whose section
   * matches the README / site-maintenance blocklist BEFORE we
   * spend LLM tokens on it. The LLM cannot pick something it
   * never saw, which makes the filter both cheaper (fewer
   * reranker tokens) and stricter (no model-variance slippage).
   */
  const questionIsAboutSite = isMetaQuestion(trimmedQuestion);

  const filteredCandidates = questionIsAboutSite
    ? candidates
    : candidates.filter(
        (candidate) => !isMetaSection(candidate.section)
      );

  // Every candidate was meta noise.
  if (filteredCandidates.length === 0) {
    return [];
  }

  // No pruning needed — an LLM call would be wasted.
  // Every candidate is kept in its pre-filtered order.
  if (topN >= filteredCandidates.length) {
    return filteredCandidates;
  }

  // Build the numbered candidate block once and reuse it
  // for whichever provider is currently selected.
  const userPrompt = buildRerankPrompt(
    trimmedQuestion,
    filteredCandidates
  );

  try {
    const rawResponse =
      env.aiProvider === "ollama"
        ? await rerankWithOllama(userPrompt)
        : await rerankWithAzure(userPrompt);

    // Convert the raw model output into a validated
    // list of 1-based candidate positions the model
    // considers relevant, in ranked order.
    const selected = parseSelection(
      rawResponse,
      filteredCandidates.length
    );

    // Return the model's selection, truncated to topN.
    // If the model selected nothing, this is [] — which
    // signals "no relevant context" to the RAG layer.
    return selected
      .slice(0, topN)
      .map((position) => filteredCandidates[position - 1]!);
  } catch (error) {
    // The retrieval pipeline must not crash when the
    // reranker fails. Fall back to the pool's own order.
    // We intentionally do NOT return [] here: an infra
    // failure should not look identical to "no relevant
    // context" — that path is reserved for a successful
    // reranker call that selected nothing.
    console.warn(
      `Rerank failed, falling back to first ${topN} candidates:`,
      error
    );

    return filteredCandidates.slice(0, topN);
  }
}

/**
 * Format the question + candidate chunks into the
 * user-facing portion of the rerank prompt.
 *
 * Candidates are numbered starting at 1 because language
 * models are noticeably more reliable with 1-based lists
 * than with 0-based ones.
 *
 * Each chunk body is truncated to RERANK_MAX_WORDS words in
 * this prompt only. The full chunk text still flows to the
 * answer generator via the SearchMatch objects that survive
 * the reranker.
 */
function buildRerankPrompt(
  question: string,
  candidates: SearchMatch[]
): string {
  const candidateBlock = candidates
    .map((match, index) => {
      return `
[${index + 1}]
Source: ${match.source}
Section: ${match.section}
Content:
${truncateForRerank(match.content)}
`.trim();
    })
    .join("\n\n---\n\n");

  return `
QUESTION:
${question}

CANDIDATES:
${candidateBlock}
`.trim();
}

/**
 * Rerank locally with Ollama.
 *
 * We ask Ollama for JSON-formatted output so a small
 * local model is less likely to wrap the ranking in
 * prose or markdown fences. The exact shape is still
 * validated by parseSelection() below.
 */
async function rerankWithOllama(
  userPrompt: string
): Promise<string> {
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
        model: env.ollamaChatModel,

        stream: false,

        // Force Ollama to constrain generation to valid JSON.
        // Ollama's `format: "json"` guarantees parseable JSON
        // but not any particular shape.
        format: "json",

        messages: [
          {
            role: "system",
            content: RERANK_INSTRUCTIONS,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],

        // Reranking is a judgement task, so keep temperature
        // low to reduce noisy reorderings between runs.
        //
        // `num_ctx` is bumped above Ollama's default 4096 so the
        // combined system prompt + 20 candidate chunks + JSON
        // response comfortably fits in the model's working
        // memory. Qwen 3 4B natively supports 32K, so 8K is
        // well within safe territory and only adds a modest
        // RAM overhead on the local machine.
        options: {
          temperature: 0.1,
          num_ctx: 8192,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Ollama rerank request failed (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as {
    message?: {
      role?: string;
      content?: string;
    };
  };

  return data.message?.content ?? "";
}

/**
 * Rerank with Azure OpenAI.
 *
 * We keep the same instructions/prompt pair as Ollama so
 * the development and production behaviours stay comparable.
 */
async function rerankWithAzure(
  userPrompt: string
): Promise<string> {
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

    instructions: RERANK_INSTRUCTIONS,

    input: userPrompt,

    // Reasoning tokens at `effort: low` share this budget
    // with the visible JSON output. 200 was fine at `minimal`
    // but was truncating the JSON array mid-write once we
    // moved to `low`, causing frequent parse failures and
    // fallback to the raw pool order. 800 leaves plenty of
    // headroom for both reasoning and a short array of at
    // most ~15 numbers.
    max_output_tokens: 800,

    // Reranking is mostly a constrained selection task, but
    // "minimal" reasoning empirically fails on typo-carrying
    // questions (e.g. "Roshtai" vs Roshtay): the model reads
    // the strings literally and returns [] even when the pool
    // contains correct-spelling candidates. `low` gives just
    // enough reasoning headroom to apply the typo-tolerance
    // instruction reliably without triggering expensive
    // deep-think loops.
    reasoning: {
      effort: "low",
    },
  });

  return response.output_text;
}

/**
 * Convert the model's raw JSON output into a validated,
 * ranked list of 1-based candidate positions.
 *
 * We defensively handle:
 * - Bare arrays: [3, 7, 1]
 * - Wrapped objects: {"ranking": [3, 7, 1]}, {"selected": [...]}
 * - Object entries: [{"i": 3}, {"index": 7}] — position is extracted
 * - Duplicates: the first occurrence wins.
 * - Out-of-range or non-integer entries: silently ignored.
 * - An empty result: returned as-is so the caller can signal
 *   "not enough information" instead of surfacing junk.
 */
function parseSelection(
  raw: string,
  candidateCount: number
): number[] {
  // Strip markdown code fences and surrounding whitespace,
  // in case the model ignored the "no markdown" instruction.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!cleaned) {
    throw new Error("Reranker returned empty output");
  }

  // The model must return valid JSON. If it does not, treat
  // this as a reranker failure and let the caller fall back.
  const parsed: unknown = JSON.parse(cleaned);

  // Accept either a bare array or a common wrapper object.
  const rawEntries = extractEntriesArray(parsed);

  if (!rawEntries) {
    throw new Error(
      "Reranker output did not contain a positions array"
    );
  }

  const seen = new Set<number>();
  const selected: number[] = [];

  for (const value of rawEntries) {
    const position = extractPosition(value);

    if (position === null) {
      continue;
    }

    // Ignore out-of-range positions.
    if (
      position < 1 ||
      position > candidateCount
    ) {
      continue;
    }

    // Keep only the first occurrence of a duplicate.
    if (seen.has(position)) {
      continue;
    }

    seen.add(position);
    selected.push(position);
  }

  return selected;
}

/**
 * Pull an entries array out of the parsed JSON.
 *
 * Handles either a bare array response or the common
 * "{ranking: [...]}" / "{selected: [...]}" style wrappers
 * that some models produce even when told not to.
 */
function extractEntriesArray(
  parsed: unknown
): unknown[] | null {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (
    typeof parsed === "object" &&
    parsed !== null
  ) {
    for (const key of [
      "ranking",
      "selected",
      "relevant",
      "order",
      "positions",
      "indices",
      "ranked",
      "results",
    ]) {
      const value = (
        parsed as Record<string, unknown>
      )[key];

      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return null;
}

/**
 * Extract a 1-based candidate position from one raw entry.
 *
 * Accepts either a bare number (the primary contract) or
 * an object with an "i" / "index" / "id" / "position" field,
 * because small models occasionally drift toward object form
 * even when told to return bare numbers.
 *
 * Returns null if no integer position can be found.
 */
function extractPosition(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  if (
    typeof value !== "object" ||
    value === null
  ) {
    return null;
  }

  const obj = value as Record<string, unknown>;

  const rawPosition =
    obj["i"] ??
    obj["index"] ??
    obj["id"] ??
    obj["position"];

  const position = Number(rawPosition);

  return Number.isInteger(position) ? position : null;
}
