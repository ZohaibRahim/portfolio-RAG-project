import { retrieveContextWithTelemetry } from "../services/retrievalService.js";
import { SearchMatch } from "../services/searchService.js";

/**
 * Broader retrieval regression suite.
 *
 * Purpose: after retrieval + reranking are considered frozen,
 * this script exercises a wider question set across the shapes
 * the portfolio actually needs to handle (identity, employers,
 * projects, technologies, metrics, attribution, vague queries,
 * misspellings, unsupported questions).
 *
 * Each test declares:
 * - expectSupported: whether we expect the reranker to return
 *   any chunks at all. This catches the two big failure modes:
 *     * a supported question that returns [] (bad — reranker
 *       or search dropped everything)
 *     * an unsupported question that returns anything (bad —
 *       the "not enough info" path won't fire)
 * - expectedContains: optional list of substrings; if any of
 *   them appears in the "source | section" label of at least
 *   one returned chunk, the "correct evidence" check passes.
 *   Left empty when the correct evidence isn't a single obvious
 *   section (e.g. React can appear in many places).
 *
 * Failures are counted separately for the hard invariant
 * (supported/unsupported) and the soft signal (expected
 * evidence present).
 */

interface RegressionCase {
  category: string;
  question: string;
  expectSupported: boolean;
  expectedContains?: string[];

  // Enumeration-only soft checks. Hardcoded project names here
  // are TEST FIXTURES only — the no-hardcoding rule applies to
  // production retrieval logic, not to evaluation.

  // For broad, catalogue-backed enumeration questions where
  // "one catalogue chunk + a few detail chunks" is the
  // intended shape.
  requiresCatalogueInFinal?: boolean;

  // For category-specific enumeration where we do want multiple
  // detail chunks. Not meaningful for broad questions (the
  // catalogue chunk deliberately concentrates enumeration
  // payload into one chunk).
  minDistinctSections?: number;

  // Category-focused enumeration should have at least half its
  // returned chunks contain this substring in the section path
  // (case-insensitive).
  sectionContainsDominant?: string;

  // Coverage check — how many of these known-project
  // substrings appear ANYWHERE in the returned chunks
  // (searched in both source|section labels AND chunk content,
  // since the Projects Catalogue chunk stores project names in
  // its body).
  enumerationExpectAny?: string[];
  enumerationExpectMinMatches?: number;
}

