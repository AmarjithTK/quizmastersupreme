# REVAMP-PLAN — Full simplification & generation-method revamp

Status: **IMPLEMENTED — all phases landed, 259 tests green.**
Audience: the one person whose time this saves. Read §0 for the why, §1 for the target, then §10 for what actually shipped.

---

## 0. Goals — the exact complaints this plan kills

| # | Complaint (user's words, condensed) | Root cause found (file:line) | Fix in phase |
|---|---|---|---|
| G1 | "Ask for 10 questions, get ~3" | `max_tokens: 8000` hard-coded (`pipeline.ts:292`, `provider.ts:128`) + single call + **zero backfill** + duplicates *kept*, not filtered (`ingestStage`) | **P1** |
| G2 | "Added to a set but quiz says individual questions not published" | `loadSetQuestionIds` serves only `status='published'` (`engine.ts:181`); promote creates `approved` not `published` (`pipeline.ts:690`); set-membership search filters `status=published` (`SetQuestionsManager.tsx:83`) | **P0** |
| G3 | "The system is over-complicated — topic → sets → questions should be it" | 8 question statuses (`schema/questions.ts:73`), shadow candidate state machine (`ai_candidates` × 3 sub-statuses), 3-layer dedupe + retroactive sweep + triage UI, 9 admin pages / 44 API routes | **P2 + P3** |
| G4 | "Models I use have 1M context, 125k–300k output — revamp the method" | Generation budget is an *artificial* 8k ceiling, not a model limit; no model-aware output budget; cost table wrong (`provider.ts:62-64`) | **P1** |

Non-negotiable invariants preserved (do NOT touch):
- Quiz engine: resume, server-owned clock, answer secrecy (§2.6), idempotent answers, single in-progress attempt.
- Content tree is exactly 2 levels (category → set → questions).
- Every question write goes through `createQuestion()` = validate + dedupe funnel (§2.9).
- Job durability: a generation survives a closed browser tab (D1 job row + R2 raw response).

---

## 1. Target architecture (what we converge to)

```
CATEGORY (subject)
  └── QUIZ SET (published = visible & playable)
        └── QUESTIONS  status ∈ {active, rejected, archived}
```

**Playability rule (replaces the whole publish maze):**
> A question is playable **iff** `status = active` **and** it is attached to a `published` set.
> Adding a question to a published set makes it playable the same second. Nothing else gates it.

**Generation contract (replaces the "pray for N" method):**
> `POST generate {count: N}` returns **exactly N fresh questions** (after auto-dedupe against the whole bank), or a truthful shortfall report: *"asked 10, delivered 10, 2 duplicates skipped, 0 re-asked"*.
> One big LLM call sized to the model's REAL output budget; backfill rounds top up to N when dedupe/validation attrition happens.

**Working set (replaces the review-queue database):**
> One simplified `ai_candidates` row per generated question (no status machines, no dedupe columns, no promote step). "Reject" = skip it at commit. Commit = the whole kept set is inserted **as `active` questions** and attached to the chosen Q Set in one call.

---

## 2. Phase 0 — Playability fix (kills G2). Small, safe, do first.

Change one filter, two write-targets, one copy string.

| File | Change |
|---|---|
| `src/modules/quiz/engine.ts:181` | `loadSetQuestionIds`: replace `eq(questions.status, "published")` with `notInArray(questions.status, ["rejected", "archived", "duplicate"])` (pre-collapse) → `eq(status,"active")` after P2. Empty-set error message stays. |
| `src/modules/ai/pipeline.ts` `promoteCandidate` (line ~690) | default status `"approved"` → `"published"` (pre-collapse) → `"active"` after P2. |
| `src/components/admin/SetQuestionsManager.tsx:83,211` | search filter `status: "published"` → `status: "active"` (pre-collapse: `"published"` stays correct for existing data; switch with P2). Placeholder + empty-state text stop claiming "Only PUBLISHED questions can be added". |
| `src/modules/catalog/service.ts` (optional) | nothing — set/category publish stays as-is (that's the user's own stated flow). |

