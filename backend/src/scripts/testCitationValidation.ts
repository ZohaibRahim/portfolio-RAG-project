import { validateCitations } from "../services/citationService.js";

/**
 * Simple unit-style checks for citation sanitization.
 *
 * These tests verify that:
 * - valid citations stay
 * - invalid citations (out of range) are removed
 * - only actually cited sources remain in the result
 * - duplicate citations in the text collapse to a single source
 * - answers with no citations are handled cleanly
 *
 * Every case prints INPUT, EXPECTED, actual ANSWER, and
 * actual SOURCES so failures are visible at a glance.
 */

const mockSources = [
  {
    citation: 1,
    source: "resume",
    section: "PHSA",
    chunkIndex: 1,
  },
  {
    citation: 2,
    source: "resume",
    section: "Python",
    chunkIndex: 2,
  },
];

interface CitationTestCase {
  name: string;
  answer: string;
  expectedAnswer: string;
  expectedCitations: number[];
}

const tests: CitationTestCase[] = [
  {
    name: "keeps valid citations",
    answer: "Zohaib used Python [2].",
    expectedAnswer: "Zohaib used Python [2].",
    expectedCitations: [2],
  },
  {
    name: "removes out-of-range citation",
    answer: "Zohaib used Python [2] and AWS [7].",
    expectedAnswer: "Zohaib used Python [2] and AWS.",
    expectedCitations: [2],
  },
  {
    name: "removes invalid citation before punctuation",
    answer: "Zohaib used AWS [7], Azure [1].",
    expectedAnswer: "Zohaib used AWS, Azure [1].",
    expectedCitations: [1],
  },
  {
    name: "deduplicates returned sources",
    answer:
      "Zohaib used Python [2]. Python was also used elsewhere [2].",
    expectedAnswer:
      "Zohaib used Python [2]. Python was also used elsewhere [2].",
    expectedCitations: [2],
  },
  {
    name: "handles no citations",
    answer:
      "The portfolio does not contain enough information to answer that.",
    expectedAnswer:
      "The portfolio does not contain enough information to answer that.",
    expectedCitations: [],
  },
];

let failures = 0;

for (const test of tests) {
  console.log("\n======================================");
  console.log(`TEST: ${test.name}`);

  const result = validateCitations(
    test.answer,
    mockSources
  );

  const actualCitations = result.sources.map(
    (source) => source.citation
  );

  console.log(`INPUT:    ${test.answer}`);
  console.log(`EXPECTED: ${test.expectedAnswer}`);
  console.log(`ANSWER:   ${result.answer}`);

  console.log(
    `EXPECTED SOURCES: [${test.expectedCitations.join(", ")}]`
  );
  console.log(
    `ACTUAL SOURCES:   [${actualCitations.join(", ")}]`
  );

  const answerOk =
    result.answer === test.expectedAnswer;

  const sourcesOk =
    actualCitations.length ===
      test.expectedCitations.length &&
    actualCitations.every(
      (c, i) => c === test.expectedCitations[i]
    );

  if (answerOk && sourcesOk) {
    console.log("RESULT: PASS");
  } else {
    console.log("RESULT: FAIL");
    failures++;
  }
}

console.log("\n======================================");
console.log(
  `${tests.length - failures}/${tests.length} passed`
);

if (failures > 0) {
  process.exit(1);
}
