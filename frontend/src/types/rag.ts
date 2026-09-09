/**
 * A source chunk returned by the RAG backend.
 */
export interface RagSource {
  citation: number;
  source: string;
  section: string;
  chunkIndex: number;
}

/**
 * Full response returned by POST /api/ask.
 */
export interface RagAnswer {
  answer: string;
  sources: RagSource[];
}