**Verify:** `pnpm typecheck`, `pnpm test` (quiz-engine + ai-pipeline tests touching `published` still pass because we *widened* the filter), manual: generate → commit to a published set → play the quiz.

---

## 3. Phase 1 — Generation method revamp (kills G1 + G4). The headline change.

### 3.1 Model-aware output budget (new file `src/modules/ai/budget.ts`)

Per-model `max output tokens` map — what OpenRouter clamps `max_tokens` to:

| Model prefix | max_output_tokens (budget cap) | source |
|---|---|---|
| `deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4-flash-0731` | **96_000** | V4.1 Flash spec: 1M ctx, 125k+ output → request 96k, comfortably inside |
| `deepseek/deepseek-chat-v3*` | 96_000 | V3.x family |
| `anthropic/claude-sonnet-4*`, `claude-opus-4*` | 64_000 | Sonnet 4.5 = 64k |
| `anthropic/*haiku*` | 8_000 | Haiku 3.5 = 8k |
| `openai/gpt-4o*` | 16_000 | 4o-mini = 16k |
| `google/gemini-2.0-flash*` | 8_000 | Gemini 2.0 Flash = 8k |
| `meta-llama/llama-3.3-70b*` | 4_000 | OpenRouter cap |
| unknown model | 16_000 | conservative fallback; backfill covers truncation |

Per-question token allowance ≈ **850** (stem 150 + 4 options 120 + explanation 80 + backstory 350 + JSON 60 + headroom 90), measured over real output in P1.

```
budget(count, model) = clamp(ceil(count × 850 × 1.15), min=8_000, max=modelCap)
```
- N=10 → ~10k · N=25 → ~25k · N=50 → ~50k — **single call** on DeepSeek.
- Small-cap models (llama 4k, haiku 8k) truncate per call → **backfill** (§3.2) tops them up across rounds. Honest limits, no lying.

### 3.2 Backfill loop to the exact count (`pipeline.ts` rewrite of `generateStage`/`ingestStage`)

```
round = 1
remaining = requestedCount
accepted = []
while remaining > 0 and round ≤ MAX_BACKFILL_ROUNDS (3):
    call(model, count=remaining, digest = bankDigest + concepts(accepted))   # digest grows so the model does NOT re-ask
    parse → validate each candidate                                   # existing parse.ts + validation.ts
    for each valid candidate:
        verdict = checkCandidates(...)                                # existing dedupe funnel
        if verdict.autoReject OR verdict.bestMatch ≥ jaccardReject:    # EXACT + NEAR = auto-dropped
            duplicates++ ; continue
        accepted.push(candidate)
    remaining = requestedCount - accepted.length
    round++
store working set + job counters {requested, produced, fresh: accepted, duplicates}
if produced < requested → job.status = "partial" with honest reason ("bank already covers this topic" / "model cap")
```

Key detail: **the round-2+ digest includes what round 1 already accepted**, so backfill rounds generate *different* concepts — this is what makes "ask 10, get 10 *fresh*" true rather than "10 with repeats".

### 3.3 Auto-dedupe is filtration, not triage (kills the "duplicates flagged forever" debt)

- `ingestStage` stops *storing* flagged duplicates as reviewable candidates. Exact (`autoReject`) and near (`similarity ≥ jaccardReject`) are **dropped automatically**, counted, reported.
- `jaccardReject` stays a runtime setting (`app_settings`, `settings/index.ts`) — tuning doesn't need a deploy.
- The "possible duplicate? you decide" layer-2 band (`jaccardReview` … `jaccardReject`) stays **only** as an informational badge on the batch; it never blocks.

### 3.4 Direct-to-bank, one-click commit

- `commitJobToSet` (already exists, `pipeline.ts:874`) now inserts the kept working set **directly as `active` questions** — the human review on the BatchReview screen *is* the approval; there is no second promote/approve step. Uses the existing `createQuestion()` funnel (validate + dedupe again at insert, so anything the bank gained in between still gets caught).
- Result: **generate → review → Add to Q Set → publish the set (if new) → quiz works immediately.** The exact flow the user described.

