import { PortfolioChunk } from "../types/PortfolioChunk.js";

/**
 * H2 headings in resume.md that group portfolio projects.
 *
 * This is build-time configuration only — it never reaches the
 * runtime retrieval or answer pipeline. The strings are category
 * headings, not project names; extending the list to add a new
 * category is a one-line edit here and re-ingestion. Individual
 * project names are extracted dynamically from H3 headings under
 * these H2 categories and are never hardcoded.
 */
const PROJECT_CATEGORY_HEADINGS = [
  "Machine Learning, AI & Data Science",
  "Analytics & Business Intelligence",
  "Full-Stack & Software Engineering",
  "Database & Information Systems",
  "Digital Transformation & Platforms",
  "Networking & Security",
] as const;

/**
 * Fixed metadata for the single catalogue chunk. Keeping these
 * values constant across re-ingestions is what makes the chunk
 * idempotently upsertable in Azure AI Search — same id, same
 * shape, content overwritten in place.
 */
export const CATALOGUE_SOURCE = "catalogue";
export const CATALOGUE_SOURCE_TYPE = "catalogue";
export const CATALOGUE_SECTION = "Projects Catalogue";
export const CATALOGUE_CHUNK_ID = "catalogue-0";

/**
 * Preamble written into the catalogue chunk body. Tells the
 * answer LLM (and any downstream reader) what the chunk is and
 * where the fuller evidence lives. Kept short to preserve room
 * for entries under the reranker's word-count truncation.
 */
const CATALOGUE_PREAMBLE =
  "Automatically generated index of Zohaib's portfolio projects by category. " +
  "Detailed evidence for individual projects is stored in the normal project " +
  "and resume chunks.";

interface CategoryEntry {
  category: string;
  projects: string[];
}

/**
 * Walk the resume markdown once and collect, per known project
 * category H2, the list of H3 project names underneath it in
 * document order.
 *
 * Robust to:
 *   - Categories that appear in any order
 *   - Categories missing from the file (dropped from output)
 *   - H4 sub-headings under an H3 (ignored — only ### rows count)
 *   - Trailing spaces / punctuation in headings
 */
function extractProjectEntries(
  markdown: string
): CategoryEntry[] {
  const lines = markdown.split(/\r?\n/);

  const collected = new Map<string, string[]>();
  let currentCategory: string | null = null;

  for (const line of lines) {
    // Match H1/H2/H3 headings only. H4+ is body under a project.
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h3 = line.match(/^###\s+(.+?)\s*$/);

    // Any H1 or H2 (non-H3) resets the current category context.
    if (h2) {
      const title = h2[1] ?? "";
      const isProjectCategory = PROJECT_CATEGORY_HEADINGS
        .some((name) => name === title);

      if (isProjectCategory) {
        currentCategory = title;
        if (!collected.has(title)) {
          collected.set(title, []);
        }
      } else {
        // Left the project section — stop collecting until a
        // known category H2 appears again.
        currentCategory = null;
      }
      continue;
    }

    // H1 boundaries also reset (defensive; resume.md has only one).
    if (/^#\s+/.test(line) && !h2 && !h3) {
      currentCategory = null;
      continue;
    }

    if (h3 && currentCategory) {
      const projectName = h3[1] ?? "";
      collected.get(currentCategory)!.push(projectName);
    }
  }

  // Preserve the configured category order in the output so the
  // catalogue chunk is stable across ingestion runs.
  return PROJECT_CATEGORY_HEADINGS
    .map((category) => ({
      category,
      projects: collected.get(category) ?? [],
    }))
    .filter((entry) => entry.projects.length > 0);
}

/**
 * Render the extracted category entries into the exact
 * catalogue chunk text.
 */
function renderCatalogueBody(
  entries: CategoryEntry[]
): string {
  const sections = entries.map((entry) => {
    const bullets = entry.projects
      .map((name) => `- ${name}`)
      .join("\n");

    return `${entry.category}:\n${bullets}`;
  });

  return [CATALOGUE_PREAMBLE, ...sections].join("\n\n");
}

/**
 * Build the single Projects Catalogue chunk from the resume
 * markdown. The chunk is a compact index — categories +
 * canonical project names only, no per-project descriptions.
 * Descriptions live in the resume and dedicated project files
 * and are surfaced via the regular retrieval path.
 *
 * Deterministic: same markdown input → identical chunk output.
 */
export function buildProjectsCatalogueChunk(
  resumeMarkdown: string
): PortfolioChunk {
  const entries = extractProjectEntries(resumeMarkdown);

  if (entries.length === 0) {
    throw new Error(
      "Projects Catalogue is empty. " +
      "Expected at least one PROJECT_CATEGORY_HEADINGS H2 in resume.md."
    );
  }

  const body = renderCatalogueBody(entries);

  // Mirror the chunker's layout: "Section: <name>\n\n<body>".
  // This is what the ingestion path embeds and what shows up in
  // the reranker prompt.
  const content = `Section: ${CATALOGUE_SECTION}\n\n${body}`;

  return {
    id: CATALOGUE_CHUNK_ID,
    content,
    source: CATALOGUE_SOURCE,
    sourceType: CATALOGUE_SOURCE_TYPE,
    section: CATALOGUE_SECTION,
    chunkIndex: 0,
  };
}
