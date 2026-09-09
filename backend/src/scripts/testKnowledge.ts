import { loadKnowledgeBase } from "../services/knowledgeLoader.js";

const chunks = loadKnowledgeBase();

console.log(`\nTotal chunks: ${chunks.length}\n`);

const countsBySource = new Map<string, number>();

for (const chunk of chunks) {
  const currentCount =
    countsBySource.get(chunk.source) ?? 0;

  countsBySource.set(
    chunk.source,
    currentCount + 1
  );
}

console.log("Chunks by source:");
console.log("-----------------");

for (const [source, count] of countsBySource) {
  console.log(`${source}: ${count}`);
}

console.log("\nSample chunks:");
console.log("--------------");

for (const chunk of chunks.slice(0, 3)) {
  console.log({
    id: chunk.id,
    source: chunk.source,
    sourceType: chunk.sourceType,
    section: chunk.section,
    chunkIndex: chunk.chunkIndex,
    words: chunk.content.split(/\s+/).length,
  });
}