### 3.5 Provider plumbing (`provider.ts`)

- `openRouterProvider.generate`: `max_tokens` = the budget from §3.1 (still per-request, default raised from 8000 → passes `request.maxTokens` unchanged — the budget arrives from the pipeline).
- Log lines (`provider.ts:93`) updated to show the real budget + model cap.
- `PRICE_PER_MILLION` (`provider.ts:62-64`): add
  `"deepseek/deepseek-v4-flash-0731": {input: 0.15, output: 0.60}` and
  `"deepseek/deepseek-v4.1-flash": {input: 0.15, output: 0.60}` (match the pasted spec). Keep `default: {3, 15}` as the honest fallback. 50-question batch ≈ 50k out + ~5k in ≈ **$0.03**. Recorded per job.

### 3.6 UI (`GenerationPanel.tsx`, `BatchReview.tsx`)

- Count selector: `[10, 15, 20, 25, 50]` (was 5–25) — models handle 50 in one call now.
- Delete the "Small batches dedupe better and fail cheaper. Max 25 per job." caveat → replace with "Ask for N, get N fresh — duplicates are filtered automatically."
- Progress line: *"asked 10 · delivered 10 fresh · 2 duplicates skipped · 0 re-asked"* (from job counters).
- Remove the "Review them → /admin/review" link (that page dies in P3).
- BatchReview: strip the "possible duplicate, you decide" alarm panel; duplicates are already gone; keep reject/keep per question + the single "Add kept set to a Q Set" action.

---

## 4. Phase 2 — Question lifecycle collapse 8 → 3 (kills G3a)

### 4.1 Target states

| Now (8) | Becomes | Meaning |
|---|---|---|
| `ai_draft`, `draft`, `review`, `approved`, `published` | **`active`** | in the bank; playable when attached to a published set |
| `duplicate`, `rejected` | **`rejected`** | excluded everywhere; kept only for provenance |
| `archived` | **`archived`** | soft delete |

### 4.2 Migration (one hand-written file, e.g. `migrations/0005_revamp.sql`)

SQLite cannot alter a CHECK → rebuild `questions` with the standard table-rebuild procedure:

```sql
PRAGMA foreign_keys = OFF;               -- D1 caveat: see risk R-mig below

CREATE TABLE questions_new ( /* same columns, minus simhash,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','rejected','archived')), */ );

INSERT INTO questions_new SELECT
  id, stem, stem_format, explanation, backstory, backstory_format,
  difficulty, topic, tags, year, source, source_url, exam_body, language,
  CASE status
    WHEN 'archived' THEN 'archived'
    WHEN 'rejected' THEN 'rejected'
    WHEN 'duplicate' THEN 'rejected'
    ELSE 'active'                       -- ai_draft, draft, review, approved, published
  END,
  normalized_hash, content_hash, origin, created_by, generation_job_id,
  approved_by, approved_at, created_at, updated_at
FROM questions;

DROP TABLE questions;
ALTER TABLE questions_new RENAME TO questions;
PRAGMA foreign_keys = ON;

-- recreate indexes (ix_questions_status, _topic, _normalized_hash,
--   _content_hash, _generation_job) and the FTS triggers
--   (questions_fts_ai/_au/_ad) — SQLite drops triggers with the table.
-- question_options keeps its FK on questions (rename preserves it).
```

Pre-checks in migration: existing rows' `status` values are all in the old CHECK (true by definition); `question_options` rows unaffected.

### 4.3 Code ripple (every `status` touchpoint, from the audit)