const tests: RegressionCase[] = [
  // -----------------------------------------------------
  // Identity / overview
  // -----------------------------------------------------
  {
    category: "identity",
    question: "Who is Zohaib?",
    expectSupported: true,
    expectedContains: [
      "About Zohaib",
      "Professional Summary",
    ],
  },
  {
    category: "identity",
    question: "Tell me about Zohaib.",
    expectSupported: true,
    expectedContains: [
      "About Zohaib",
      "Professional Summary",
    ],
  },
  {
    category: "identity",
    question: "What is Zohaib's background?",
    expectSupported: true,
    expectedContains: [
      "About Zohaib",
      "Professional Summary",
    ],
  },

  // -----------------------------------------------------
  // Employers / roles
  // -----------------------------------------------------
  {
    category: "employer",
    question: "What did Zohaib do at PHSA?",
    expectSupported: true,
    expectedContains: ["PHSA"],
  },
  {
    category: "employer",
    question:
      "What did Zohaib do at Aga Khan University?",
    expectSupported: true,
    expectedContains: ["Aga Khan", "AKU"],
  },
  {
    category: "employer",
    question: "What is Zohaib's role at Home Depot?",
    expectSupported: true,
    expectedContains: ["Home Depot"],
  },
  {
    category: "employer",
    question:
      "Tell me about Zohaib's work at Pinar's Honey.",
    expectSupported: true,
    expectedContains: ["Pinar"],
  },
  {
    category: "employer",
    question:
      "What did Zohaib do at Jahangir Football Academy?",
    expectSupported: true,
    expectedContains: ["Jahangir"],
  },

  // -----------------------------------------------------
  // Skills
  // -----------------------------------------------------
  {
    category: "skill",
    question: "Does Zohaib know Power BI?",
    expectSupported: true,
    expectedContains: [
      "Power BI",
      "Analytics",
      "Business Intelligence",
    ],
  },
  {
    category: "skill",
    question: "Does Zohaib have SQL experience?",
    expectSupported: true,
  },
  {
    category: "skill",
    question: "Has Zohaib worked with React?",
    expectSupported: true,
  },
  {
    category: "skill",
    question:
      "Does Zohaib have machine learning experience?",
    expectSupported: true,
    expectedContains: [
      "Machine Learning",
      "jailbreak",
      "Fraud",
    ],
  },
  {
    category: "skill",
    question: "Does Zohaib have experience with Python?",
    expectSupported: true,
    expectedContains: [
      "Python",
      "Engineering & Automation",
    ],
  },

  // -----------------------------------------------------
  // Specific projects
  // -----------------------------------------------------
  {
    category: "project",
    question:
      "Tell me about the Credit Card Fraud Detection project.",
    expectSupported: true,
    expectedContains: ["Fraud"],
  },
  {
    category: "project",
    question:
      "What is the Parallelized Sorting Algorithm project?",
    expectSupported: true,
    expectedContains: ["Sorting", "Parallel"],
  },
  {
    category: "project",
    question: "What is JobTrackr?",
    expectSupported: true,
    expectedContains: ["JobTrackr"],
  },
  {
    category: "project",
    question:
      "Tell me about the Gradified pitch deck project.",
    expectSupported: true,
    expectedContains: ["Gradified"],
  },
  {
    category: "project",
    question:
      "What is the Python security log analyzer?",
    expectSupported: true,
    expectedContains: [
      "security-log-analyzer",
      "Security Log",
      "Python Security",
    ],
  },

  // -----------------------------------------------------
  // Metrics / specific numbers
  // -----------------------------------------------------
  {
    category: "metric",
    question:
      "What percentage improvement did Zohaib deliver at PHSA?",
    expectSupported: true,
    expectedContains: ["PHSA"],
  },
  {
    category: "metric",
    question:
      "What F1 score did Zohaib achieve on the jailbreak project?",
    expectSupported: true,
    expectedContains: [
      "jailbreak",
      "My Contribution",
    ],
  },

  // -----------------------------------------------------
  // Individual vs team attribution
  // -----------------------------------------------------
  {
    category: "attribution",
    question:
      "What did Zohaib personally contribute to the LLM jailbreak project?",
    expectSupported: true,
    expectedContains: ["My Contribution"],
  },

  // -----------------------------------------------------
  // Vague / broad phrasing
  // -----------------------------------------------------
  {
    category: "vague",
    question: "What kind of work does Zohaib do?",
    expectSupported: true,
    expectedContains: [
      "About Zohaib",
      "Professional Summary",
    ],
  },
  {
    category: "vague",
    question: "What are Zohaib's strengths?",
    expectSupported: true,
  },

  // -----------------------------------------------------
  // Misspellings
  // -----------------------------------------------------
  {
    category: "misspelling",
    question: "What did Zohaib do at PHAS?",
    expectSupported: true,
    expectedContains: ["PHSA"],
  },
  {
    category: "misspelling",
    question: "Tell me about JobTrakr.",
    expectSupported: true,
    expectedContains: ["JobTrackr"],
  },
  {
    category: "misspelling",
    question: "What is Roshtai?",
    expectSupported: true,
    expectedContains: ["Roshtay"],
  },

  // -----------------------------------------------------
  // Unsupported — reranker should return []
  // -----------------------------------------------------
  {
    category: "unsupported",
    question: "What is Zohaib's favorite movie?",
    expectSupported: false,
  },
  {
    category: "unsupported",
    question: "What is Zohaib's date of birth?",
    expectSupported: false,
  },
  {
    category: "unsupported",
    question: "What is Zohaib's salary?",
    expectSupported: false,
  },
  {
    category: "unsupported",
    question: "What is Zohaib's religion?",
    expectSupported: false,
  },

  // -----------------------------------------------------
  // Enumeration / catalogue-backed
  // Hardcoded project names below are test fixtures only.
  // Production retrieval has no project-name hardcoding —
  // the Projects Catalogue chunk is auto-generated from
  // resume.md's H2/H3 structure at ingestion time.
  // -----------------------------------------------------
  {
    // Broad — catalogue is the whole enumeration payload.
    // No minDistinctSections: one catalogue chunk + a few
    // biographical chunks is the intended shape.
    category: "enumeration",
    question: "What projects has Zohaib done?",
    expectSupported: true,
    requiresCatalogueInFinal: true,
    enumerationExpectAny: [
      "JobTrackr",
      "Roshtay",
      "Credit Card Fraud",
      "Parallelized Sorting",
      "Python Security Log Analyzer",
      "PHSA Stock Inventory",
    ],
    // With content search enabled, all 6 should be findable
    // in the catalogue body when the catalogue is in final.
    enumerationExpectMinMatches: 6,
  },
  {
    // Category-specific — want detail chunks, so keep
    // minDistinctSections.
    category: "enumeration",
    question: "List Zohaib's software projects.",
    expectSupported: true,
    minDistinctSections: 4,
    enumerationExpectAny: [
      "JobTrackr",
      "Gradified",
      "Parallelized Sorting",
      "Python Security Log Analyzer",
    ],
    enumerationExpectMinMatches: 3,
  },
  {
    category: "enumeration",
    question:
      "What data/BI projects has Zohaib worked on?",
    expectSupported: true,
    minDistinctSections: 3,
    sectionContainsDominant: "Analytics",
    enumerationExpectAny: [
      "PHSA Stock Inventory",
      "Canadian Crime Statistics",
      "Stock Market Portfolio",
      "Power BI Resume Dashboard",
    ],
    enumerationExpectMinMatches: 4,
  },
  {
    category: "enumeration",
    question:
      "What machine-learning projects has Zohaib done?",
    expectSupported: true,
    minDistinctSections: 2,
    enumerationExpectAny: [
      "Jailbreak Detection",
      "Credit Card Fraud",
    ],
    enumerationExpectMinMatches: 2,
    // sectionContainsDominant dropped — a 40% Machine Learning
    // dominance with 2/2 known projects surfaced is the
    // intended shape (catalogue + 2 detail + supporting).
  },
  {
    // Broad — catalogue-backed. No minDistinctSections.
    category: "enumeration",
    question:
      "What are some of Zohaib's major projects?",
    expectSupported: true,
    requiresCatalogueInFinal: true,
    enumerationExpectAny: [
      "JobTrackr",
      "Roshtay",
      "Credit Card Fraud",
      "Jailbreak Detection",
      "Parallelized Sorting",
    ],
    enumerationExpectMinMatches: 5,
  },
];

