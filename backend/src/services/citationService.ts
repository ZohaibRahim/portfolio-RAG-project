/**
 * Minimum shape a source must have to participate in
 * citation validation.
 *
 * We keep this generic so any object with a `citation`
 * number (RagSource, test fixtures, future citation
 * types) can flow through without extra ceremony.
 */
export interface CitableSource {
  citation: number;
}

/**
 * Result of validating an answer's citations against
 * the sources actually supplied to the answer model.
 */
export interface CitationValidationResult<T extends CitableSource> {
  answer: string;
  sources: T[];
}

/**
 * Regex used to find `[N]`-style citation labels in the
 * model's answer.
 *
 * The leading `\s*` capture lets us also consume whatever
 * whitespace precedes an invalid citation, so removing
 * "[7]" from "detected [7] then reported" leaves
 * "detected then reported" with clean single spacing.
 */
export const CITATION_PATTERN = /(\s*)\[(\d+)\]/g;

/**
 * Enforce two citation invariants on the raw model output
 * and its candidate source list:
 *
 * 1. Strip any citation whose number falls outside the
 *    range we actually sent to the model. Example: the
 *    model wrote "[7]" but only five chunks were supplied.
 *    Leaving these in would render a dead reference in
 *    the UI, so we remove them (and their leading
 *    whitespace) from the answer text.
 *
 * 2. Filter the sources array so it contains only chunks
 *    whose citation number survived in the sanitized text.
 *    The public RAG contract is: `sources` lists exactly
 *    what the answer references — no more, no less.
 *
 * Generic on T so any source shape with a `citation`
 * field (RagSource, test fixtures, etc.) can be passed
 * through without losing its extra fields.
 */
export function validateCitations<T extends CitableSource>(
  rawAnswer: string,
  allSources: T[]
): CitationValidationResult<T> {
  const maxCitation = allSources.length;

  // Pass 1: strip any citation whose number falls outside
  // the range we sent to the model.
  const sanitizedAnswer = rawAnswer.replace(
    CITATION_PATTERN,
    (match, _leadingWhitespace, numberString: string) => {
      const citationNumber = Number(numberString);

      const isValid =
        Number.isInteger(citationNumber) &&
        citationNumber >= 1 &&
        citationNumber <= maxCitation;

      // Keep the original match (including leading whitespace)
      // when the citation is valid; drop everything (whitespace
      // included) otherwise so the sentence reads cleanly.
      return isValid ? match : "";
    }
  );

  // Pass 2: collect the citation numbers that survived so
  // we can filter the sources array to only what was cited.
  const citedNumbers = new Set<number>();

  for (const match of sanitizedAnswer.matchAll(
    CITATION_PATTERN
  )) {
    citedNumbers.add(Number(match[2]));
  }

  const citedSources = allSources.filter(
    (source) => citedNumbers.has(source.citation)
  );

  return {
    answer: sanitizedAnswer,
    sources: citedSources,
  };
}
