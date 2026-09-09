# Portfolio RAG Assistant — Progress Snapshot

Snapshot date: 2026-09-09
Git state: committed as `951add8` ("feat: build end-to-end portfolio RAG assistant")
on `origin` = https://github.com/ZohaibRahim/portfolio-RAG-project.git
Working tree: clean.

This document tracks progress against the original 25-step deployment plan
so that a future session can pick up without re-deriving state. Items are
grouped by status and, for anything not yet finished, describe both the
current state and what specifically remains.

---

## Legend

- **Done** — implemented, verified, and referenced in the codebase.
- **Partial** — some of the work is in place but a concrete follow-up is
  still required before the item can be closed.
- **Not done** — no work exists in the repo for this item yet.

---

## Done (16 of 25)

Each item lists the file(s) or command that prove the state.

### 1. Hard-coded retrieval rules removed
- `grep -rE "isProfileOverviewQuestion|Profile question|Retrieval filter|Search filter|0\.75|scoreThreshold"`
  over `backend/src` returns **zero** matches.
- Retrieval is now generic: no code branches on employer, project, or
  question type.

### 2. Generic query-rewrite service
- `backend/src/services/queryRewriteService.ts` exists.
- Wired into `retrievalService.ts` at line 91, gated behind
  `env.queryRewriteEnabled`.
- No hard-coded question table; the model produces a search-oriented
  reformulation for any input.

### 3. Recall-heavy candidate pool
- `CANDIDATE_POOL_SIZE = 15` in `retrievalService.ts:37`.
- Sweep evidence (20 / 15 / 12 / 10) captured in
  `docs/design-decisions.md` under "Candidate pool size: 15".

### 4. Rerank service
- `backend/src/services/rerankService.ts` exists.
- Contract is the **v3 selection-only JSON array** — returns only the
  numbers of relevant candidates, in ranked order, empty array on
  nothing relevant.
- Deterministic `META_SECTION_BLOCKLIST` pre-filter drops README /
  license / contact chunks *before* the LLM sees them.
- 150-word truncation applied to candidate bodies for the rerank prompt
  only (full text still flows to the answer generator).

### 5. Clean `retrievalService.ts`
- Pipeline is now literally:
  `trim → (optional) rewrite → embed → dimension check → hybrid search → rerank`.
- Single public function `retrieveContext(question, topK)` — the rest of
  the app doesn't know about any of the stages.

### 6. Retrieval regression tests
- `backend/src/scripts/testRegression.ts` — 30-question suite.
- Result at last run: 30 / 30 hard passes.
- Referenced by all pool-size and reranker experiments in the design doc.

### 7. Unsupported-question handling (no RRF threshold)
- `ragService.ts:75` short-circuits when the reranker returns zero
  matches, responding with the canonical
  `"The portfolio does not contain enough information to answer that."`
- The old `0.75` RRF threshold is gone — the reranker's `[]` output is
  the relevance signal.

### 8. Citation validation
- `backend/src/services/citationService.ts` implements:
  1. Strip any `[N]` outside the range of chunks sent to the model
     (including preceding whitespace so sentences read cleanly).
  2. Prune the `sources` array to only the citations that survive in the
     sanitized text.
- Called at `ragService.ts:134`. Unit tests in
  `scripts/testCitationValidation.ts` — five cases, all pass.

### 9. Answer formatting
- System prompt in `chatService.ts` (lines 21, 30, 33–35) instructs:
  short paragraphs, bullets when enumerating, concise summaries for
  broad questions, one or two citations per paragraph.

### 11. Conversation behavior (V1 stateless)
- Each `POST /api/ask` is independent — no history passed. Decision was
  to ship single-turn V1 first; multi-turn follow-ups deferred to V2.

### 12. Development logging removed
- `Profile question`, `Retrieval filter`, `Search filter` strings all
  absent from `backend/src`. Only startup/error logs remain in
  `index.ts:262-272`.

