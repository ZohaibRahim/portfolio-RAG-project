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
| Rerank | `minimal` | Constrained selection from a numbered list |
| Answer generation | `low` | Enough headroom to apply grounding, citation, and formatting rules; not enough to trigger an expensive deep-think loop |

Reasoning tokens count against `max_output_tokens`, so the chat stage's
cap was bumped from 700 → 1500 to leave room for both reasoning and
the visible answer.

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