/**
 * Does any returned chunk's "source | section" label contain
 * at least one of the expected substrings (case-insensitive)?
 */
function evidencePresent(
  matches: SearchMatch[],
  expected: string[]
): boolean {
  if (expected.length === 0) {
    return true;
  }

  const lowered = expected.map((term) =>
    term.toLowerCase()
  );

  return matches.some((match) => {
    const label =
      `${match.source} | ${match.section}`.toLowerCase();

    return lowered.some((term) =>
      label.includes(term)
    );
  });
}

/**
 * Count distinct (source, section) pairs — the coarsest
 * breadth signal we can compute for enumeration questions.
 */
function distinctSectionCount(matches: SearchMatch[]): number {
  return new Set(
    matches.map((m) => `${m.source}::${m.section}`)
  ).size;
}

/**
 * Fraction of returned chunks whose section path contains
 * the given substring (case-insensitive). Used for
 * category-focused enumeration questions.
 */
function sectionDominance(
  matches: SearchMatch[],
  needle: string
): number {
  if (matches.length === 0) return 0;

  const lower = needle.toLowerCase();
  const hits = matches.filter((m) =>
    m.section.toLowerCase().includes(lower)
  ).length;

  return hits / matches.length;
}

/**
 * Count how many of the provided project substrings appear
 * anywhere in the returned chunks — searched in both the
 * "source | section" label AND the chunk content
 * (case-insensitive). Distinct substrings only: the same
 * substring found twice counts once.
 *
 * Content is searched because the Projects Catalogue chunk
 * stores every project name in its body, not in its label.
 * A label-only check would under-count coverage on broad
 * catalogue-backed queries.
 */
function countExpectedMentions(
  matches: SearchMatch[],
  expected: string[]
): number {
  const haystacks = matches.map((m) =>
    `${m.source} | ${m.section}\n${m.content}`.toLowerCase()
  );

  let count = 0;
  for (const term of expected) {
    const t = term.toLowerCase();
    if (haystacks.some((h) => h.includes(t))) {
      count++;
    }
  }
  return count;
}

const oldCases = tests.filter((t) => t.category !== "enumeration");
const newCases = tests.filter((t) => t.category === "enumeration");

let oldHardFailures = 0;
let oldSoftFailures = 0;
let newHardFailures = 0;
let newSoftFailures = 0;

let currentCategory = "";

let enumTotalRerankChars = 0;
let enumTotalFinalChars = 0;
let enumTotalKnownFound = 0;
let enumTotalKnownMin = 0;
let enumTotalKnownMax = 0;
let catalogueHitsInEnum = 0;

