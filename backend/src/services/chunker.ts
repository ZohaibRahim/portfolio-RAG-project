import { PortfolioChunk } from "../types/PortfolioChunk.js";

const TARGET_WORDS = 350;
const OVERLAP_WORDS = 50;

export function chunkMarkdown(
  text: string,
  source: string,
  sourceType: string
): PortfolioChunk[] {
  const lines = text.split(/\r?\n/);

  const chunks: PortfolioChunk[] = [];

  const headingStack: string[] = [];

  let currentSection = "Overview";
  let sectionText: string[] = [];
  let chunkIndex = 0;

  const processSection = () => {
    const body = sectionText.join("\n").trim();

    if (!body) {
      sectionText = [];
      return;
    }

    const words = body.split(/\s+/);

    let start = 0;

    while (start < words.length) {
      const end = Math.min(start + TARGET_WORDS, words.length);

      const bodyChunk = words.slice(start, end).join(" ");

      // Include the section name in the text that will be embedded.
      const content = `Section: ${currentSection}\n\n${bodyChunk}`;

      chunks.push({
        id: `${slugify(source)}-${chunkIndex}`,
        content,
        source,
        sourceType,
        section: currentSection,
        chunkIndex,
      });

      chunkIndex++;

      if (end === words.length) {
        break;
      }

      start = end - OVERLAP_WORDS;
    }

    sectionText = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);

    if (headingMatch) {
      processSection();

      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim();

      headingStack[level - 1] = heading;
      headingStack.length = level;

      currentSection = getSectionPath(headingStack);

      continue;
    }

    sectionText.push(line);
  }

  processSection();

  return chunks;
}

function getSectionPath(headings: string[]): string {
  // Ignore the H1 document title when more specific headings exist.
  const meaningfulHeadings = headings.slice(1).filter(Boolean);

  if (meaningfulHeadings.length > 0) {
    return meaningfulHeadings.join(" > ");
  }

  return headings[0] ?? "Overview";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}