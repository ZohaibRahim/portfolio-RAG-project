import { retrieveContext } from "../services/retrievalService.js";
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

let hardFailures = 0;
let softFailures = 0;
let currentCategory = "";

for (const test of tests) {
  // Print a category banner the first time we hit a new group.
  if (test.category !== currentCategory) {
    console.log("\n========================================");
    console.log(test.category.toUpperCase());
    console.log("========================================");
    currentCategory = test.category;
  }

  const matches = await retrieveContext(
    test.question,
    5
  );

  const gotSomething = matches.length > 0;

  const hardOk =
    gotSomething === test.expectSupported;

  const softOk = test.expectedContains
    ? evidencePresent(
        matches,
        test.expectedContains
      )
    : true;

  const hardTag = hardOk ? "PASS" : "FAIL";
  const softTag = softOk ? "" : " (soft: no expected evidence)";

  if (!hardOk) {
    hardFailures++;
  }

  if (!softOk) {
    softFailures++;
  }

  console.log(
    `\n[${hardTag}]${softTag} ${test.question}`
  );

  if (matches.length === 0) {
    console.log("  (no chunks — unsupported path)");
    continue;
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];

    if (!match) {
      continue;
    }

    console.log(
      `  ${i + 1}. ${match.source} | ${match.section}`
    );
  }
}

console.log("\n========================================");
console.log("SUMMARY");
console.log("========================================");
console.log(`Total tests:    ${tests.length}`);

console.log(
  `Hard failures:  ${hardFailures} ` +
  `(supported returned 0, or unsupported returned >0)`
);

console.log(
  `Soft failures:  ${softFailures} ` +
  `(expected evidence not present in top 5)`
);

if (hardFailures > 0) {
  process.exit(1);
}