### 13. Express hardening
- `helmet` with cross-origin resource policy relaxed for the React
  frontend.
- `cors` restricted to `env.allowedOrigin`.
- `express.json({ limit: "10kb" })` bounds body size.
- Per-IP rate limit: **20 requests / minute** on `/api/ask` only
  (`ASK_RATE_LIMIT_PER_MINUTE`, `index.ts:33`).
- Validation ladder in `askHandler`: string check → non-empty →
  ≤ 500 chars.
- Body-parser error middleware translates `entity.parse.failed` →
  400 "Invalid JSON body." and `entity.too.large` → 413.
- Centralized 500 handler logs server-side and returns only
  `{ "error": "An unexpected error occurred." }` — never leaks stack
  traces, provider names, or model names.
- `X-Powered-By` explicitly disabled.
- `/api/health` intentionally not rate-limited so external monitors are
  unaffected, and returns only `{ "status": "ok" }` — no provider info.

### 14. Provider configuration
- `env.aiProvider` toggle is the single switch.
- Every LLM-touching service (`chatService`, `queryRewriteService`,
  `rerankService`, `embeddingService`) routes on that value; no other
  code branches on provider.
- `embeddingService.getEmbeddingDimensions()` returns 1024 (Ollama) or
  1536 (Azure) and both the ingestion script and retrieval pipeline
  throw on mismatch.

### 15. Production rewrite / rerank strategy decided
- Decision captured in `docs/design-decisions.md` under "Production-only:
  reasoning effort per stage":
  - Query rewrite → `reasoning.effort: minimal`
  - Rerank → `reasoning.effort: minimal`
  - Answer generation → `reasoning.effort: low`
- `max_output_tokens` bumped from 700 → 1500 to leave room for reasoning
  tokens.

### 20. Basic abuse / cost protection (partial-complete — enough for V1)
- Rate limit ✅
- Question-length cap ✅
- `max_output_tokens` cap ✅
- Daily/monthly ceiling: still open (see "Partial" #20 below).

### React UX baseline (part of #10)
- `react-markdown` renders answers.
- Source cards render from the backend-pruned `sources` array — no
  client-side citation logic.
- Auto-scroll to newest message via `useRef` + `scrollIntoView`.
- Loading state disables input and shows three-dot "Searching portfolio"
  indicator.
- Enter-to-submit via native `<form onSubmit>`.
- Send button disabled when loading or the input is empty.
- Suggested-question buttons shown before the first message.
- Errors rendered inline via `role="alert"`.
- External links from Markdown opened with `target="_blank" rel="noopener noreferrer"`.

---

## Partial (4 items — with specific remaining work)

### 10. React UX polish
**Done** — see "React UX baseline" above.

**Still open:**
- **Mobile responsiveness** has not been verified in-browser. Need to
  open the deployed (or dev) frontend on a phone-width viewport and
  check:
  - Message column width and horizontal-scroll behaviour of long code
    fences.
  - Source card wrapping — the current `.source-card` layout has not
    been stress-tested at < 400 px width.
  - Input row not overlapping the last message when the on-screen
    keyboard opens.
- **"Powered by RAG" / architecture disclosure element** was called out
  in the original plan as a way to make the bot legibly *not* a generic
  ChatGPT clone. No such element exists in `App.tsx` yet. Suggested
  placement: a small footer strip under the input, or an "About this
  assistant" toggle in the header.
- **Empty-state polish for zero-source answers** — when the reranker
  returns `[]`, the assistant message renders the canonical
  "not enough information" text but no visual cue distinguishes it from
  a normal cited answer. Consider a subtle icon or muted style.

### 16. Re-test Azure production pipeline
**Done** — the Azure code paths exist and typecheck; provider abstraction
was verified end-to-end when the pipeline was first built on Azure.

**Still open:**
- No fresh smoke test on the *current* code post-rerank / post-flag
  changes. Before deploying:
  1. Temporarily set `.env` to
     ```
     AI_PROVIDER=azure
     AZURE_SEARCH_INDEX_NAME=portfolio-chunks
     ```
  2. Run ~5 questions from the regression suite (mix of supported and
     unsupported).
  3. Verify citation validation still produces the same shape.
  4. Revert `.env` to Ollama.
- Do this on a bounded set (5 questions ≈ 15 LLM calls) to avoid
  burning student credit before the real deployment.

### 17. Broader end-to-end evaluation
**Done** — `testRegression.ts` covers 30 questions with hard-pass gates.

**Still open:**
- The plan called for 25–40 questions covering **labelled categories**:
  identity, employers, projects, technologies, metrics, dates,
  individual-vs-team attribution, vague queries, misspellings,
  completely unsupported.
- The current suite does not surface these as its own tags in the
  output, so you can't currently answer "how many misspelling cases pass
  vs fail" without re-reading each entry.
- Follow-up: add a `category` field per test case and print a per-category
  breakdown at the end of the run.

### 20. Abuse / cost protection — daily ceiling
**Done** — per-IP rate limit + length cap + output-token cap.

**Still open:**
- No **global daily usage ceiling**. A determined attacker or a viral
  moment could still rack up Azure spend within per-IP quotas.
- Proposed minimum:
  - Track cumulative `max_output_tokens` served per UTC day in an
    in-memory counter.
  - When the ceiling is hit, return the canonical "not enough
    information" answer (or a dedicated "assistant paused for the day"
    string) without calling any LLM.
  - Log the shutoff once so you notice.
