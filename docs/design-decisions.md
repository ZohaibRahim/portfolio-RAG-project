# Design Decisions

Rationale, benchmarks, and measured tradeoffs behind the key architecture
choices in the Portfolio RAG Assistant. Only decisions with evidence worth
preserving are captured here — micro-choices that a code reader can infer
directly are intentionally omitted.

Each section follows the same shape: what was chosen, what else was
considered, the measurement that supported the choice, and the tradeoff
being accepted.

---

## Two-stage retrieval: hybrid search + LLM rerank

**Decision.** Retrieve a broad candidate pool from Azure AI Search
(BM25 + vector, "recall stage") and then rerank the pool with an LLM
that prunes and reorders it ("precision stage").

**Pipeline.**

```
question
  → LLM query rewrite (env-gated)
  → embed original question
  → Azure hybrid search (top 15 candidates)
  → deterministic meta-section pre-filter (drops ~5)
  → LLM reranker (selects the relevant subset)
  → top ~5 chunks → answer generator
```

**Alternatives considered.**

| Alternative | Why rejected |
|---|---|
| Azure semantic ranker | Requires paid Search tier; project runs on the Free tier |
| Score threshold on hybrid RRF scores | RRF scores don't behave like calibrated probabilities |
| No rerank, just Azure top 5 | Measurably worse precision (proven whenever the reranker fell back to Azure order under rate limits — irrelevant chunks appeared in the answer context) |
| Cross-encoder rerank model | Additional dependency + infra; LLM rerank reuses the same model already in the stack |

**Evidence.** The 30-question regression suite consistently produces
30/30 hard passes with the reranker active. When the reranker degraded
to fallback behaviour during Azure rate-limit incidents, questions that
previously had clean top-1 evidence started returning padded top-5s with
irrelevant chunks (`License`, `Contact`, unrelated project sections).

---

## Candidate pool size: 15

**Decision.** Fetch 15 candidates from Azure. After the deterministic
meta-filter drops ~5, roughly 10 reach the LLM reranker.

**Alternatives considered.** 10, 12, 20.

**Evidence — pool-size sweep, 30-question regression suite:**

| Pool size | Hard pass | Gradified: correct chunk at #1 | F1-score: `My Contribution` in top 5 | Roshtai (typo): noise chunks |
|---:|:-:|:-:|:-:|:-:|
| 20 (initial) | 30/30 | Yes | Yes | None |
| 15 (chosen) | 30/30 | Yes | Yes | None |
| 12 | 30/30 | **No — demoted to #2, junk padded #3–5** | Yes | **2 unrelated `jobtrackr` chunks** |
| 10 | 30/30 | No | **No — dropped entirely** | 2 unrelated `jobtrackr` chunks |

The hard-pass gate stayed green at every size because the correct
evidence usually appeared *somewhere* in top-5, but pool sizes below 15
introduced visible precision loss on multiple questions. Notably at pool
10 the `My Contribution` chunk — the exact one the project's design
called out as the point of the reranker — fell off the top-5 entirely
for the F1 question, replaced by the resume overview.

**Tradeoff.** Going from 15 → 10 would have saved roughly 25% additional
rerank tokens (~500 tokens per question), or ~$0.0001 per question at
GPT-5-mini pricing. Not worth the precision loss for a portfolio bot.

---

## Rerank prompt optimization

**Decision.** Two changes that together cut the biggest LLM prompt in
the pipeline by ~78% without changing search behaviour:

1. **Meta-section filter moved BEFORE the reranker call.** The LLM can't
   pick a chunk it never saw, so we save tokens judging content we would
   drop anyway. The filter's escape hatch (questions explicitly about
   the portfolio site) is preserved.
2. **Candidate bodies truncated to 150 words for the rerank prompt
   only.** Full chunk text still flows to the answer generator through
   the `SearchMatch` objects that survive the reranker.

**Alternatives considered.**

- Truncate more aggressively (100 words): risks stripping the paragraph
  that actually answers the question.