- `src/db/schema/questions.ts`: CHECK + `QuestionStatus` type → `'active' | 'rejected' | 'archived'`; drop `simhash` column.
- `src/modules/questions/service.ts`: `QUESTION_STATUSES` → 3 values; `questionRow` default `"active"`; `setQuestionStatus`/bulk keep the `approvedBy`/`approvedAt` stamping only for `active` transitions (attribution retained).
- `src/modules/quiz/engine.ts` → filter becomes `eq(status,"active")` (P0 widened filter collapses to this).
- `src/modules/questions/import.ts` + `app/api/admin/questions/import/route.ts:62`: allowed import statuses `["draft","published","review","approved"]` → `["active"]`.
- `app/api/admin/questions/route.ts:40` (create default), `export` (filter passthrough) — no logic change, types only.
- `src/components/admin/QuestionBank.tsx`: `STATUSES` list → `active/rejected/archived`; button groups: **Publish / Send to review / Back to draft** → **Reject / Restore / Archive**; status pill tones.
- `src/components/admin/QuestionImport.tsx:156-159`: status select → `Active` only (default).
- `src/modules/dedupe/layer1-exact.ts`, `backfill.ts` (if kept): `status` projection/filter updates.
- `src/modules/search/index.ts` if it filters on question status (audit result: it searches sets, not question status — no change).

### 4.4 Data implications

- Existing seed/import/attempt data: `status` values all map via the CASE above; attempts reference `question_id` (FK intact), answer history unaffected.
- Bulk-status UI (Publish/Review) becomes: Reject selected / Archive selected / Restore to active.

---

## 5. Phase 3 — Delete the shadow machinery (kills G3b)

### 5.1 `ai_candidates` simplified to a working set, not a state machine

| Column | Now | After |
|---|---|---|
| `reviewStatus` | pending/approved/rejected/merged/deferred | `pending` / `rejected` only (UI reject toggle) |
| `validationStatus`, `validationErrors` | pending/valid/invalid | **drop** — validation happens at insert via `createQuestion()` funnel; invalid entries never enter the working set |
| `dedupeStatus`, `dedupeLayer`, `dedupeBestMatchId`, `dedupeSimilarity`, `dedupeDetail`, `normalizedHash`, `simhash` | full triage model | **drop**; keep `matched_question_id` (nullable) to show "skipped duplicate → Q123" |
| `promotedQuestionId`, `reviewedBy`, `reviewedAt`, `reviewNote`, `batchIndex` | … | `batchIndex` keep; rest drop |
| `origin`/durability | — | job id + R2 raw response on the job row (already there) |

`ai_generation_jobs` gains `duplicateSkipped` counter (delta from P1) and keeps everything else (provenance, cost, coverage digest, provider routing).

### 5.2 Deletions (files/routes/pages)

**API routes**
- `app/api/admin/candidates/*` (route, `[id]/review`, `[id]/promote`, `bulk-review`) → replaced by `POST /api/admin/generation-jobs/[id]/commit` (kept, rewired) + reject toggle on `[id]/route.ts`.
- `app/api/admin/duplicates/*` (`route.ts`, `[id]/resolve`, `sweep`) → deleted.
- `app/api/admin/embeddings/route.ts` → deleted.

**UI**
- `src/components/admin/ReviewQueue.tsx` + `app/admin/review/page.tsx` → deleted (BatchReview is the review).
- `src/components/admin/DuplicateTriage.tsx` + `app/admin/duplicates/page.tsx` → deleted.
- Admin shell nav (`app/admin/layout.tsx` or page) drops Review / Duplicates links + pending badges (`pendingReviewCount`, `openDuplicateCount` callers).

**Modules**
- `src/modules/dedupe/sweep.ts`, `backfill.ts`, `embeddings.ts`, `vector-index.ts`, `layer3-semantic.ts`, `adapters.ts` (semantic part) → deleted from the module graph; `dedupe/index.ts` keeps `layer1-exact` + `layer2-text` + `simhash`-free funnel. (`simhash.ts` itself: after P2 dropped the column, remove `simhashHex` callers — service + pipeline.)
- If layer-3 is ever wanted again, the files are in git history — this is a functional delete, not a data destroy.

**Wait — semantic dedupe loss check:** layer 3 (`Vectorize` + Workers AI) was never wired in `wrangler.jsonc` anyway (bindings commented out); tests mock it. Layers 1–2 (exact hash + FTS/Jaccard) are the *entire* live funnel. No capability is lost.