- For a horizontally-scaled deploy this would need a shared store, but
  V1 is single-instance so an in-process counter is sufficient.

### 22. Repository hygiene
**Done** — `.gitignore` excludes `.env`, `.env.*`, `node_modules`, `dist`,
OS junk. `.env.example` present with safe placeholders. Initial commit
`951add8` pushed to `origin` (GitHub).

**Still open:**
- `backend/src/scripts/` currently mixes real tools (`ingestKnowledge`)
  with ad-hoc test harnesses (`testChunking`, `testContext`,
  `testEmbedding`, `testKnowledge`, `testRag`, `testRetrieval`,
  `testSearchUpload`). Decide which are worth keeping and either:
  - promote survivors to `backend/src/scripts/` with clear names, or
  - move one-off spikes to `backend/src/scripts/spikes/` (still
    committed but obviously non-canonical), or
  - delete the ones that only existed to debug a bug that is now fixed.
- Add each survivor to `package.json` `scripts` entries so they have
  documented invocations.

---

## Not done (5 items)

### 18. Deploy backend
- Hosting SKU not chosen. Originally the plan called for Azure App
  Service; the plan itself flagged that we should verify current
  pricing / free tiers first to avoid a silently-billed instance.
- Alternatives worth pricing before choosing:
  - Azure App Service (B1 / Free F1)
  - Azure Container Apps (scale-to-zero)
  - Render / Railway / Fly.io free tiers
- Production secrets must be set in the hosting environment — do not
  commit `.env`.
- CORS `ALLOWED_ORIGIN` will need to be updated to the Vercel domain at
  cutover.

### 19. Deploy React frontend to Vercel
- Blocked on #18 (need the backend URL for `VITE_API_BASE_URL`).
- Steps:
  1. `vercel` project pointed at `frontend/`.
  2. Set `VITE_API_BASE_URL` env var to the deployed backend URL.
  3. Update backend `ALLOWED_ORIGIN` to the Vercel domain.
  4. Verify CORS with a browser-side call, and confirm the source cards
     still render.

### 21. CI/CD
- No `.github/workflows/` directory in the repo.
- Minimum viable pipeline (single workflow file):
  - Trigger on push and pull_request to `main`.
  - Job 1: `cd backend && npm ci && npx tsc --noEmit`
  - Job 2: `cd frontend && npm ci && npx tsc --noEmit && npm run build`
