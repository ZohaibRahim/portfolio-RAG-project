import fs from "fs";
import path from "path";

import { chunkMarkdown } from "../services/chunker.js";

const knowledgePath = path.resolve(
  process.cwd(),
  "../knowledge/resume.md"
);

const markdown = fs.readFileSync(knowledgePath, "utf-8");

const chunks = chunkMarkdown(
  markdown,
  "resume",
  "resume"
);

console.log(`Created ${chunks.length} chunks\n`);

for (const chunk of chunks.slice(0, 5)) {
  console.log("--------------------------------");
  console.log(`ID: ${chunk.id}`);
  console.log(`Section: ${chunk.section}`);
  console.log(`Chunk index: ${chunk.chunkIndex}`);
  console.log(`Words: ${chunk.content.split(/\s+/).length}`);
  console.log();
  console.log(chunk.content.substring(0, 300));
  console.log();
}