/**
 * One-shot bootstrap for the Azure Search staging index.
 *
 * Clones the schema of the production `portfolio-chunks` index
 * into a new `portfolio-chunks-staging` index — same fields,
 * same vector dimensions, same vector-search / HNSW / semantic
 * / scoring configuration — leaving the target empty.
 *
 * Never modifies the source index. Never copies documents.
 * Idempotent: if the target already exists, the script prints
 * that fact and exits without touching anything.
 *
 * Uses the existing AZURE_SEARCH_ENDPOINT and
 * AZURE_SEARCH_API_KEY from the app's env module — no
 * credentials are hardcoded here.
 *
 * Run once with:
 *   npm run bootstrap:staging
 */

import {
  AzureKeyCredential,
  SearchIndex,
  SearchIndexClient,
} from "@azure/search-documents";

import { env } from "../config/env.js";

const SOURCE_INDEX_NAME = "portfolio-chunks";
const TARGET_INDEX_NAME = "portfolio-chunks-staging";

/**
 * The @azure/search-documents SDK throws a RestError-shaped
 * object when Azure returns a non-2xx. We only care about
 * distinguishing "index not found" (404) from real failures,
 * so a narrow duck-type is sufficient.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const status = (error as { statusCode?: number }).statusCode;
  return status === 404;
}

/**
 * Deep-clone the source index definition, replacing only the
 * `name` and clearing any server-managed versioning fields that
 * would be invalid on a create-new request.
 */
function cloneIndexForTarget(
  source: SearchIndex,
  targetName: string
): SearchIndex {
  const cloned = JSON.parse(JSON.stringify(source)) as SearchIndex & {
    etag?: string;
    "@odata.etag"?: string;
  };

  cloned.name = targetName;

  // Strip server-managed versioning so createIndex doesn't
  // reject the payload as a stale update.
  delete cloned.etag;
  delete cloned["@odata.etag"];

  return cloned as SearchIndex;
}

/**
 * Read the first vector-search-dimensioned field to surface a
 * safety report line before we create anything. Returns
 * undefined if no vector field is defined (unexpected for this
 * project, but the script does not fail on it).
 */
function detectVectorDimensions(index: SearchIndex): number | undefined {
  for (const field of index.fields) {
    const maybe = field as { vectorSearchDimensions?: number };
    if (typeof maybe.vectorSearchDimensions === "number") {
      return maybe.vectorSearchDimensions;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const client = new SearchIndexClient(
    env.azureSearchEndpoint,
    new AzureKeyCredential(env.azureSearchApiKey)
  );

  // ------------------------------------------------------
  // Step 1 — idempotency check on the TARGET.
  //
  // If the staging index already exists we exit cleanly. We
  // deliberately do NOT delete or recreate it — repeat runs
  // must be safe, and never destructive.
  // ------------------------------------------------------
  try {
    const existing = await client.getIndex(TARGET_INDEX_NAME);
    console.log(
      `Target index "${TARGET_INDEX_NAME}" already exists.`
    );
    console.log(`  field count: ${existing.fields.length}`);
    console.log(
      `  vector dimensions: ${detectVectorDimensions(existing) ?? "(none detected)"}`
    );
    console.log(
      "Not touching it. Delete it manually if you want a fresh copy."
    );
    return;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    // 404 — target absent; proceed.
  }

  // ------------------------------------------------------
  // Step 2 — read the SOURCE (production) index schema.
  //
  // Read-only. This never mutates portfolio-chunks in any
  // way, and no documents are transferred.
  // ------------------------------------------------------
  console.log(
    `Fetching source index schema: "${SOURCE_INDEX_NAME}"`
  );
  const source = await client.getIndex(SOURCE_INDEX_NAME);

  const dims = detectVectorDimensions(source);

  console.log("");
  console.log(`Source index:      ${SOURCE_INDEX_NAME}`);
  console.log(`Target index:      ${TARGET_INDEX_NAME}`);
  console.log(`Vector dimensions: ${dims ?? "(none detected)"}`);
  console.log(`Field count:       ${source.fields.length}`);
  console.log("");

  // ------------------------------------------------------
  // Step 3 — create the TARGET with the cloned schema.
  //
  // Only `name` (and server-managed etag fields) differ from
  // the source. Everything else — fields, vectorSearch,
  // semanticSearch, scoringProfiles, analyzers, tokenizers,
  // charFilters, tokenFilters, corsOptions, similarity — is
  // carried across via a deep JSON clone.
  // ------------------------------------------------------
  const cloned = cloneIndexForTarget(source, TARGET_INDEX_NAME);

  console.log(`Creating "${TARGET_INDEX_NAME}"...`);
  await client.createIndex(cloned);

  console.log(
    `Created. "${TARGET_INDEX_NAME}" is empty and ready for ingestion.`
  );
}

main().catch((error) => {
  console.error("\nbootstrapStagingIndex failed:");
  console.error(error);
  process.exit(1);
});