for (const test of tests) {
  if (test.category !== currentCategory) {
    console.log("\n========================================");
    console.log(test.category.toUpperCase());
    console.log("========================================");
    currentCategory = test.category;
  }

  const { matches, telemetry } =
    await retrieveContextWithTelemetry(test.question);

  const gotSomething = matches.length > 0;
  const hardOk = gotSomething === test.expectSupported;

  const substringOk = test.expectedContains
    ? evidencePresent(matches, test.expectedContains)
    : true;

  const enumNotes: string[] = [];
  let enumOk = true;

  if (test.requiresCatalogueInFinal) {
    const present = matches.some((m) => m.source === "catalogue");
    enumNotes.push(
      `catalogue in final: ${present ? "yes" : "no"} ${present ? "OK" : "MISS"}`
    );
    if (!present) enumOk = false;
  }

  if (test.minDistinctSections !== undefined) {
    const distinct = distinctSectionCount(matches);
    const ok = distinct >= test.minDistinctSections;
    enumNotes.push(
      `distinct sections: ${distinct} (min ${test.minDistinctSections}) ${ok ? "OK" : "MISS"}`
    );
    if (!ok) enumOk = false;
  }

  if (test.sectionContainsDominant) {
    const ratio = sectionDominance(matches, test.sectionContainsDominant);
    const pct = Math.round(ratio * 100);
    const ok = ratio >= 0.5;
    enumNotes.push(
      `"${test.sectionContainsDominant}" dominance: ${pct}% ${ok ? "OK" : "MISS"}`
    );
    if (!ok) enumOk = false;
  }

  if (
    test.enumerationExpectAny &&
    test.enumerationExpectMinMatches !== undefined
  ) {
    const found = countExpectedMentions(matches, test.enumerationExpectAny);
    const total = test.enumerationExpectAny.length;
    const min = test.enumerationExpectMinMatches;
    const ok = found >= min;
    enumNotes.push(
      `known projects mentioned: ${found}/${total} (min ${min}) ${ok ? "OK" : "MISS"}`
    );
    if (!ok) enumOk = false;

    enumTotalKnownFound += found;
    enumTotalKnownMax += total;
    enumTotalKnownMin += min;
  }

  const softOk = substringOk && enumOk;

  const isEnum = test.category === "enumeration";
  if (!hardOk) {
    if (isEnum) newHardFailures++;
    else oldHardFailures++;
  }
  if (!softOk) {
    if (isEnum) newSoftFailures++;
    else oldSoftFailures++;
  }

  const hardTag = hardOk ? "PASS" : "FAIL";
  const softTag = softOk
    ? ""
    : !substringOk
      ? " (soft: no expected evidence)"
      : " (soft: enumeration coverage)";

  console.log(`\n[${hardTag}]${softTag} ${test.question}`);

  if (isEnum) {
    const catalogueHit = matches.some((m) => m.source === "catalogue");
    if (catalogueHit) catalogueHitsInEnum++;

    enumTotalRerankChars += telemetry.approxRerankPromptChars;
    enumTotalFinalChars += telemetry.approxFinalContextChars;

    console.log(
      `  telemetry: pool=${telemetry.poolReturned}/${telemetry.poolRequested} ` +
      `rerank=${telemetry.rerankReturned}/${telemetry.rerankTopN} ` +
      `final=${telemetry.finalCount} ` +
      `catalogueInFinal=${catalogueHit} ` +
      `~rerankPrompt=${telemetry.approxRerankPromptChars} chars ` +
      `~finalContext=${telemetry.approxFinalContextChars} chars`
    );
    for (const note of enumNotes) console.log(`  ${note}`);
  }

  if (matches.length === 0) {
    console.log("  (no chunks — unsupported path)");
    continue;
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m) continue;
    console.log(`  ${i + 1}. ${m.source} | ${m.section}`);
  }
}

console.log("\n========================================");
console.log("SUMMARY");
console.log("========================================");
console.log(`Total tests:              ${tests.length}`);
console.log(`  Existing regression:    ${oldCases.length}`);
console.log(`  Enumeration:            ${newCases.length}`);

console.log("\nExisting regression suite:");
console.log(`  Hard:                   ${oldCases.length - oldHardFailures}/${oldCases.length}`);
console.log(`  Soft failures:          ${oldSoftFailures}`);

console.log("\nEnumeration suite:");
console.log(`  Hard:                   ${newCases.length - newHardFailures}/${newCases.length}`);
console.log(`  Soft failures:          ${newSoftFailures}`);
console.log(
  `  Catalogue in final:     ${catalogueHitsInEnum}/${newCases.length}`
);
console.log(
  `  Known projects found:   ${enumTotalKnownFound}/${enumTotalKnownMax} labels (min target ${enumTotalKnownMin})`
);
console.log(
  `  Rerank prompt total:    ${enumTotalRerankChars} est. chars ` +
  `(~${Math.round(enumTotalRerankChars / 4)} est. tokens)`
);
console.log(
  `  Final context total:    ${enumTotalFinalChars} est. chars ` +
  `(~${Math.round(enumTotalFinalChars / 4)} est. tokens)`
);

// Accurate cost accounting per query, given
// QUERY_REWRITE_ENABLED=false in production:
//   - 1 embedding call (Azure text-embedding-3-small)
//   - 2 GPT/chat calls (rerank + grounded answer, both gpt-5-mini)
console.log(
  `\nPer query: 1 embedding request + 2 GPT calls (rerank + answer)`
);

// Only hard failures on the existing suite fail the run.
// Enumeration failures stay in the evaluation channel.
if (oldHardFailures > 0) {
  process.exit(1);
}