- Optional additions:
  - Run `testCitationValidation.ts` (fast, no network).
  - Skip `testRegression.ts` in CI (requires Ollama or Azure keys).
  - Auto-deploy on push to `main` once #18 / #19 are wired.

### 23. Final README
- `README.md` is currently 0 bytes.
- Contents to write:
  - Problem statement — what this bot answers and for whom.
  - Architecture diagram (see #24).
  - Local vs production provider strategy (Ollama / Azure).
  - Tech stack list.
  - RAG flow — the same pipeline described in `design-decisions.md` but
    at the summary level.
  - Setup instructions for both providers.
  - Screenshots of the deployed UI.
  - Live URL(s) once #18 / #19 land.
  - Limitations and future improvements (V2 conversation memory, larger
    knowledge base, structured evaluation dashboard).

### 24. Architecture diagram
- Not present in `docs/`. Should visualise:
  - Request path: React → Express → Query rewrite → Embed → Azure
    Hybrid → Rerank → Grounded LLM → Citation validation → Response.
  - Provider abstraction: same code paths, different targets
    (Ollama-dev / Azure-prod) selected by `env.aiProvider`.
- Format decision open — SVG in-repo, or Mermaid in the README, or a
  rendered PNG under `docs/images/`. Mermaid inside the README is the
  lowest-friction option since GitHub renders it natively.

### 25. Resume / portfolio blurb
- Blocked on #18 / #19. Once the app is live and stable, write the
  one-paragraph description that can go on the resume and portfolio
  site — e.g. "deployed RAG assistant using React, Node.js/TypeScript,
  Azure AI Search, Azure OpenAI, hybrid retrieval, LLM reranking,
  grounded citations, and local Qwen inference for cost-efficient
  development."

---

## Suggested next-session order

1. **Docs first** (cheap, unblocks the resume line):
   - Write `README.md` (#23).
   - Add the Mermaid architecture diagram inside it (#24).
2. **CI** (~15 minutes): add `.github/workflows/typecheck.yml` for both
   packages (#21).
3. **Azure smoke test** (#16): bounded 5-question run to confirm the
   production provider still works on the current code.
4. **Deploy backend** (#18), then **Vercel** (#19), then swap
   `ALLOWED_ORIGIN` / `VITE_API_BASE_URL`.
5. **Daily-ceiling protection** (#20 tail) — land before the public URL
   is shared anywhere.
6. **UX polish** (#10 tail) — mobile check + "Powered by RAG" element.
7. **Regression suite category tags** (#17 tail).
8. **Scripts cleanup** (#22 tail).
9. **Resume line** (#25).

---

## Reference — key files as of this snapshot

| File | Role |
|---|---|
| `backend/src/services/retrievalService.ts` | Two-stage retrieval coordinator |
| `backend/src/services/queryRewriteService.ts` | Stage 0: LLM query rewrite |
| `backend/src/services/embeddingService.ts` | Provider-agnostic embeddings + dimension check |
| `backend/src/services/searchService.ts` | Azure hybrid (BM25 + vector) call |
| `backend/src/services/rerankService.ts` | Meta-filter + LLM rerank (v3 contract) |
| `backend/src/services/chatService.ts` | Grounded answer generation |
| `backend/src/services/citationService.ts` | Post-generation citation sanitisation |
| `backend/src/services/ragService.ts` | Public `answerQuestion()` pipeline |
| `backend/src/index.ts` | Express app: helmet, CORS, rate limit, validation, error handler |
| `backend/src/config/env.ts` | Provider + feature-flag config |
| `backend/src/scripts/testRegression.ts` | 30-question retrieval regression |
| `backend/src/scripts/testCitationValidation.ts` | Citation-validation unit checks |
| `frontend/src/App.tsx` | Chat UI, source cards, auto-scroll, loading state |
| `docs/design-decisions.md` | Rationale + benchmarks for the major choices |
| `docs/progress.md` | This document |