### 5.3 What survives intentionally

`app/admin/audit` (cheap, useful), `app/admin/settings` (AI model + routing + thresholds), dashboards, search, CSV import/export, backups.

---

## 6. Phase 4 — Docs, tests, verification

### 6.1 Docs
- `PLAN.md`: rewrite §1.4 (#3 "AI never publishes" → "generation is the review"), §2.2 (the new playability rule + working-set model), §9.5/9.6 (Generate / Review queue → one screen), §12 (budget map, backfill, auto-dedupe), §13 (two-layer funnel), §20 roadmap.
- `MIGRATIONS.md`: register `0005_revamp.sql` + the rebuild/fallback note.
- `README.md`: status line → "simplified content pipeline; generate-to-set in one flow".
- `REVAMP-PLAN.md`: flip to *Implemented* with the actual diff summary.

### 6.2 Test impact matrix (from the audit — 112 `status`/dedupe references)

| Test file | Change |
|---|---|
| `ai-pipeline.test.ts` | P1: backfill-round test (stub returns 6 of 10 → second round tops to 10), maxTokens assertion → model-cap derived; P2: promote now `active` (line ~321), duplicates **dropped** not flagged (lines 265-301 rewritten) |
| `ai-coverage.test.ts` | digest still feeds rounds — extend with "round-2 digest includes accepted stems" |
| `quiz-engine.test.ts` | new invariant: **question attached to published set is playable with status `active` (and only `rejected`/`archived` excluded)** |
| `questions.test.ts` / `question-import.test.ts` | status expectations → `active`; unknown-status tests → `active/rejected/archived` only |
| `dedupe-layer2.test.ts` | sweep/triage/`listDuplicateFlags` expectations removed (function deleted) |
| `dedupe-layer3.test.ts` | **deleted** (layer 3 removed) — or kept as pure-utility if files retained; plan: delete |
| `db-invariants.test.ts` | table count 18 → **15** (drop `duplicate_flags`, `question_embeddings`; `ai_candidates` kept); add: CHECK rejects legacy status value |
| `backup-restore.test.ts`, `progress-dashboard.test.ts`, `catalog-admin.test.ts`, `search.test.ts` | status literal updates (`active`), no logic change |

New invariant tests to lock the user's two demands forever:
1. `generate-N-returns-N-with-backfill` (stub-enforced).
2. `attached-to-published-set-is-playable-without-per-question-publish` (engine-level).

### 6.3 Verification run
```
pnpm typecheck
pnpm db:migrate:local   (on a COPY of the dev DB first — see R-mig)
pnpm test
pnpm seed && pnpm dev   → manual smoke: generate 10 → add to set → play
pnpm db:backup / restore round-trip (test covers it)
```

---

## 7. Sequencing & rollback

Order is dependency-safe and each phase leaves the app green:
P0 (green, wide filter) → P1 (green, richer generation, old candidates still stored-flagged) → P2 (migration + collapse; P0 filter simplifies) → P3 (delete surfaces) → P4 (docs/tests). 
P1 and P2 are safe to land together; P3 is purely subtractive; P4 is paperwork.

Rollback: schema migration is the only irreversible step — hence the copy-first rule in §6.3 and the permissive-CHECK fallback below. Every code phase is a normal revert.

---

## 8. Risks & open decisions

- **R-mig (only real risk):** D1 may not allow `PRAGMA foreign_keys=OFF` inside a transactional migration; the rebuild `DROP TABLE questions` would then fail on the `question_options` FK. **Fallback (zero-risk):** write the migration with a permissive CHECK `('active','rejected','archived','ai_draft','draft','review','approved','published','duplicate')` — no rebuild at all; app solely writes the 3 new values; a cosmetic trim migration ships later if ever wanted. Decide at P2 execution; DB-invariant test enforces whichever lands.
- **Open decision — default model:** add `deepseek/deepseek-v4.1-flash` to `AI_MODEL_PRESETS` (yes, planned) and optionally make it `DEFAULT_AI_MODEL`/`DEFAULT_GENERATION_MODEL` in `settings/index.ts` + `wrangler.jsonc`. Recommend: yes — it's the model this revamp is sized for.
- **Open decision — near-duplicate band:** auto-drop at ≥ `jaccardReject` (0.85) and badge below it. If you'd rather auto-drop the whole review band too (≥0.65), it's a one-line threshold change — say the word.
- **What we deliberately keep:** set/category publish, audit log, N:M membership, coverage digest, FTS5, R2 archiving, all quiz-engine invariants.

---

## 9. File change register (complete list)

**Modified (12):** `src/modules/quiz/engine.ts`, `src/modules/ai/pipeline.ts`, `src/modules/ai/provider.ts`, `src/modules/ai/index.ts`, `src/modules/ai/adapters.ts` (trim), `src/modules/settings/index.ts` (presets + budgets), `src/modules/questions/service.ts`, `src/modules/questions/import.ts`, `src/db/schema/questions.ts`, `src/db/schema/ai.ts`, `src/modules/dedupe/index.ts`, `app/api/admin/questions/import/route.ts`

**Created (3):** `src/modules/ai/budget.ts`, `migrations/0005_revamp.sql`, `REVAMP-PLAN.md` (this file)

**Deleted (≈14):** `ReviewQueue.tsx`, `DuplicateTriage.tsx`, `app/admin/review/page.tsx`, `app/admin/duplicates/page.tsx`, `app/api/admin/candidates/*` (4 files), `app/api/admin/duplicates/*` (3 files), `app/api/admin/embeddings/route.ts`, `src/modules/dedupe/{sweep,backfill,embeddings,vector-index,layer3-semantic}.ts`

**UI reworked (4):** `GenerationPanel.tsx`, `BatchReview.tsx`, `QuestionBank.tsx`, `SetQuestionsManager.tsx`, `QuestionImport.tsx` (select)

**Tests reworked (≈12):** per §6.2 matrix.

**Docs (3):** `PLAN.md`, `MIGRATIONS.md`, `README.md` (+ this file).

---

## 10. Implementation record (what actually shipped)

All phases landed. Evidence:

- **Migration `0005_revamp_pipeline.sql`** applied to the dev D1 and replayed by the
  test setup. `questions` rebuilt (3 statuses, `simhash` dropped, indexes + FTS
  triggers recreated, FTS content rebuilt); `ai_candidates` rebuilt as a working set;
  `duplicate_flags` + `question_embeddings` dropped; `backfill_round` +
  `duplicate_skipped` added. The proven `PRAGMA foreign_keys=OFF` + `__new_` pattern
  from `0002` was used — no fallback needed.
- **Playability (G2):** `loadSetQuestionIds` now serves `status = 'active'` questions
  attached to the published set; commit inserts `active`; the membership search shows
  all active questions. Two new engine tests lock it (active plays with no per-question
  publish; an all-rejected set refuses to start).
- **Generation (G1 + G4):** `modules/ai/budget.ts` (per-model ceilings; DeepSeek 96k,
  Claude 64k, Llama 4k…), count-sized `max_tokens`, backfill rounds up to 3, duplicates
  auto-filtered via `isAutoFiltered()`, honest shortfall reporting. Provider pricing
  updated for DeepSeek V4.1 Flash ($0.15/$0.60). Default model is now
  `deepseek/deepseek-v4.1-flash` (settings + `wrangler.jsonc`).
- **Deletions (G3):** review queue, duplicate triage, embeddings backfill/vector index,
  layer-3 semantic dedupe, simhash, sweep, and their routes/pages/tests.
- **Tests:** 21 files, **259 passing** (was 270; the retired suites accounted for the
  difference and new budget/backfill/playability tests were added).
- **Docs:** this file, `PLAN.md` (banner + §1.4, §2.2, §6.2, §9.5–9.7, §12, §13),
  `MIGRATIONS.md`, `README.md`.

Remaining known limits: retrieval/verification is against local D1 only; the live
OpenRouter round-trip and a deployed Worker are still unverified (unchanged from before).
