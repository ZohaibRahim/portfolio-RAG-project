import fs from "fs";
import path from "path";

import { chunkMarkdown } from "./chunker.js";
import { PortfolioChunk } from "../types/PortfolioChunk.js";

interface KnowledgeSource {
  file: string;
  source: string;
  sourceType: string;
}

const KNOWLEDGE_SOURCES: KnowledgeSource[] = [
  {
    file: "resume.md",
    source: "resume",
    sourceType: "resume",
  },
  {
    file: "roshtay.md",
    source: "roshtay",
    sourceType: "project",
  },
  {
    file: "portfolio-website.md",
    source: "portfolio-website",
    sourceType: "project",
  },
  {
    file: "jobtrackr.md",
    source: "jobtrackr",
    sourceType: "project",
  },
  {
    file: "enterprise-llm-jailbreak-detection.md",
    source: "enterprise-llm-jailbreak-detection",
    sourceType: "project",
  },
  {
    file: "security-log-analyzer.md",
    source: "security-log-analyzer",
    sourceType: "project",
  },
];

export function loadKnowledgeBase(): PortfolioChunk[] {
  const knowledgeDirectory = path.resolve(
    process.cwd(),
    "../knowledge"
  );

  const allChunks: PortfolioChunk[] = [];

  for (const knowledgeSource of KNOWLEDGE_SOURCES) {
    const filePath = path.join(
      knowledgeDirectory,
      knowledgeSource.file
    );

    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Knowledge file not found: ${filePath}`
      );
    }

    const markdown = fs.readFileSync(filePath, "utf-8");

    const chunks = chunkMarkdown(
      markdown,
      knowledgeSource.source,
      knowledgeSource.sourceType
    );

    allChunks.push(...chunks);
  }

  return allChunks;
}