- Send only section headers to the reranker: too little context for
  correct relevance judgements.
- Keep meta filter post-LLM (previous behaviour): wastes rerank tokens
  and relies on the LLM to consistently reject meta chunks, which
  Qwen 4B did not do reliably.

**Evidence — before vs after, per question:**

| Stage | Before | After | Reduction |
|---|---:|---:|---:|
| Candidates shown to LLM | 20 | ~10 (post pre-filter) | ~50% |
| Words per candidate | ~350 | 150 (capped) | ~57% |
| Rerank input tokens (approx) | ~9,000 | ~2,000 | **~78%** |

Regression verdict: 30/30 hard passes preserved through both changes.

---

## Reranker output contract: selection-only

**Decision.** The reranker returns a bare JSON array of candidate
numbers, in ranked order, listing only the candidates it considers
relevant. Empty array = nothing is relevant, which triggers the
"not enough information" short-circuit downstream.

**How we got here.** The contract changed twice before landing here:

| Version | Contract | Failure mode | Why we moved on |
|---:|---|---|---|
| v1 | `[3, 7, 1]` — ranked positions of every candidate | Model returned all N positions even when many were irrelevant; no way to distinguish "high" from "low" relevance | Couldn't signal "not enough info" |
| v2 | `[{"i": 3, "r": "high"}, ...]` for every candidate, filter drops `low` | Qwen 4B routinely truncated the exhaustive list; parser defaulted missing entries to "medium", which defeated the "not relevant" signal | `"favorite movie"` still returned 5 chunks |
| **v3 (current)** | `[3, 7, 1]` — only relevant numbers, in rank order; omission ⇒ dropped; `[]` ⇒ nothing relevant | | Simpler for small models; empty case unambiguous |

**Evidence for v3.** After the switch, `"What is Zohaib's favorite
movie?"` and other unsupported questions consistently return 0 chunks,
letting `ragService` respond with the canonical
"The portfolio does not contain enough information to answer that."
message without a wasted LLM call.

---

## Deterministic meta-filter + LLM guidance (defense in depth)

**Decision.** Two layers of "no README/site-maintenance chunks in
answers":

1. **Prompt-level guidance** in the rerank instructions — tells the
   model to prefer specific evidence over generic metadata and to
   ignore `License`, `Contact`, project structure, etc. unless the
   question is about the site itself.
2. **Regex blocklist post-parse** (see `META_SECTION_BLOCKLIST` in
   `rerankService.ts`) — 15 anchored patterns applied to
   `SearchMatch.section` after retrieval, dropping meta chunks before
   they ever reach the LLM.

**Why both?** Small models like Qwen 4B follow long prompt rules
inconsistently. The regex is a deterministic backstop that closes the
gap. The prompt guidance is still worth keeping so a stronger
production model (GPT-5-mini) can also apply judgement on cases the
regex list doesn't cover.

**Escape hatch.** If the user's question contains any of
`portfolio site`, `portfolio website`, `website`, `repository`, `repo`,
`readme`, `codebase`, `source code`, the entire blocklist is skipped
for that request — because in that case meta content *is* the correct
answer.

---

## Citation validation

**Decision.** After the answer LLM returns raw text, apply two
invariants before responding to the client:

1. Strip any `[N]` where `N` is outside the range of chunks we actually
   sent to the model (including any preceding whitespace, so sentences
   read cleanly).
2. Filter the `sources` array so it contains only citations that
   survive in the sanitized text.

**Why on the backend.** The frontend previously did this filtering
defensively. Moving it to the backend makes the API contract explicit:
`sources` is exactly what the answer references — no more, no less. The
frontend can render sources directly without knowing about citation
parsing.

**Test coverage.** `npm run test:citations` — five unit-style checks
including out-of-range strip, dedup across identical citations,
mid-sentence removal, and answers with no citations. All pass.

**Example** — input from the model, output after validation:

```
INPUT:  Zohaib used Python [2] and AWS [7].
OUTPUT: Zohaib used Python [2] and AWS.
SOURCES: [2]
```

---

## Provider abstraction (Ollama dev, Azure OpenAI prod)

**Decision.** Every LLM-touching service (`chatService`,
`queryRewriteService`, `rerankService`, `embeddingService`) routes on
`env.aiProvider` (`"ollama"` or `"azure"`). No other code branches on
provider.

- **Local dev:** free Ollama — `qwen3:4b-instruct` (chat/rewrite/rerank)
  and `qwen3-embedding:0.6b` (1024-dim embeddings) against the
  `portfolio-chunks-dev-ollama` Search index.
- **Production:** Azure OpenAI — GPT-5-mini (chat/rewrite/rerank) and
  `text-embedding-3-small` (1536-dim embeddings) against the
  `portfolio-chunks` Search index.

Switching environments is one `.env` edit; zero TypeScript changes.

**Dimension guard.** `embeddingService.getEmbeddingDimensions()`
returns the expected dimension count for the active provider, and both
the ingestion script and the retrieval pipeline throw if a returned
embedding doesn't match. This prevents the classic RAG bug where a
1024-dim query vector gets sent to a 1536-dim index (or vice versa).

---

## Production-only: reasoning effort per stage

**Decision.** GPT-5-mini's `reasoning.effort` parameter is set to the
lowest level that produces correct output for each stage:

| Stage | Effort | Rationale |
|---|---|---|
| Query rewrite | `minimal` | Constrained keyword expansion; deep reasoning adds nothing |
| Rerank | `low` | Constrained selection *most of the time*, but typo-carrying questions ("Roshtai" vs Roshtay, "PHAS" vs PHSA) empirically fail at `minimal` — the model reads the token mismatch literally and returns `[]` even when the pool contains correctly-spelled evidence. `low` supplies just enough reasoning headroom to apply the typo-tolerance instruction (see below). |
| Answer generation | `low` | Enough headroom to apply grounding, citation, and formatting rules; not enough to trigger an expensive deep-think loop |

**Evidence for rerank at `low`.** A 5x repro against
`portfolio-chunks-staging` of `"What is Roshtai?"`:

| Config | Pass rate |
|---|:-:|
| `effort: minimal`, no typo instruction | 1/5 (baseline variance) |
| `effort: minimal` + typo-tolerance instruction | 1/5 (unchanged — prompt-only fix didn't help) |
| **`effort: low` + typo-tolerance instruction** | **5/5** |

The retrieval side was fine throughout — 7 Roshtay chunks appeared in
the pre-rerank pool on every run. The reranker itself was the failure
point, and the effort bump was the fix.

The typo-tolerance instruction added to `RERANK_INSTRUCTIONS`:

> Treat obvious minor spelling variations or typographical errors as
> referring to the matching entity when the surrounding evidence makes
> the intended referent clear.

Generic on purpose — no project or employer names hardcoded.

**Token-cap consequences.** Reasoning tokens count against
`max_output_tokens`. Two caps were bumped alongside the effort change:

| Stage | Before | After | Why |
|---|---:|---:|---|
| Chat / answer | 700 | 1500 | Reasoning + answer text must both fit |
| Rerank | 200 | 800 | At `effort: low` the model spent enough reasoning tokens to truncate the JSON array mid-write, causing frequent parse failures and fallback to raw pool order. 800 leaves comfortable headroom for reasoning plus a short array of at most ~15 numbers. |

---

## Query-rewrite feature flag

**Decision.** The LLM query-rewrite stage is togglable via the
`QUERY_REWRITE_ENABLED` env var. **Default is now `false`** — the
regression evidence (below) showed the rewrite call was not paying for
itself. Setting the flag back to `true` re-enables the rewrite without
a code change.

**Why a flag rather than delete.** The rewrite step is one of three
LLM calls per question and one full network round-trip. Its actual
contribution to retrieval quality is only measurable by running the
regression suite with it disabled. Keeping the flag lets us:

- Re-test after any knowledge-base expansion without a deploy
- Roll back to the rewrite path if a later regression starts depending
  on it
- Compare pipeline output with rewrite on vs off from a single `.env`
  edit

**Evidence — 30-question regression, 2026-09-09.**

| Metric | Rewrite ON | Rewrite OFF |
|---|:-:|:-:|
| Hard passes | 30 / 30 | 30 / 30 |
| Soft failures | 1 (PHAS typo — no expected evidence to find) | 1 (same case) |
| Top-1 evidence correct | matched in 27 / 30; minor top-1 shuffles on 3 | matched in 27 / 30; minor top-1 shuffles on 3 |
| Credit Card Fraud question | 5 chunks in top-5, 4 unrelated jailbreak chunks padded in | **1 clean chunk** — reranker had a shorter query and rejected more noise |

The three shuffled cases (`Python` skill, `Python security log
analyzer`, `What kind of work does Zohaib do?`) still passed and the
correct evidence appeared in the top 3 either way; the reordering was
between roughly equivalent chunks (e.g. `resume | About Zohaib` vs
`enterprise-llm-jailbreak-detection | Technology Stack` for the Python
skill question).

**Tradeoff being accepted.** One fewer LLM call per question (~500
tokens of rewrite input at GPT-5-mini pricing, ≈ $0.0001 saved per
question) and one full network round-trip removed → measurably lower
p50 latency in the answer path. Precision was **unchanged or slightly
better** on this suite; the risk we're accepting is that a future
knowledge-base expansion introduces question shapes where the rewrite
matters, which the flag lets us verify without redeploying.

---

## Ollama context window: `num_ctx: 8192`

**Decision.** Explicitly set `num_ctx: 8192` on Ollama chat and rerank
requests instead of relying on the runtime default of 4096.

**Why.** Regression testing surfaced two rerank prompts that exceeded
the default:

```
request (4782 tokens) exceeds the available context size (4096 tokens)
request (5283 tokens) exceeds the available context size (4096 tokens)
```

Both fell back to Azure raw ordering silently — passing the hard test
but bypassing the reranker entirely. Qwen 3 4B natively supports 32K
context; 8K is a safe middle ground that fits the largest observed
prompt with headroom while adding only ~500 MB of RAM overhead on the
local machine.

---

## Express hardening (V1 API surface)

**Decision.** The `/api/ask` endpoint validates and rate-limits before
running the RAG pipeline. All unexpected errors flow through one
centralized handler that logs server-side and returns a generic 500.

**Validation stages** (in order — each returns 400 with a specific
message):

1. `question` must be a string
2. After trim, must be non-empty
3. After trim, must be ≤ 500 characters

**Rate limit.** In-memory, 20 requests per IP per minute on `/api/ask`
only. Runs before validation, so a client already over quota never
reaches the RAG pipeline. `/api/health` is not rate-limited so
external monitoring probes stay unaffected.

**Never leaked to clients.** Stack traces, Azure error bodies, API
keys, internal endpoint URLs, AI provider names, model names. The
centralized error handler always responds with:

```json
{ "error": "An unexpected error occurred." }
```

**Verified test matrix** (PowerShell + `Invoke-RestMethod`):

| Case | Expected | Result |
|---|---|:-:|
| Health GET | 200 | ✅ |
| Valid question | 200 + answer | ✅ |
| Whitespace-only | 400 "Question cannot be empty." | ✅ |
| Non-string question | 400 "Question must be a string." | ✅ |
| Over-length (>500 chars) | 400 "Question must be 500 characters or fewer." | ✅ |
| Malformed JSON | 400 "Invalid JSON body." | ✅ |
| 25 rapid requests | first 20 = 400, last 5 = 429 | ✅ |

**Known limitation.** The in-memory rate-limit store is per-instance.
If the API ever runs behind a load balancer with multiple instances,
each instance keeps its own counter — a shared store (Redis, an API
gateway) becomes necessary. Not worth adding for the single-instance
V1 deployment.

---

## Cross-provider validation: Azure smoke test

**Decision.** Before deploying, run the full 30-question regression
suite against the production provider stack once to confirm the
pipeline still works end-to-end on Azure after the reranker + rewrite
changes made against Ollama. Keep the run bounded so it doesn't burn
credit unnecessarily.

**Setup.** `.env` temporarily flipped to:

```
AI_PROVIDER=azure
AZURE_SEARCH_INDEX_NAME=portfolio-chunks
```

Everything else — reranker contract, meta filter, pool size 15, rewrite
off — unchanged.

**Result — 30-question regression, 2026-09-09.**

| Metric | Ollama (dev) | Azure (prod) |
|---|:-:|:-:|
| Hard passes | 30 / 30 | 30 / 30 |
| Soft failures | 1 | 3 |
| Unsupported → 0 chunks | 4 / 4 | 4 / 4 |
| Pipeline errors (dimension mismatch, token limit, citation) | 0 | 0 |

Pipeline works end-to-end on production without a single code change.
The Azure soft-failure count is higher purely because the two providers
disagree on which identity-related chunk ranks highest.

**The three soft failures.** All in the IDENTITY category:
`Who is Zohaib?`, `Tell me about Zohaib.`, `What is Zohaib's
background?`. In each case, the `resume | About Zohaib` chunk (which
Ollama consistently ranks #1) falls off the top-5 with the Azure
embedding model. What replaces it in the top-5 is the
`resume | Zohaib Rahim — Master Resume` heading chunk and the
`portfolio-website | Zohaib Rahim — Portfolio Site` overview chunk —
both of which contain identity framing under different section
headings.

Answer correctness is unaffected: the replacement chunks contain the
biographical content needed to answer the question. The soft-failure
signal is a *retrieval-precision* indicator ("the specific chunk we
expected is missing"), not an *answer-correctness* indicator.

**Why the divergence.** Different embedding models produce different
semantic neighborhoods:

- `qwen3-embedding:0.6b` (1024-dim, dev) weights the body chunk
  titled "About Zohaib" highest for identity queries.
- `text-embedding-3-small` (1536-dim, prod) weights chunks whose
  headings contain the literal name ("Zohaib Rahim — Master Resume",
  "Zohaib Rahim — Portfolio Site") higher than a body chunk titled
  "About Zohaib".

Both are defensible rankings. Neither is a bug in the pipeline.

**Other observed differences.**

- Azure reranker returns slightly more chunks per question on average.
  GPT-5-mini's rerank judgement is more nuanced than Qwen 4B's; it
  keeps more borderline candidates as "relevant" rather than
  aggressively pruning to 1-2. Adds a small number of extra tokens to
  the answer prompt without changing correctness on this suite.
- All metric, attribution, misspelling, and unsupported questions
  produced identical outcomes on both providers.

**Verdict.** Ship. The 3 soft failures do not warrant blocking
deployment — the assistant's answers to identity questions remain
grounded in real biographical chunks. Track the metric across future
runs so a genuine regression can be distinguished from cross-provider
ranking drift.

**`.env` flipped back to Ollama immediately after the run to stop
consuming Azure credit during development.**

---

## Projects Catalogue: ingestion-time enumeration payload

**Decision.** Ingest one compact "Projects Catalogue" chunk into the
Search index alongside the normal source chunks. The catalogue lists
every portfolio project by canonical name, grouped by category, with
one preamble sentence. It sits in the index like any other document
(`source: "catalogue"`, `sourceType: "catalogue"`, `section: "Projects
Catalogue"`, `id: "catalogue-0"`) and is retrieved through the same
hybrid + rerank path as everything else.

**Motivation — the retrieval mismatch that widening couldn't fix.** A
production test on `"What projects has Zohaib done?"` returned only 3
projects in the answer, with the model correctly noting the portfolio
contained more that the supplied context didn't list. Diagnosis:

- The question's shape is biographical ("what projects has X done").
- BM25 and the vector embedding both match it against biographical
  framing chunks (`Portfolio Site`, `Master Resume`, `Roshtay —
  Founder`, `Mind Art — Founder`), not against project detail chunks.
- The project detail chunks describe individual projects; they don't
  say "these are Zohaib's projects" anywhere in their text. They never
  entered the candidate pool for a broad enumeration query.
- Larger top-K couldn't rescue chunks that were never in the pool.

The catalogue is a compact document that *does* say "these are the
projects, by category" — so it's a strong lexical + semantic match
for broad enumeration queries, and once it's in the answer context
the answer LLM can enumerate every project by name.

**Design constraints followed.**

- Generated automatically at ingestion time from resume.md's H2/H3
  structure. No manually maintained list of project names.
- Category names (six of them, e.g. "Machine Learning, AI & Data
  Science") are build-time config in `catalogueBuilder.ts`. Project
  names are extracted dynamically from `###` headings under those
  H2s — no project name appears in any TypeScript file.
- Compact index only. Category + canonical project name per line, no
  per-project descriptions. Descriptions live in the resume and
  dedicated project files and are surfaced via the regular retrieval
  path when a specific project is asked about.
- Single chunk (`id: "catalogue-0"`) as long as it fits. Splitting per
  category is a V2 escape hatch only if the catalogue ever grows past
  the reranker's ~150-word truncation window.
- The runtime pipeline has no knowledge of the catalogue — no
  intent detection, no special-case widening, no source-name checks.

**Measured size.** 16 projects across 6 categories → 1,035 chars, 147
words, ~259 est. tokens. Comfortably inside the reranker's 150-word
truncation, so the full catalogue reaches the LLM in the rerank prompt
(not just the head).

**Alternatives considered and rejected.**

| Alternative | Why rejected |
|---|---|
| Intent-aware top-K widening at runtime (pool 25 → rerank 15 → dedup 12 for list-shape queries) | Implemented and tested (see below). Adds `intentService.ts`, enumeration constants, a dedup helper, and a `forceMode` scaffolding to production. Costs 66% more rerank input tokens on enumeration queries. Coverage advantage over "catalogue alone" was 2 extra known-project labels in retrieval — but the catalogue body already lists every project name, so the answer LLM enumerates equally well without those extra chunks. |
| Per-category catalogue chunks (one per H2) | Six chunks compete for top-K slots on broad queries and split the enumeration payload. Any category rename in future creates orphan-doc cleanup risk. Not needed until the catalogue outgrows one chunk. |
| A separate "enumeration prompt addendum" for the answer LLM (Variant B in the test) | Same retrieval as V1, plus an answer-prompt paragraph telling the LLM to enumerate distinctly and to hedge ("The retrieved portfolio evidence includes..."). Improved consistency and hedging marginally in the A vs B answer comparison, but did **not** materially improve breadth or completeness (both A and B enumerated 16/16 projects and 6/6 categories). Not worth the extra plumbing. |

**Evidence — A/B/C on the staging index.**

Variants tested against `portfolio-chunks-staging` after the catalogue
was ingested. All three used the same catalogue; they differed only
in runtime behavior.

| Variant | Runtime | Existing 30 (hard) | Enum 5 (hard) | Rerank tokens for 5 enum cases | Final context tokens |
|---|---|:-:|:-:|---:|---:|
| A | catalogue + original 15/5 | 30/30 | 5/5 | ~18,750 | ~4,600 |
| B | A + list-intent answer addendum | 29/30* | 5/5 | ~18,750 | ~5,000 |
| C | catalogue + intent-driven 25/15/12 widening | 29/30* | 5/5 | ~31,250 | ~7,200 |

`*` The 29/30 in B and C is baseline GPT-5-mini rerank variance on
`"Has Zohaib worked with React?"` — retrieval is code-identical to A
for that query. Not caused by the widening or the prompt addendum.

Head-to-head answer generation on `"What projects has Zohaib done?"`
and `"What are some of Zohaib's major projects?"` confirmed A produces
complete enumerations:

| Metric | Variant A | Variant B |
|---|:-:|:-:|
| Distinct projects named | **16/16** | **16/16** |
| Categories covered | **6/6** | **6/6** |
| Cites the catalogue | ✓ | ✓ |
| Cites detail chunks where appropriate | ✓ | ✓ |
| Falsely implies completeness | no | no |

Variant A won: cheapest, simplest, and hits the coverage bar. The
existing system prompt's `"Use bullet lists when enumerating multiple
items"` rule is enough to make the model enumerate from the catalogue
without an explicit list-intent addendum.

**Consequences of choosing A.** These runtime paths were deleted:

- `intentService.ts` (whole file)
- `ENUMERATION_POOL_SIZE`, `ENUMERATION_RERANK_TOPN`,
  `ENUMERATION_FINAL_TOP_K` constants
- `deduplicateBySourceSection` helper
- `LIST_INTENT_ADDENDUM` and its plumbing through `chatService` and
  `ragService`
- `RetrievalOptions`/`forceMode` and the A/B/C test scaffolding

The production retrieval path is now exactly what it was before the
catalogue landed: pool 15, rerank top 5, no intent branching. The
catalogue simply exists in the index and competes for top-5 slots on
its own merit.

**Stale-catalogue cleanup during ingestion.** Before uploading, the
ingest script calls `deleteDocumentsBySourceType("catalogue")` to
remove any existing catalogue documents from the target index. This
makes catalogue re-ingestion a full replace, so a future shape or
id change cannot leave orphan documents. The stable id (`catalogue-0`)
means the normal case is a single-document overwrite; the delete is
insurance for shape drift.

**Tradeoff being accepted.**

- The catalogue chunk is auto-generated content — one extra document
  in the index. Small (259 tokens) and always retrieved when broad
  enumeration queries fire, so it acts as a permanent, correct index
  the answer LLM can enumerate from.
- Catalogue freshness is now an **ingestion/deployment concern**. If a
  project is added to `resume.md` and ingestion doesn't re-run, the
  answer to broad enumeration queries will read as a complete list
  while missing the new project. Mitigated by treating ingest as a
  required step in the release process, not runtime intent detection.

---

## Projects Catalogue: staging-first rollout

**Decision.** The catalogue was validated against a dedicated Azure
Search staging index (`portfolio-chunks-staging`) before ever touching
`portfolio-chunks`. Schema was cloned from production via
`SearchIndexClient.getIndex()` + `createIndex()` in the one-shot
`bootstrap:staging` npm script — same 1536-dim vectors, same fields,
same HNSW/cosine profile, same semantic and scoring config.

**Why staging.** Ingestion into the production index would re-embed
every existing chunk (upserting under the same ids) plus add the
catalogue. That's low-risk mechanically, but it burns Azure OpenAI
credit and would blur the boundary between "measured before deploy"
and "deployed". A separate index kept the A/B/C experiment cleanly
isolated and made re-running trivial.

**Idempotency of the bootstrap.** If `portfolio-chunks-staging`
already exists, the script prints that fact and exits — no delete,
no recreate. This keeps repeat invocations safe. Never touches the
source index in any way beyond a read.

---

## Deliberately non-decisions

Choices made without formal evaluation because either the alternative
was obviously worse or the cost of switching is trivial:

- **React + Vite + TypeScript** — matches Zohaib's existing frontend
  stack; no reason to introduce a new framework for a single-page chat
  UI.
- **Express 5 + tsx** — smallest reasonable Node stack; ESM
  end-to-end.
- **react-markdown for answer rendering** — the answer is Markdown by
  design; using anything else would require a manual renderer.
- **Chunker parameters (350 words, 50-word overlap)** — reasonable
  defaults from the RAG literature; regression suite passes, so no
  reason to sweep.
