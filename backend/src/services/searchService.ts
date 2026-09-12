import {
  AzureKeyCredential,
  SearchClient,
} from "@azure/search-documents";

import { env } from "../config/env.js";
import { PortfolioSearchDocument } from "../types/PortfolioSearchDocument.js";

/**
 * Shape returned to the rest of the application
 * after a Search query.
 */
export interface SearchMatch {
  score: number;
  id: string;
  content: string;
  source: string;
  sourceType: string;
  section: string;
  chunkIndex: number;
}

/**
 * Fields we actually retrieve from Azure AI Search.
 *
 * contentVector is intentionally excluded because
 * the index does not return embedding vectors.
 */
type RetrievedSearchDocument = Pick<
  PortfolioSearchDocument,
  | "id"
  | "content"
  | "source"
  | "sourceType"
  | "section"
  | "chunkIndex"
>;

/**
 * Shared Azure AI Search client.
 *
 * The active index comes from:
 * AZURE_SEARCH_INDEX_NAME
 *
 * Development:
 * portfolio-chunks-dev-ollama
 *
 * Production:
 * portfolio-chunks
 */
const searchClient =
  new SearchClient<PortfolioSearchDocument>(
    env.azureSearchEndpoint,
    env.azureSearchIndexName,
    new AzureKeyCredential(env.azureSearchApiKey)
  );

/**
 * Upload one document.
 *
 * Mainly useful for individual Search tests.
 */
export async function uploadSearchDocument(
  document: PortfolioSearchDocument
): Promise<void> {
  const result =
    await searchClient.uploadDocuments([
      document,
    ]);

  const upload = result.results[0];

  if (!upload?.succeeded) {
    throw new Error(
      `Failed to upload document ${document.id}: ${
        upload?.errorMessage ??
        "Unknown error"
      }`
    );
  }
}

/**
 * Upload or update multiple documents.
 *
 * mergeOrUploadDocuments() means:
 *
 * - if the document does not exist -> create it
 * - if the document already exists -> update it
 *
 * This makes the ingestion script safe to rerun.
 */
export async function uploadSearchDocuments(
  documents: PortfolioSearchDocument[]
): Promise<void> {
  if (documents.length === 0) {
    return;
  }

  const result =
    await searchClient.mergeOrUploadDocuments(
      documents
    );

  const failures =
    result.results.filter(
      (item) => !item.succeeded
    );

  if (failures.length > 0) {
    const failureDetails = failures
      .map(
        (item) =>
          `${item.key}: ${
            item.errorMessage ??
            "Unknown error"
          }`
      )
      .join("\n");

    throw new Error(
      `Failed to upload ${failures.length} document(s):\n${failureDetails}`
    );
  }
}

/**
 * Retrieve one document directly by its ID.
 */
export async function getSearchDocument(
  id: string
): Promise<PortfolioSearchDocument> {
  return searchClient.getDocument(id);
}

/**
 * Delete every document in the index whose `sourceType` equals
 * the given value. Used by the ingestion script to clear stale
 * catalogue documents before re-uploading, so a future shape
 * change (or per-category split) cannot leave orphan entries.
 *
 * Returns the number of documents deleted.
 */
export async function deleteDocumentsBySourceType(
  sourceType: string
): Promise<number> {
  const escaped = sourceType.replace(/'/g, "''");

  const response = await searchClient.search(
    "*",
    {
      filter: `sourceType eq '${escaped}'`,
      select: ["id"],
      top: 1000,
    }
  );

  const idsToDelete: string[] = [];

  for await (const result of response.results) {
    idsToDelete.push(
      (result.document as { id: string }).id
    );
  }

  if (idsToDelete.length === 0) {
    return 0;
  }

  // Use the key-name / key-values overload so we don't have to
  // fabricate full PortfolioSearchDocument objects for delete.
  await searchClient.deleteDocuments("id", idsToDelete);

  return idsToDelete.length;
}

/**
 * Run pure vector retrieval.
 *
 * We keep this mainly for testing and comparison.
 * The portfolio assistant itself normally uses
 * hybrid search instead.
 */
export async function searchByVector(
  queryVector: number[],
  topK = 5
): Promise<SearchMatch[]> {
  const response =
    await searchClient.search(
      "*",
      {
        vectorSearchOptions: {
          queries: [
            {
              kind: "vector",

              // Semantic representation of
              // the user's question.
              vector: queryVector,

              // Search against our embedding field.
              fields: [
                "contentVector",
              ],

              kNearestNeighborsCount:
                topK,
            },
          ],
        },

        /**
         * Return only the text and metadata
         * needed by the application.
         *
         * contentVector is deliberately omitted.
         */
        select: [
          "id",
          "content",
          "source",
          "sourceType",
          "section",
          "chunkIndex",
        ],

        top: topK,
      }
    );

  return collectResults(
    response.results
  );
}

/**
 * Run hybrid retrieval.
 *
 * Hybrid search combines:
 *
 * 1. keyword/BM25 retrieval
 * 2. vector similarity retrieval
 *
 * Azure combines the two rankings to produce
 * the final result order.
 *
 * The optional filter lets us restrict certain
 * queries to specific sources.
 *
 * Example:
 *
 * source eq 'resume'
 */
export async function searchHybrid(
  keywordQuery: string,
  queryVector: number[],
  topK = 5,
  filter?: string
): Promise<SearchMatch[]> {
  const response =
    await searchClient.search(
      keywordQuery,
      {
        vectorSearchOptions: {
          queries: [
            {
              kind: "vector",

              // Full semantic query vector.
              vector: queryVector,

              fields: [
                "contentVector",
              ],

              /**
               * Consider a broader vector candidate
               * set before Azure returns the final
               * top-ranked hybrid results.
               *
               * We deliberately ask for far more vector
               * neighbours than we ultimately return
               * (see `top` below). Widening this pool
               * helps short/broad queries (like
               * "Who is Zohaib?") surface canonical
               * biographical chunks that would otherwise
               * fall outside a tight 20-neighbour window.
               */
              kNearestNeighborsCount:
                50,
            },
          ],
        },

        /**
         * Optional OData filter.
         *
         * For a broad profile question this becomes:
         *
         * source eq 'resume'
         */
        filter,

        /**
         * Return only fields the frontend/backend
         * actually need.
         */
        select: [
          "id",
          "content",
          "source",
          "sourceType",
          "section",
          "chunkIndex",
        ],

        top: topK,
      }
    );

  return collectResults(
    response.results
  );
}

/**
 * Convert Azure's asynchronous Search result stream
 * into the simpler SearchMatch[] format used by
 * retrievalService and ragService.
 *
 * The generic type here deliberately represents
 * only the fields selected during Search.
 */
async function collectResults(
  results: AsyncIterable<{
    score: number;
    document: RetrievedSearchDocument;
  }>
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];

  for await (
    const result of results
  ) {
    matches.push({
      score: result.score,

      id:
        result.document.id,

      content:
        result.document.content,

      source:
        result.document.source,

      sourceType:
        result.document.sourceType,

      section:
        result.document.section,

      chunkIndex:
        result.document.chunkIndex,
    });
  }

  return matches;
}