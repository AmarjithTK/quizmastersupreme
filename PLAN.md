# Quiz Master Supreme — Master Build Plan

> **Status:** Draft v1 — awaiting sign-off on the Open Questions in §24
> **Date:** 2026-09-14
> **Product:** Quiz Master Supreme — a two-surface (user + admin) quiz platform with AI-assisted content generation
> **Deployment target:** Cloudflare Workers + D1
> **This document is the contract.** If a later idea conflicts with a rule in §2, the rule wins until the rule is explicitly amended here.

---

## Table of Contents

| # | Section |
|---|---|
| 0 | [How to use this document](#0-how-to-use-this-document) |
| 1 | [Product definition](#1-product-definition) |
| 2 | [Frozen design constraints](#2-frozen-design-constraints) |
| 3 | [Stack decision](#3-stack-decision) |
| 4 | [System architecture](#4-system-architecture) |
| 5 | [Repository layout](#5-repository-layout) |
| 6 | [Data model](#6-data-model) |
| 7 | [Domain modules](#7-domain-modules) |
| 8 | [User-facing screens](#8-user-facing-screens) |
| 9 | [Admin screens](#9-admin-screens) |
| 10 | [HTTP API surface](#10-http-api-surface) |
| 11 | [Quiz engine](#11-quiz-engine) |
| 12 | [AI generation pipeline](#12-ai-generation-pipeline) |
| 13 | [Duplicate detection engine](#13-duplicate-detection-engine) |
| 14 | [Local development](#14-local-development) |
| 15 | [Cloudflare deployment](#15-cloudflare-deployment) |
| 16 | [Security](#16-security) |
| 17 | [Performance and cost budgets](#17-performance-and-cost-budgets) |
| 18 | [Testing strategy](#18-testing-strategy) |
| 19 | [Observability](#19-observability) |
| 20 | [Milestone roadmap](#20-milestone-roadmap) |
| 21 | [v0.1 definition of done](#21-v01-definition-of-done) |
| 22 | [Risk register](#22-risk-register) |
| 23 | [Backlog (explicitly deferred)](#23-backlog-explicitly-deferred) |
| 24 | [Open questions — decisions requested](#24-open-questions--decisions-requested) |
| 25 | [Appendices](#25-appendices) |

---

## 0. How to use this document

**For the human:** §2 and §24 are the parts that need your attention. Everything else is downstream engineering that follows mechanically once those are settled.

**For a coding agent picking this up:** work the milestones in §20 **in order, one milestone per task**. Do not start milestone N+1 while N's "Exit test" fails. Each milestone is scoped to be independently verifiable. §2 contains hard constraints — violating them is a bug even if the feature works.

**Amendment rule:** changing §2 requires editing this file with a dated changelog entry in §25.6. Don't quietly diverge.

### 0.1 Build status

| Milestone | Status |
|---|---|
| **M0 — Foundation and risk spike** | ✅ **Done and verified** (local). Committed as `6ea6303`. |
| **M1 — Auth and roles** | ✅ **Done and verified** (local). Committed as part of the M1 commit. Google-only login, sessions in D1, admin role gate. The live Google round-trip needs real OAuth credentials. |
| **M2 — Categories** | ✅ **Done and verified** (local). Admin CRUD at `/admin/categories`, validation, slug conflicts, reorder, publish/draft, archive, audit trail. Verified live: create→publish→home grid, 401 without session, 409/422 on bad input. |
| **M3 — Quiz sets** | ✅ **Done and verified** (local). Admin CRUD at `/admin/sets` with subject picker, group labels, mode/difficulty/timer/limits, reorder, publish/draft, archive. **M3 exit test passed live:** 6 sets across 2 group labels in Biology → screen 2 renders 3 labelled sections in the right order. 12 new domain tests. |
| **M4 — Questions** | ✅ **Done and verified** (local). `createQuestion` funnel (validate → normalize → dedupe L1 → insert) used by every write path; question bank at `/admin/questions` with FTS5 search, filters, pagination, editor with live backstory preview; set membership at `/admin/sets/:id/questions` with attach/detach/reorder. **M4 exit test passed live:** 10 questions authored → attached in order → published → returned in insertion order, plus 409 on duplicates and 422 on each validation failure. `BackstoryRenderer` built and XSS-tested. Test count 73 → 100. |
| **M5 — Quiz engine** | ✅ **Done and verified** (local). Attempt lifecycle, answer-stripped payloads, idempotent submits, server-owned clock, server-side scoring, resume, and the runner + results UI. **M5 exit test passed live** through the real HTTP API: 10-question set end to end; the raw payload contains no `isCorrect`/`correctOptionKey`/`backstory`/`explanation`; re-submitting is idempotent; score maths correct; a finished attempt refuses further answers; a Multics backstory renders as a real `<table>` and `<blockquote>` on the results page. Test count 100 → 119. |
| **M6 — Resume, history, dashboard** | ✅ **Done and verified** (local). Account dashboard with totals, accuracy, sets completed and weakest topics; paginated history; per-set progress on the screen-2 cards; the "Continue" banner on screen 1. **M6 exit test passed live:** answered 5 of 10, re-posted the start endpoint (simulating a browser close) → same attempt id, `resumed: true`, exactly 5 stored answers, resuming at question 6. Two simultaneous starts produce one attempt (test §18.2 #3). Test count 119 → 129. |
| **v0.1 SHIP GATE** | ✅ **Met locally.** Admin creates category → set → questions → publish; a user takes the quiz, sees backstories, closes halfway, resumes, and sees accurate history. **Not yet exercised on a deployed Worker** — see the note below. |
| **M7 — Timer, mock & scoring polish** | ✅ **Done and verified** (local). Per-question timing is now measured **server-side** (the client's number is ignored — it is trivially inflatable, and it is shown back to the learner as a study signal) and capped at 15 min so walking away is not recorded as study. Accumulated `timeSpentMs` on the attempt; elapsed counter for untimed sets; low-time warning strip; sticky mobile status bar; time-on-task and per-question time on the results page. **M7 exit test passed live:** a real 30-second timed set expired **on its own with no backdating**, kept the answer given, recorded 33s of time on task, scored 20% with a passing verdict, and announced the previous attempt when the set was revisited. |
| **M8 — Analytics & search** | ✅ **Done and verified** (local). Day streak (bucketed in IST, counted from ANSWERS not logins), dashboard tiles, weak topics, per-set card progress, Continue banner. Public search: `/search` + `/api/search` find a **set by the text of a question inside it**, ranked by match count, published-only. New `modules/search` — a **documented exception** to §2.4 as the one read-only module allowed to span tables. Test count 129 → 144. |
| **M9 — Admin scale-up** | ✅ **Done and verified** (local). CSV **import with a dry run** and a per-row report (created / duplicate / duplicate-in-file / invalid-with-reasons — nothing dropped silently), CSV **export** with the importer's exact columns and a spreadsheet formula-injection guard, **bulk status** changes with a select-all bar, and an **audit log view** at `/admin/audit`. **M9 exit test passed live:** 500 rows imported in ~3.4s, every one reported, re-import reported all 500 as duplicates. Test count 144 → 174. |
| **M10 — AI generation** | ✅ **Done and verified** (local, with a **stub provider**). Provider abstraction (OpenRouter client + injectable `fetch`), a repair chain for the ways models actually misbehave (prose wrapping, fences, trailing commas, truncation mid-array), per-candidate validation, candidate-time dedupe, a review queue, and promotion through `createQuestion`. **§2.2 enforced structurally:** nothing in `modules/ai` writes to `questions`, and the liveliest assertion is that a full generation run leaves the questions table unchanged. **Design deviation:** vinext owns the Worker entry and has no `queue()` hook, so jobs advance in **two bounded steps** driven by the UI instead of a Queue consumer — this still meets §2.8 (no request owns the job, survives a closed browser, retryable). Test count 174 → 199. |
| **M11 — Dedupe layer 2** | ✅ **Done and verified** (local). FTS5 (bm25-ranked) candidate retrieval + Jaccard token overlap, thresholds in `app_settings` so they tune without a deploy, a retroactive **bank sweep** recording `duplicate_flags` in canonical pair order, and a **triage UI** at `/admin/duplicates`. **Layer 2 flags; it never auto-rejects** (§13.6). **M11 exit test passed live:** the sweep flagged the planted pair at 100% *and* caught a real seeded pair at 80% — "In which year was the WWW invented?" vs "Who invented the WWW?" — which a naive dedupe would have destroyed. Both questions survived triage untouched. Test count 199 → 223. |
| **M12 — Dedupe layer 3** | ✅ **Done and verified** (local, with an **injected** embedder and vector index). Workers AI + Vectorize adapters, a metadata filter pushed INTO the index (post-filtering a topK list silently loses matches as a bank grows), re-embedding gated on `content_hash`, and a **backfill** that proves the index is disposable. **§2.3 verified:** the test destroys the index, rebuilds it from D1 alone, and layer 3 works again. Degrades to layers 1–2 with `degraded: ["semantic"]` when the bindings are absent (§13.8) — never silently "clean". **Honest limitation:** the real Workers AI / Vectorize round trip is NOT verified; it needs those resources provisioned. The bindings stay commented in `wrangler.jsonc` so local dev cannot break. Test count 223 → 241. |
| **M13 — Coverage-aware generation** | ✅ **Done and verified** (local; the duplicate-rate half of the exit test needs a real LLM and is **not verified**). `buildCoverageDigest` (retrieve → extract → compress), digest persisted on the job, `preview-digest` admin endpoint, token budget enforced with explicit truncation, and **prompt-acceptance reporting** at `/admin/generate` (approved ÷ decided, by `prompt_version`; pending/deferred excluded from the denominator so a long queue cannot fake a bad prompt). **Two-pass retrieval, precision first:** an exact `topic`-tag match wins, and the FTS5 top-up is **conjunctive** (AND, not the default OR) — live verification caught it pulling "the Solar System" questions into an "Operating Systems" digest, and the fix removed them. Test count 241 → 262. |

M0 delivered: the full 17-table schema with both migrations, a local D1 workflow
(generate → migrate → seed → query), the domain module layout, screens 1 and 2
rendering live D1 data, normalization + SimHash, a `/api/health` probe with real
database connectivity, and **37 passing tests** that pin the §2 constraints.

**M1 delivered** (plus migration `0002`): Google OIDC authorization-code + PKCE
flow with state single-use storage, ID-token verification against Google's JWKS
(via `jose`), D1-backed sessions (sha256-stored tokens, 30-day sliding expiry,
HttpOnly + SameSite=Lax cookies), bootstrap admin via `ADMIN_EMAILS`, and the
user/admin role gates. **61 tests passing.** The full live round-trip (real
Google → callback) still needs OAuth client credentials (D-4 in §24).

Deviations from this document, recorded rather than hidden:

1. **Layout uses a root `app/` directory** (the scaffolder's convention) with all
   domain code under `src/`, instead of `src/app/`. Same structure, one level up.
2. **Only the D1 binding is active** in `wrangler.jsonc`; R2, Queues and Vectorize
   are present but commented out. Wiring unprovisioned bindings breaks local dev
   for no benefit before M10/M12.
3. **SimHash uses word unigrams, not token 3-grams**, with a measured threshold of
   16 rather than 6 — see the revision note in §13.3. The original figure was
   wrong for short question stems and measurement caught it.
4. **Normalization preserves Unicode Marks (`\p{M}`)**, not just Letters. Indic
   vowel signs and anusvaras are Marks; omitting them silently corrupts Malayalam
   stems. A regression test guards this.
5. **Seeding writes questions directly** rather than through
   `modules/questions.createQuestion()`, which does not exist until M4. The hashes
   are computed exactly as that funnel will compute them, so no migration is needed
   when the funnel lands.
6. **Auth is direct Google OIDC, not Firebase** (decision D-2 + follow-up). Firebase
   would still have needed our own `users` table for roles, so it added a vendor
   without removing a layer. **Consequence: D-1 is moot** — no password hashing
   means the Workers Free 10 ms CPU cap no longer blocks auth; the app can run on
   the $0 tier until scale justifies Paid (see §17.9).
7. **`users` gained Google OIDC columns and an `oauth_states` table** via migration
   `0002` — `password_hash` stays as a NULLABLE column (future email+password
   path) rather than being dropped.
8. **Deep tests use a `setDbForTests` seam instead of `@cloudflare/vitest-pool-workers`.**
   Services run against a real local D1 without the Workers runtime; `cloudflare:workers`
   is stubbed in vitest with a throwing proxy so accidental `bindings()` calls in
   tests fail loudly. Simpler than the pool and exercises the actual migrations.

**Not yet verified: deployment.** No Cloudflare credentials were available in this
session, so M0's "deploys to a `*.workers.dev` URL" exit test and the remote-D1 FTS5
check remain **outstanding**. The M1 Google round-trip also needs real credentials.
Everything else passed locally.

---

## 1. Product definition

### 1.1 One-sentence description

Quiz Master Supreme is a quiz practice platform where a user picks a **subject card** from a home grid, picks a **question set** inside it, and takes a timed quiz with rich post-answer explanations — with progress that survives closing the browser, and an admin console where content and AI-generated questions are produced, deduplicated, reviewed, and published.

### 1.2 The two surfaces

| Surface | Route prefix | Who | Purpose |
|---|---|---|---|
| **User app** | `/` | Public + logged-in users | Browse, take quizzes, track history |
| **Admin console** | `/admin` | `role = 'admin'` only | Author content, generate with AI, review, publish |

### 1.3 The three screens that matter

```
SCREEN 1  →  Home: grid of category cards (the "what do you want to study" screen)
SCREEN 2  →  Category: grid of quiz set cards inside that one category
SCREEN 3  →  Quiz Runner: the actual activity (NOT a navigation level)
```

**There is no screen 4.** See §2.1.

### 1.4 What makes this product different from a generic quiz app

1. **Resume is a first-class feature, not a nice-to-have.** Answering 25 of 50 questions then closing the browser loses nothing. *(§11.4)*
2. **The backstory.** Every question carries a rich explanation surface — not a one-line "because it's B". *(§11.7)*
3. **The AI never publishes.** Generated content lands in a review queue, always. *(§2.2)*
4. **Duplicate suppression is a three-layer funnel**, not a vibe. *(§13)*

### 1.5 Explicit non-goals for v0.1

Leaderboards, social features, payments, mobile apps, real-time multiplayer, recommendations engine, automated fact-checking, PDF import, audio questions, adaptive difficulty. These are in §23 and stay there until v0.1 ships.

---

## 2. Frozen design constraints

These are the rules that prevent rework. They are cheap now and expensive later.

### 2.1 Constraint: The content tree is exactly two levels deep

```
CATEGORY  (depth 1 — appears on the home grid)
   └── QUIZ SET  (depth 2 — terminal; contains questions)
          └── QUESTIONS
```

**Forbidden forever:**
- Any `parent_id` column on categories.
- Any self-referencing hierarchy table.
- Any "sub-category", "sub-collection", or "folder" concept.
- An admin UI affordance that creates a third navigation level.

**Enforced by:**
- `quiz_sets.category_id` is `NOT NULL` — a set cannot float or nest.
- No hierarchy column exists anywhere. If someone later wants depth-3, they must amend this document first.
- A unit test asserts the schema contains no `parent_id` column. *(Yes, really. It's three lines of test and it stops the drift.)*

**Why:** this single rule removes complexity from routing, breadcrumbs, permissions, progress rollups, admin UI, search, and AI generation targeting. The user asked for it explicitly and it is the right call.

> **Note on "Tech Quiz → Kerala State → Mock Set 1":** this is **not** three levels. "Kerala State Mock Set 1" is the *title of a set*, not a container. Sets are flat siblings inside a category, distinguished by naming and `sort_order`. Grouping *within* the set grid is achieved with a lightweight `group_label` display field (e.g. `"Kerala State"`, `"Previous Year"`) that only affects visual sectioning — it has no schema depth and creates no route.

### 2.2 Constraint: AI output is never published content

```
AI_GENERATED → DRAFT → REVIEW_REQUIRED → APPROVED → PUBLISHED
```

Every AI-produced question lands in `ai_candidates` with `review_status = 'pending'`. A human action is the **only** path from candidate to `questions.status = 'published'`. There is no "auto-approve" flag, no `--yes` mode, no trusted-model bypass. If a future requirement wants bulk approval, it still requires a human click; bulk approval of a *filtered* list is acceptable, a background job that publishes is not.

### 2.3 Constraint: D1 is the source of truth; Vectorize is a disposable index

Questions, texts, and correctness live in D1 and only D1. Vectorize stores nothing but `vector_id → question_id` plus the vector itself.

**Consequence:** the Vectorize index can be deleted and rebuilt from D1 at any time. `question_embeddings.content_hash` tells us which rows need re-embedding. A backfill endpoint exists from day one of M12. If Vectorize turns out to be the wrong tool, it is swapped without touching the question bank.

### 2.4 Constraint: no module reaches into another module's tables

```
modules/ai          →  may call  modules/questions (public functions)
modules/ai          →  may NOT   SELECT from the questions table directly
modules/dedup       →  exposes   checkCandidate() and findSimilar()
modules/quiz        →  owns      attempts, answers, scoring
```

Cross-module communication happens through a module's `index.ts` service surface. This is what makes "replace the AI generator later" a real option instead of a slogan.

### 2.5 Constraint: every answer is persisted immediately and idempotently

An answer write happens on submit — not on quiz completion, not on a debounced flush. The write is an idempotent upsert keyed on `(attempt_id, question_id)`. Re-submitting the same answer twice changes nothing.

### 2.6 Constraint: the client never receives a correct answer it hasn't earned

Question payloads delivered before answering **omit** `is_correct` and omit `explanation`/`backstory`. Correctness and backstory are returned only in the response to a submitted answer. This is a security rule, not a UX preference — it stops the answers being readable from the network tab.

### 2.7 Constraint: platform bindings are accessed through one adapter file

All Cloudflare binding access goes through `src/lib/cloudflare/bindings.ts`. No other file imports `cloudflare:workers`. This is the escape hatch if we migrate from vinext to OpenNext (§3.3).

### 2.8 Constraint: long-running AI work never runs inside a page request

Generation of 50 questions can take minutes. It runs in a Queue consumer. The HTTP handler only enqueues and returns a job id.

### 2.9 Constraint: seeds must pass through the same validation as AI output

Question creation — manual, CSV import, or AI — all funnel through one `validateQuestion()` + `dedupe.check()` pipeline. There is no "trusted path" that skips dedupe.

---

## 3. Stack decision

### 3.1 The chosen stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Non-negotiable for a schema-heavy app |
| Framework | Next.js App Router (16.x) | Familiar, server components fit the read-heavy grid pages |
| Build/runtime toolchain | **vinext** (`create-vinext-app`) | Cloudflare's first-party Vite-based Next.js implementation; native Workers target |
| Styling | Tailwind CSS v4 | |
| Components | shadcn/ui (Radix primitives) | Copy-in components, no dependency lock, matches "simple but good enough" |
| Icons | `lucide-react` | Already in the default optimized-import list |
| Production DB | Cloudflare D1 | SQLite semantics; local dev is the same engine |
| Local DB | Local D1 via Wrangler (`--local`) | **Same engine as prod.** Not `better-sqlite3` — see §3.4 |
| ORM | Drizzle ORM + Drizzle Kit | Typed queries, real SQL migrations, first-class `drizzle-orm/d1` driver |
| Full-text search | D1 FTS5 | Confirmed supported; powers dedupe layer 2 and admin search |
| Queue | Cloudflare Queues | Required by §2.8 |
| File storage | Cloudflare R2 | Raw LLM payloads from day one; question images later |
| Vector index | Cloudflare Vectorize | Dedupe layer 3 |
| Embeddings | Workers AI (`@cf/baai/bge-m3`, 1024-dim) | No external key, runs in-platform |
| LLM generation | OpenRouter | One key, swappable models |
| Auth | Self-hosted cookie sessions, `users.role` | See §16.1 and the CPU caveat in §22 R-1 |
| Testing | Vitest + `@cloudflare/vitest-pool-workers`, Playwright | Tests run against real D1 bindings |
| Validation | Zod | One schema shared by forms, API, and the LLM output parser |

### 3.2 Why this stack satisfies "simple to implement and good enough"

Every piece is either first-party Cloudflare or a plain library. There is no Kubernetes, no separate API server, no Redis, no ORM magic. One Worker serves the app and the API; one D1 database holds everything; one queue runs generation.

### 3.3 The vinext risk, and the hedge

**Verified facts (2026-09-14):**

- `cloudflare/vinext` exists and is real — a Vite plugin reimplementing the Next.js API surface, with Workers as the primary target.
- The scaffolded project resolved **`vinext@1.0.0-beta.9`** (Vite 8.3, React 19.3, TypeScript 7.0). This is further along than the `v0.0.41` seen at drafting time — the beta line is a good sign, but it is still a beta.
- Its own README states: *"Under active development... it is not yet a drop-in replacement for every application or production workload. Expect compatibility gaps."*
- The same README explicitly recommends **[OpenNext](https://opennext.js.org/) as "the safer, more proven option"** for anyone who wants maturity.
- Known gaps include incomplete Cache Components / Partial Prerendering, no build-time image optimization, and native modules (`sharp`, `lightningcss`, `satori`) failing in App Router **development** mode.

> **M0 spike result: PASSED.** App Router dynamic routes, `force-dynamic` server
> components reading D1, Tailwind v4, lucide icons and route handlers all work
> under `vinext dev`. The hedge in §2.7 remains in place as insurance, but there
> is currently no reason to invoke it.

**Decision: use vinext, but write the app so it can run on either toolchain.**

Concretely, three hedges:

1. **Write vanilla App Router code.** No vinext-specific APIs except the bindings import, which is quarantined by §2.7.
2. **Keep `next` installed as a devDependency.** `vinext init` is non-destructive and preserves `next dev`. Scripts: `dev` (vinext), `dev:next` (Next.js). If vinext blocks us on a feature, we keep building on `next dev` and deploy later.
3. **M0 includes a spike** that exercises the exact features we depend on. If the spike fails, we switch to `@opennextjs/cloudflare` in M0 — when it costs an afternoon, not in M9 when it costs a rewrite.

**M0 spike checklist** (all must pass, or we switch to OpenNext):
- [ ] App Router dynamic route (`/category/[slug]`) renders server-side with D1 data
- [ ] Server Action writes to D1 and revalidates
- [ ] `middleware.ts` runs and can redirect an unauthenticated `/admin` request
- [ ] A route handler reads and writes cookies
- [ ] `import { env } from "cloudflare:workers"` exposes `DB` and `AI` bindings
- [ ] `pnpm build` + deploy succeeds and the deployed Worker serves the same pages
- [ ] Tailwind + a shadcn/ui component (Dialog, Select, Table) render without hydration warnings
- [ ] `lucide-react` icons render

**Do not build M9's features in vinext dev mode before this passes.**

### 3.4 Why local dev uses Wrangler's local D1, not `better-sqlite3`

Same SQLite engine, same migration files, same `wrangler d1 execute` command. `better-sqlite3` would mean a second driver, a second migration path, and a class of bugs that only appear in production. There is no upside.

**Confirmed bonus:** D1 supports **FTS5**, so full-text search works identically locally and in production — no "search works in dev, breaks in prod" trap.

---

## 4. System architecture

### 4.1 Module topology

```
                     QUIZ MASTER SUPREME
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
     USER SURFACE                              ADMIN SURFACE
        │                                           │
        │                                    ┌──────┴───────┐
        │                                    │              │
        │                              CONTENT TOOLS   AI FACTORY
        │                                    │              │
        │                                    │        ┌─────┴──────┐
        │                                    │        │            │
        │                                    │   GENERATION   DEDUPE
        │                                    │   PIPELINE     ENGINE
        │                                    │        │            │
        │                                    │        └─────┬──────┘
        │                                    │              │
        │                                    │        REVIEW QUEUE
        │                                    │              │
        └──────────────┬─────────────────────┴──────────────┘
                       │
                  QUIZ ENGINE
                       │
                   PROGRESS
                       │
                 ┌─────┴─────┐
                 │    D1     │  ← single source of truth
                 └─────┬─────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
    Vectorize        R2          Queues
   (disposable    (raw payloads,  (long AI
     index)        assets)         jobs)
```

### 4.2 Request flows

**Read path (grid render) — must be fast:**
```
Browser → Worker (RSC) → modules/catalog.listRootCategories()
                       → D1 (single indexed query)
                       → streamed HTML
```

**Answer path (the hot write) — must be reliable:**
```
Browser → POST /api/attempts/:id/answers
       → modules/quiz.submitAnswer()
       → validate attempt is in_progress and not expired
       → UPSERT quiz_attempt_answers (idempotent)
       → recompute counts inside a batch
       → return { isCorrect, correctOptionKey, explanation, backstory }
```

**Generation path (slow, async) — must not block:**
```
Admin UI → POST /api/admin/generation-jobs
         → validate brief, resolve coverage digest
         → INSERT ai_generation_jobs (status='queued')
         → enqueue message
         → 202 { jobId }

Queue consumer → OpenRouter (streaming)
              → parse + Zod validate
              → dedupe.check() per candidate
              → INSERT ai_candidates
              → UPDATE job (status='succeeded')

Admin UI → polls GET /api/admin/generation-jobs/:id
```

### 4.3 Trust boundaries

| Boundary | Rule |
|---|---|
| Anonymous → user routes | Read-only published content. No attempt writes. |
| User → own attempts | Can only read/write attempts where `user_id = session.user_id`. Enforced in the query, not in a UI check. |
| User → `/admin/*` | Blocked in middleware **and** re-checked in every admin route handler and server action. Never trust the middleware alone. |
| Admin → content | Every mutation writes an `audit_log` row. |
| Worker → OpenRouter | API key is a Worker secret. Never sent to the browser. |
| Worker → D1 | Parameterized queries only. No string-concatenated SQL, ever. |

---

## 5. Repository layout

> **As-built note:** the tree below shows `src/app/`. The scaffold put `app/` at the
> repository root instead and that convention was kept — Next.js/vinext place it
> there by default. Everything else matches: domain code in `src/modules/`, schema in
> `src/db/schema/`, bindings in `src/lib/cloudflare/`. Files marked ✅ exist today.

```
quizmaster-supreme/
├── PLAN.md                          # this document
├── README.md
├── package.json
├── wrangler.jsonc                   # bindings: D1, R2, Queues, Vectorize, AI
├── vite.config.ts                   # vinext() + cloudflare()
├── drizzle.config.ts
├── tsconfig.json
├── .dev.vars                        # local secrets (gitignored)
│
├── migrations/                      # D1 migrations (wrangler applies these)
│   ├── 0000_init.sql
│   ├── 0001_fts5.sql
│   └── ...
│
├── seed/
│   ├── categories.json
│   ├── sets.json
│   └── questions.json
│
├── scripts/
│   ├── seed.ts
│   ├── backfill-embeddings.ts
│   └── reindex-fts.ts
│
├── public/
│
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                       # SCREEN 1 — category grid
│   │   ├── category/[slug]/page.tsx       # SCREEN 2 — set grid
│   │   ├── quiz/[setId]/
│   │   │   ├── page.tsx                   # SCREEN 3 — runner shell
│   │   │   └── summary/page.tsx
│   │   ├── account/
│   │   │   ├── page.tsx                   # dashboard
│   │   │   └── history/page.tsx
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   └── register/page.tsx
│   │   ├── admin/
│   │   │   ├── layout.tsx                 # admin shell + guard
│   │   │   ├── page.tsx
│   │   │   ├── categories/
│   │   │   ├── sets/
│   │   │   ├── questions/
│   │   │   ├── generate/
│   │   │   ├── review/
│   │   │   └── duplicates/
│   │   └── api/
│   │       ├── auth/...
│   │       ├── categories/...
│   │       ├── sets/...
│   │       ├── attempts/...
│   │       ├── me/...
│   │       └── admin/...
│   │
│   ├── modules/                    # ← the domain. No React here.
│   │   ├── catalog/                # categories + sets
│   │   │   ├── index.ts            # public surface
│   │   │   ├── service.ts
│   │   │   ├── queries.ts
│   │   │   └── validation.ts
│   │   ├── questions/
│   │   │   ├── index.ts
│   │   │   ├── service.ts
│   │   │   ├── validation.ts
│   │   │   └── normalize.ts        # text normalization (shared with dedupe)
│   │   ├── quiz/                   # attempts, scoring, timing
│   │   │   ├── index.ts
│   │   │   ├── engine.ts
│   │   │   ├── scoring.ts
│   │   │   └── state-machine.ts
│   │   ├── progress/
│   │   │   ├── index.ts
│   │   │   └── stats.ts
│   │   ├── auth/
│   │   │   ├── index.ts
│   │   │   ├── password.ts
│   │   │   └── session.ts
│   │   ├── ai/
│   │   │   ├── index.ts
│   │   │   ├── provider.ts         # OpenRouter client
│   │   │   ├── prompts/
│   │   │   │   ├── system.ts
│   │   │   │   ├── generate.ts
│   │   │   │   └── compress-coverage.ts
│   │   │   ├── schema.ts           # Zod for LLM output
│   │   │   ├── pipeline.ts         # orchestrates the queue consumer
│   │   │   └── coverage.ts         # coverage digest builder
│   │   ├── dedupe/
│   │   │   ├── index.ts
│   │   │   ├── layer1-exact.ts
│   │   │   ├── layer2-text.ts      # FTS5 candidate search
│   │   │   ├── layer3-semantic.ts  # Vectorize
│   │   │   ├── simhash.ts
│   │   │   └── embeddings.ts
│   │   └── audit/
│   │       └── index.ts
│   │
│   ├── db/
│   │   ├── schema/                 # Drizzle table definitions, one file per table
│   │   ├── client.ts               # Drizzle over D1
│   │   └── types.ts
│   │
│   ├── components/
│   │   ├── ui/                     # shadcn/ui
│   │   ├── cards/
│   │   │   ├── CategoryCard.tsx
│   │   │   └── SetCard.tsx
│   │   ├── grid/
│   │   │   └── CardGrid.tsx        # shared 4-col responsive grid
│   │   ├── quiz/
│   │   │   ├── QuizRunner.tsx
│   │   │   ├── QuestionCard.tsx
│   │   │   ├── OptionList.tsx
│   │   │   ├── Timer.tsx
│   │   │   ├── ProgressBar.tsx
│   │   │   └── ResultSummary.tsx
│   │   ├── backstory/
│   │   │   ├── BackstoryRenderer.tsx   # ← its own component, on purpose
│   │   │   └── markdown.ts
│   │   └── admin/
│   │       ├── QuestionEditor.tsx
│   │       ├── CategoryForm.tsx
│   │       ├── SetForm.tsx
│   │       ├── GenerationForm.tsx
│   │       ├── CandidateReviewCard.tsx
│   │       └── DuplicateTriage.tsx
│   │
│   ├── lib/
│   │   ├── cloudflare/
│   │   │   └── bindings.ts         # THE ONLY file importing cloudflare:workers
│   │   ├── openrouter/
│   │   │   └── client.ts
│   │   ├── markdown/
│   │   ├── rate-limit.ts
│   │   └── result.ts               # Result<T,E> helpers
│   │
│   └── middleware.ts               # admin guard, session refresh
│
└── tests/
    ├── unit/
    ├── integration/                # against real local D1
    └── e2e/                        # Playwright
```

**The rule that matters:** `src/modules/**` contains zero React. Domain logic is testable without a DOM, and the UI can be redesigned without touching rules.

---

## 6. Data model

### 6.1 Entity relationships

```
                    users ─────────────┐
                      │                │
                      │                │
              auth_sessions            │
                                       │
   categories ──1:N──> quiz_sets       │
        │                  │           │
        │                  │           │
        │                  ├───N:M────┴──> questions ──1:N──> question_options
        │                  │        (question_set_questions)        │
        │                  │                                        │
        │                  │                             question_embeddings
        │                  │                                        │
        │                  │                                   [Vectorize]
        │                  │
        │             quiz_attempts ──1:N──> quiz_attempt_answers
        │                  │
        │                  └── user_set_stats (rollup)
        │
        └── ai_generation_jobs ──1:N──> ai_candidates
                                             │
                                             └── promotes to ──> questions

   user_question_seen   (cross-attempt question ledger, per user)
   duplicate_flags      (question ↔ question, layered)
   audit_log
   app_settings
```

### 6.2 Schema DDL

Migration `0000_init.sql`. Timestamps are **Unix epoch milliseconds as INTEGER** (D1/SQLite has no native datetime; integers sort and index correctly and avoid timezone ambiguity). Booleans are `INTEGER` 0/1.

```sql
-- =========================================================
-- USERS & AUTH
-- =========================================================

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  email_norm     TEXT NOT NULL UNIQUE,        -- lowercased, trimmed
  password_hash  TEXT NOT NULL,               -- PHC-style string: algo$params$salt$hash
  display_name   TEXT,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
CREATE INDEX ix_users_role ON users(role);

CREATE TABLE auth_sessions (
  id           TEXT PRIMARY KEY,              -- sha256 of the session token; raw token only in cookie
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT,
  ip_hash      TEXT
);
CREATE INDEX ix_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX ix_auth_sessions_expires ON auth_sessions(expires_at);

-- =========================================================
-- CONTENT — DEPTH 1 & 2 ONLY  (see §2.1)
-- =========================================================

CREATE TABLE categories (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  description   TEXT,
  icon          TEXT,                          -- lucide icon name, validated against an allowlist
  accent_color  TEXT,                          -- tailwind token or hex
  sort_order    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','published','archived')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX ix_categories_status_sort ON categories(status, sort_order);

CREATE TABLE quiz_sets (
  id                 TEXT PRIMARY KEY,
  category_id        TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  slug               TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  group_label        TEXT,                     -- DISPLAY ONLY grouping inside the set grid
  mode               TEXT NOT NULL DEFAULT 'practice'
                     CHECK (mode IN ('practice','mock')),
  difficulty         TEXT NOT NULL DEFAULT 'medium'
                     CHECK (difficulty IN ('easy','medium','hard','expert','mixed')),
  time_limit_seconds INTEGER,                  -- NULL = untimed
  question_limit     INTEGER,                  -- NULL = serve every attached question
  shuffle_questions  INTEGER NOT NULL DEFAULT 1 CHECK (shuffle_questions IN (0,1)),
  shuffle_options    INTEGER NOT NULL DEFAULT 0 CHECK (shuffle_options IN (0,1)),
  passing_percent    INTEGER CHECK (passing_percent IS NULL OR (passing_percent BETWEEN 0 AND 100)),
  sort_order         INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','published','archived')),
  published_at       INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (category_id, slug)
);
CREATE INDEX ix_quiz_sets_category ON quiz_sets(category_id, status, sort_order);
CREATE INDEX ix_quiz_sets_status ON quiz_sets(status);

-- =========================================================
-- QUESTIONS
-- =========================================================

CREATE TABLE questions (
  id                   TEXT PRIMARY KEY,
  stem                 TEXT NOT NULL,
  stem_format          TEXT NOT NULL DEFAULT 'markdown'
                       CHECK (stem_format IN ('plain','markdown')),
  explanation          TEXT,                   -- short "why" — one or two lines
  backstory            TEXT,                   -- the rich long-form panel
  backstory_format     TEXT NOT NULL DEFAULT 'markdown'
                       CHECK (backstory_format IN ('plain','markdown')),
  difficulty           TEXT NOT NULL DEFAULT 'medium'
                       CHECK (difficulty IN ('easy','medium','hard','expert')),
  topic                TEXT,
  tags                 TEXT,                   -- JSON array of strings
  year                 INTEGER,
  source               TEXT,
  source_url           TEXT,
  exam_body            TEXT,                   -- e.g. 'Kerala PSC', 'TCS IT Quiz'
  language             TEXT NOT NULL DEFAULT 'en',
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('ai_draft','draft','review','approved',
                                         'published','rejected','duplicate','archived')),

  -- dedupe support (see §13)
  normalized_hash      TEXT NOT NULL,          -- sha256 of normalized stem (layer 1)
  simhash              TEXT,                   -- 64-bit simhash, 16 hex chars (layer 2 assist)
  content_hash         TEXT NOT NULL,          -- sha256 of normalized stem+options+sorted (layer 1b)

  -- provenance
  origin               TEXT NOT NULL DEFAULT 'manual'
                       CHECK (origin IN ('manual','ai','import','seed')),
  created_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  generation_job_id    TEXT,                   -- FK added after ai_generation_jobs exists
  approved_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at          INTEGER,

  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX ix_questions_status ON questions(status);
CREATE INDEX ix_questions_topic ON questions(topic, difficulty);
CREATE INDEX ix_questions_normalized_hash ON questions(normalized_hash);
CREATE INDEX ix_questions_content_hash ON questions(content_hash);
CREATE INDEX ix_questions_generation_job ON questions(generation_job_id);

CREATE TABLE question_options (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_key  TEXT NOT NULL CHECK (option_key IN ('A','B','C','D','E')),
  body        TEXT NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0 CHECK (is_correct IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (question_id, option_key)
);
CREATE INDEX ix_question_options_question ON question_options(question_id, sort_order);

-- Enforce: at most ONE correct option per question, at the database level.
CREATE UNIQUE INDEX ux_question_options_single_correct
  ON question_options(question_id) WHERE is_correct = 1;

-- =========================================================
-- SET MEMBERSHIP  (a question can live in many sets)
-- =========================================================

CREATE TABLE question_set_questions (
  set_id      TEXT NOT NULL REFERENCES quiz_sets(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (set_id, question_id)
);
CREATE INDEX ix_qsq_set_order ON question_set_questions(set_id, sort_order);
CREATE INDEX ix_qsq_question ON question_set_questions(question_id);

-- =========================================================
-- ATTEMPTS & ANSWERS  (the resume engine — see §11.4)
-- =========================================================

CREATE TABLE quiz_attempts (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_id             TEXT NOT NULL REFERENCES quiz_sets(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'in_progress'
                     CHECK (status IN ('in_progress','completed','abandoned','expired')),

  question_order     TEXT NOT NULL,            -- JSON array of question ids, frozen at start
  option_order       TEXT,                     -- JSON map { questionId: [keys] } if shuffled

  total_questions    INTEGER NOT NULL,
  current_index      INTEGER NOT NULL DEFAULT 0,
  answered_count     INTEGER NOT NULL DEFAULT 0,
  correct_count      INTEGER NOT NULL DEFAULT 0,
  wrong_count        INTEGER NOT NULL DEFAULT 0,
  skipped_count      INTEGER NOT NULL DEFAULT 0,

  time_limit_seconds INTEGER,
  server_deadline_at INTEGER,                  -- started_at + limit; authoritative (§11.5)
  time_spent_ms      INTEGER NOT NULL DEFAULT 0,

  started_at         INTEGER NOT NULL,
  last_activity_at   INTEGER NOT NULL,
  completed_at       INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- THE RESUME CONSTRAINT: at most one in-progress attempt per user per set.
CREATE UNIQUE INDEX ux_attempt_active
  ON quiz_attempts(user_id, set_id) WHERE status = 'in_progress';

CREATE INDEX ix_attempts_user ON quiz_attempts(user_id, started_at DESC);
CREATE INDEX ix_attempts_set ON quiz_attempts(set_id);

CREATE TABLE quiz_attempt_answers (
  attempt_id          TEXT NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  question_id         TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  question_index      INTEGER NOT NULL,
  selected_option_key TEXT,                    -- NULL = skipped
  is_correct          INTEGER,                 -- NULL = skipped
  time_taken_ms       INTEGER NOT NULL DEFAULT 0,
  answered_at         INTEGER NOT NULL,
  client_seq          INTEGER,                 -- client ordering / replay detection
  PRIMARY KEY (attempt_id, question_id)        -- ← makes answer writes idempotent (§2.5)
);
CREATE INDEX ix_answers_attempt ON quiz_attempt_answers(attempt_id, question_index);

-- Cross-attempt ledger: "have I seen this question before?"
CREATE TABLE user_question_seen (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id     TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  times_seen      INTEGER NOT NULL DEFAULT 1,
  times_correct   INTEGER NOT NULL DEFAULT 0,
  last_is_correct INTEGER,
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX ix_uqs_user_recent ON user_question_seen(user_id, last_seen_at DESC);

-- Denormalized rollup so set cards render progress without scanning answers.
CREATE TABLE user_set_stats (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_id           TEXT NOT NULL REFERENCES quiz_sets(id) ON DELETE CASCADE,
  attempts_count   INTEGER NOT NULL DEFAULT 0,
  completed_count  INTEGER NOT NULL DEFAULT 0,
  best_correct     INTEGER NOT NULL DEFAULT 0,
  best_total       INTEGER NOT NULL DEFAULT 0,
  best_percent     REAL,
  questions_seen   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  INTEGER,
  first_completed_at INTEGER,
  PRIMARY KEY (user_id, set_id)
);

-- =========================================================
-- AI GENERATION  (§12)
-- =========================================================

CREATE TABLE ai_generation_jobs (
  id                 TEXT PRIMARY KEY,
  created_by         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  target_set_id      TEXT REFERENCES quiz_sets(id) ON DELETE SET NULL,

  brief              TEXT NOT NULL,            -- admin's natural-language instruction
  topic              TEXT NOT NULL,
  subtopics          TEXT,                     -- JSON array
  difficulty         TEXT,
  requested_count    INTEGER NOT NULL,
  avoid_topics       TEXT,                     -- JSON array

  provider           TEXT NOT NULL DEFAULT 'openrouter',
  model              TEXT NOT NULL,
  temperature        REAL,
  prompt_version     TEXT NOT NULL,

  coverage_digest    TEXT,                     -- exactly what was sent (§12.4)
  coverage_tokens    INTEGER,
  include_examples   INTEGER NOT NULL DEFAULT 0 CHECK (include_examples IN (0,1)),

  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','succeeded','partial',
                                       'failed','cancelled')),
  produced_count     INTEGER NOT NULL DEFAULT 0,
  valid_count        INTEGER NOT NULL DEFAULT 0,
  duplicate_count    INTEGER NOT NULL DEFAULT 0,

  prompt_tokens      INTEGER,
  completion_tokens  INTEGER,
  cost_usd           REAL,
  duration_ms        INTEGER,
  raw_response_key   TEXT,                     -- R2 object key
  error_code         TEXT,
  error_message      TEXT,

  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  finished_at        INTEGER
);
CREATE INDEX ix_jobs_status ON ai_generation_jobs(status, created_at DESC);
CREATE INDEX ix_jobs_creator ON ai_generation_jobs(created_by, created_at DESC);

CREATE TABLE ai_candidates (
  id                    TEXT PRIMARY KEY,
  job_id                TEXT NOT NULL REFERENCES ai_generation_jobs(id) ON DELETE CASCADE,
  batch_index           INTEGER,

  stem                  TEXT NOT NULL,
  options_json          TEXT NOT NULL,          -- [{ key, body }]
  correct_option_key    TEXT NOT NULL CHECK (correct_option_key IN ('A','B','C','D','E')),
  explanation           TEXT,
  backstory             TEXT,
  difficulty            TEXT,
  topic                 TEXT,
  tags                  TEXT,

  validation_status     TEXT NOT NULL DEFAULT 'pending'
                        CHECK (validation_status IN ('pending','valid','invalid')),
  validation_errors     TEXT,                   -- JSON array

  dedupe_status         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (dedupe_status IN ('pending','clean','exact_dup',
                                                 'near_dup','semantic_dup','error')),
  dedupe_layer          TEXT,
  dedupe_best_match_id  TEXT REFERENCES questions(id) ON DELETE SET NULL,
  dedupe_similarity     REAL,
  dedupe_detail         TEXT,                   -- JSON

  normalized_hash       TEXT,
  simhash               TEXT,

  review_status         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (review_status IN ('pending','approved','rejected',
                                                 'merged','deferred')),
  reviewed_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           INTEGER,
  review_note           TEXT,
  promoted_question_id  TEXT REFERENCES questions(id) ON DELETE SET NULL,

  created_at            INTEGER NOT NULL
);
CREATE INDEX ix_candidates_job ON ai_candidates(job_id, review_status);
CREATE INDEX ix_candidates_review ON ai_candidates(review_status, created_at DESC);

-- =========================================================
-- DEDUPE STATE  (§13)
-- =========================================================

CREATE TABLE duplicate_flags (
  id                 TEXT PRIMARY KEY,
  question_id        TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  matched_question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  layer              TEXT NOT NULL CHECK (layer IN ('exact','text','semantic')),
  similarity         REAL NOT NULL,
  detail             TEXT,
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','confirmed','dismissed','merged')),
  resolved_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at        INTEGER,
  created_at         INTEGER NOT NULL,
  UNIQUE (question_id, matched_question_id, layer),
  CHECK (question_id <> matched_question_id)
);
CREATE INDEX ix_dupflags_status ON duplicate_flags(status, similarity DESC);

CREATE TABLE question_embeddings (
  question_id   TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,
  dimensions    INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,                 -- re-embed only when this changes
  vectorize_id  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (question_id, model)
);

-- =========================================================
-- OPS
-- =========================================================

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,                   -- 'question.approve', 'category.delete', ...
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX ix_audit_actor ON audit_log(actor_id, created_at DESC);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                    -- JSON
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
```

### 6.3 Full-text search

Migration `0001_fts5.sql`. D1 supports FTS5 — this powers **dedupe layer 2** (§13.4) and admin question search (§9.4).

```sql
CREATE VIRTUAL TABLE questions_fts USING fts5(
  question_id UNINDEXED,
  stem,
  explanation,
  topic,
  tags,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
```

*(`porter` gives English stemming so "created"/"create" collide — exactly what we want for duplicate hunting. If Malayalam support becomes a requirement, drop `porter` and keep `unicode61`.)*

**Sync via triggers** (not external-content tables — trigger-maintained standalone is the most portable form and avoids rowid coupling with our TEXT primary keys):

```sql
CREATE TRIGGER questions_fts_ai AFTER INSERT ON questions BEGIN
  INSERT INTO questions_fts(question_id, stem, explanation, topic, tags)
  VALUES (new.id, new.stem, COALESCE(new.explanation,''), COALESCE(new.topic,''), COALESCE(new.tags,''));
END;

CREATE TRIGGER questions_fts_ad AFTER DELETE ON questions BEGIN
  DELETE FROM questions_fts WHERE question_id = old.id;
END;

CREATE TRIGGER questions_fts_au AFTER UPDATE ON questions BEGIN
  DELETE FROM questions_fts WHERE question_id = old.id;
  INSERT INTO questions_fts(question_id, stem, explanation, topic, tags)
  VALUES (new.id, new.stem, COALESCE(new.explanation,''), COALESCE(new.topic,''), COALESCE(new.tags,''));
END;
```

> **Verify in M0:** run `CREATE VIRTUAL TABLE ... USING fts5` against **both** local D1 and a real remote D1 database, then insert/search/reindex. FTS5 works on D1, but prove it in *this* project before building §13.4 on it. `scripts/reindex-fts.ts` exists as the repair tool and is exercised in the M0 spike.

### 6.4 Indexing notes

- The partial unique index `ux_attempt_active` is doing real work — it *is* the resume feature's integrity guarantee. Two concurrent "start quiz" requests cannot create two active attempts; the second gets a constraint violation which the service catches and converts into "return the existing attempt."
- The partial unique index `ux_question_options_single_correct` prevents a whole class of content bug at the storage layer.
- Composite `(category_id, status, sort_order)` covers the screen-2 query exactly.
- `user_set_stats` exists purely so screen 2 can show "76% complete · Best 42/50" on 60 cards in one query instead of 60 aggregate scans.

### 6.5 D1 constraints the schema respects

| Limit | Practical consequence in this design |
|---|---|
| ~100 bound parameters per query | Batch writes chunk at ≤ 90 rows. `insertAnswers` and candidate inserts must chunk. |
| ~100 KB max SQL statement | Seeding uses JSON files + batched inserts, never one giant `INSERT`. |
| No long interactive transactions | Multi-step writes use `db.batch([...])` (atomic, single round trip) rather than `BEGIN`/`COMMIT` across awaits. |
| Database size cap (10 GB paid tier) | 8k questions is a rounding error. Not a concern; revisit past ~1M questions. |
| Read replication lag | Use session bookmarks (`withSession`) where read-after-write matters, or just read from primary for attempt paths. |

---

## 7. Domain modules

Every module exposes a small `index.ts` and owns its tables.

### 7.1 `modules/catalog`

Owns `categories`, `quiz_sets`, `question_set_questions`.

```ts
// Public surface
listRootCategories(opts): Promise<CategoryCard[]>
getCategoryBySlug(slug): Promise<Category | null>
listSetsForCategory(categoryId, opts): Promise<SetCard[]>
getSetById(id): Promise<QuizSet | null>
createCategory(input, actor): Promise<Category>
updateCategory(id, patch, actor): Promise<Category>
reorderCategories(idsInOrder, actor): Promise<void>
createSet(input, actor): Promise<QuizSet>
updateSet(id, patch, actor): Promise<QuizSet>
attachQuestions(setId, questionIds, actor): Promise<{ added: number; skipped: number }>
detachQuestions(setId, questionIds, actor): Promise<void>
reorderSetQuestions(setId, orderedQuestionIds, actor): Promise<void>
```

`SetCard` is the shape screen 2 renders and includes progress when a user is present:

```ts
type SetCard = {
  id: string; slug: string; title: string; groupLabel: string | null;
  questionCount: number; timeLimitSeconds: number | null; mode: 'practice' | 'mock';
  progress?: { answered: number; total: number; percent: number; bestPercent: number | null; isComplete: boolean };
};
```

### 7.2 `modules/questions`

Owns `questions`, `question_options`.

```ts
createQuestion(input, actor): Promise<Result<Question, ValidationError[]>>
updateQuestion(id, patch, actor): Promise<Result<Question, ValidationError[]>>
setQuestionStatus(id, status, actor): Promise<void>
getQuestionForAdmin(id): Promise<FullQuestion | null>
listQuestionsForAdmin(filters, page): Promise<Paginated<QuestionSummary>>
searchQuestions(query, filters): Promise<QuestionSummary[]>   // FTS5
bulkSetStatus(ids, status, actor): Promise<{ ok: number; failed: number }>
```

**`createQuestion` is the single funnel** (§2.9). It runs: Zod validation → `normalize()` → layer-1 hash → `dedupe.check()` → insert (or reject as duplicate). Manual creation, CSV import, and AI promotion all call it.

### 7.3 `modules/quiz`

Owns `quiz_attempts`, `quiz_attempt_answers`, `user_set_stats` updates. Detailed in §11.

### 7.4 `modules/progress`

Owns `user_question_seen`, reads `user_set_stats`.

```ts
recordAnswerSeen(userId, questionId, isCorrect, at): Promise<void>
getUserDashboard(userId): Promise<DashboardStats>
getUserHistory(userId, page): Promise<Paginated<AttemptSummary>>
```

### 7.5 `modules/auth`

Owns `users`, `auth_sessions`. Cookie-session based. Detailed in §16.1.

### 7.6 `modules/ai`

Owns `ai_generation_jobs`, `ai_candidates`. **Never** writes to `questions` — promotion goes through `modules/questions.createQuestion()`. Detailed in §12.

### 7.7 `modules/dedupe`

Owns `duplicate_flags`, `question_embeddings`, `questions_fts` queries.

```ts
checkCandidate(candidate: QuestionDraft): Promise<DedupeVerdict>
findSimilar(text: string, opts): Promise<SimilarMatch[]>
sweepExistingQuestions(): Promise<{ flagsCreated: number }>   // offline / admin-triggered re-scan
```

### 7.8 `modules/audit`

`record(actor, action, entityType, entityId, before, after)`. Called by every admin mutation.

---

## 8. User-facing screens

### 8.1 Screen 1 — Home (`/`)

```
┌─────────────────────────────────────────────────────────────────┐
│  QUIZ MASTER SUPREME                    [Search…]   [Account ▾] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  ▸ Continue: Kerala State IT Quiz                          │  │
│  │    Question 26 of 50 · ████████░░░░░░ 50%      [Resume →]  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Topics                                                         │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │   ⚛      │ │   🧪     │ │   ∑      │ │   💻     │            │
│  │ PHYSICS  │ │CHEMISTRY │ │  MATHS   │ │TECH QUIZ │            │
│  │ 12 sets  │ │  9 sets  │ │ 7 sets   │ │ 24 sets  │            │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │   🧬     │ │   🔬     │ │   ₹      │ │   🌐     │            │
│  │ BIOLOGY  │ │ SCIENCE  │ │ FINANCE  │ │  GK      │            │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘            │
│                        ⋮ infinite scroll ⋮                      │
└─────────────────────────────────────────────────────────────────┘
```

Spec:
- **Grid:** 4 columns ≥1024px, 3 at ≥768px, 2 at ≥640px, 2 on phones. Square-ish cards (`aspect-square`), snapped to a consistent radius/padding.
- **Card content (v0.1):** icon, title, `N sets`. Progress ring only if the user has touched that category. Resist adding more.
- **Infinite scroll:** cursor-paginated (`?cursor=<sort_order,id>&limit=24`) feeding an intersection observer. Server component renders page 1; client component appends pages 2+.
- **"Continue" banner:** present only when an in-progress attempt exists. Resolves via one indexed query on `ux_attempt_active`.

### 8.2 Screen 2 — Category (`/category/[slug]`)

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Topics                                                       │
│  TECH QUIZ                                                      │
│  24 sets · 1,240 questions                                      │
├─────────────────────────────────────────────────────────────────┤
│  Kerala State ─────────────────────────────────────────────     │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐          │
│  │ Mock Set 1    │ │ Mock Set 2    │ │ Mock Set 3    │          │
│  │ 50 q · 30 min │ │ 50 q · 30 min │ │ 50 q · 30 min │          │
│  │ ████████░ 76% │ │ ░░░░░░░░░  0% │ │ █████████✓    │          │
│  │ Best: 42/50   │ │               │ │  Best: 48/50  │          │
│  └───────────────┘ └───────────────┘ └───────────────┘          │
│                                                                 │
│  Previous Year ────────────────────────────────────────────     │
│  ┌───────────────┐ ┌───────────────┐                            │
│  │ Kerala 2025   │ │ Kerala 2024   │                            │
│  └───────────────┘ └───────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
```

- `group_label` produces the visual section headers. If null, sets render in one flat grid. **This is display-only and creates no route.**
- Card states: untouched / in-progress (progress bar) / completed (check + best score).

### 8.3 Screen 3 — Quiz Runner (`/quiz/[setId]`)

Desktop:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Kerala State IT Quiz — Mock Set 1                          ✕ Exit   │
├────────────────────────────────────────────┬─────────────────────────┤
│                                            │   ⏱  18:42              │
│  Question 17 of 50                         │   ████████░░░░  34%     │
│                                            │                         │
│  Which organisation developed the          │   Score                 │
│  Multics operating system?                 │   13 correct            │
│                                            │   3 wrong               │
│  ┌──────────────────────────────────────┐  │                         │
│  │ A.  IBM                              │  │   ── Question map ──    │
│  └──────────────────────────────────────┘  │   ■■■□□□■■□□□□□□□□     │
│  ┌──────────────────────────────────────┐  │   ■ correct             │
│  │ B.  MIT, GE and Bell Labs            │  │   □ wrong / unanswered  │
│  └──────────────────────────────────────┘  │                         │
│  ┌──────────────────────────────────────┐  │                         │
│  │ C.  Xerox PARC                       │  │                         │
│  └──────────────────────────────────────┘  │                         │
│  ┌──────────────────────────────────────┐  │                         │
│  │ D.  Microsoft                        │  │                         │
│  └──────────────────────────────────────┘  │                         │
└────────────────────────────────────────────┴─────────────────────────┘
```

After answering, the backstory panel expands beneath the options:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ✓ Correct — B                                                       │
│                                                                      │
│  ┌── BACKSTORY ───────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │  ### Project MAC                                               │  │
│  │                                                                │  │
│  │  Multics was a **time-sharing** operating system developed     │  │
│  │  jointly by MIT, General Electric, and Bell Labs...            │  │
│  │                                                                │  │
│  │  | Year | Milestone |                                          │  │
│  │  |------|-----------|                                          │  │
│  │  | 1964 | Project MAC begins |                                 │  │
│  │  | 1969 | Bell Labs withdraws |                                │  │
│  │                                                                │  │
│  │  > Bell Labs' withdrawal directly led to the creation of Unix. │  │
│  │                                                                │  │
│  │  Sources: [Multics history](https://…)                         │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│                                              [ Next Question → ]     │
└──────────────────────────────────────────────────────────────────────┘
```

Mobile: the right rail collapses to a sticky top bar (timer + progress + score); the question map becomes a slide-up sheet.

### 8.4 Account (`/account`)

```
┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│  3,482         │ │  78%           │ │  63            │ │  🔥 12         │
│  Questions     │ │  Accuracy      │ │  Sets          │ │  Day streak    │
│  Attempted     │ │                │ │  Completed     │ │                │
└────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘

In progress                    Recent attempts
┌────────────────────────┐    ┌──────────────────────────────────────────┐
│ Kerala IT Quiz         │    │ Mock Set 4   42/50  84%   Sep 12  [Retry]│
│ 26/50  ████████░ 52%   │    │ Kerala 2025  38/50  76%   Sep 10  [Review]│
│              [Resume →]│    │ Mock Set 2   48/50  96%   Sep 08  [Review]│
└────────────────────────┘    └──────────────────────────────────────────┘

Weak topics
  Operating Systems   ██████░░░░  61%   (23 attempts)
  Networking          ███████░░░  70%   (11 attempts)
```

`[Review]` opens a read-only replay of that attempt including backstories — this is what makes "I already covered this set" real.

---

## 9. Admin screens

### 9.1 Admin shell (`/admin`)

```
Dashboard │ Categories │ Sets │ Questions │ Generate │ Review (7) │ Duplicates (23) │ Users │ Settings
```

The two badge counts are the queue-depth indicators and should be visible on every admin page. If the review queue is invisible, it grows forever.

### 9.2 Categories & Sets admin

- **Categories:** table with inline reorder (drag), publish toggle, set-count. Create/edit in a sheet.
- **Sets:** list filtered by category; create/edit with mode, difficulty, time limit, question limit, shuffle flags, publish.
- **Question membership:** a set detail page with a searchable picker to attach existing questions, plus drag-reorder. This is where "the same great question lives in three sets" (§6.1 N:M) is exercised.

### 9.3 Question editor

Used for manual authoring **and** AI review — one component, two entry points.

```
Question stem        [ markdown textarea                           ]
Options              A [            ] B [            ]
                     C [            ] D [            ]  (+ Add E)
Correct              ( ) A  ( ) B  ( ) C  ( ) D
Difficulty           [ Medium ▾ ]     Topic [               ]
Tags                 [ chip input ]
Year                 [ 2025 ]  Exam body [ Kerala PSC ▾ ]
Source               [                     ] [ URL ]
Explanation (short)  [                                            ]
Backstory (rich)     [ markdown editor + live preview              ]
                     Sources: [ + Add source ]
Status               Draft ▾        [ Preview ]  [ Save ]  [ Approve & Publish ]
```

The backstory field gets a live preview rendered through the **same** `BackstoryRenderer` the quiz runner uses. If it looks wrong here, it looks wrong there.

### 9.4 Question bank

Table with: full-text search, filters (status, category, set, topic, difficulty, origin, year, has-backstory), bulk select, bulk status change, CSV export. Pagination via keyset, not `OFFSET`.

### 9.5 Generate

```
Category   [ Tech Quiz ▾ ]
Set        [ Kerala State Mock Set 6 ▾ ]  (or "create new")
Topic      [ Operating Systems        ]
Subtopics  [ process scheduling, deadlock, paging ]
Brief      [ Focus on Kerala PSC style. Avoid trivia about  ]
           [ version numbers. Include one question on        ]
           [ Semaphore vs Mutex.                             ]
Count      [ 25 ]     Difficulty [ Medium-Hard ▾ ]
Include full existing questions in prompt?  [ ] (costs more tokens)
Model      [ anthropic/claude-sonnet-4.5 ▾ ]

Existing coverage: 412 questions on this topic.
Digest preview: 2,100 chars · ~520 tokens  [ view ]

                              [ Generate 25 questions ]
```

While running, the page shows live job status (queued → running → parsing → deduping → done) with a progress bar, then links to the review queue.

### 9.6 Review queue

Card-per-candidate, keyboard-driven (`J`/`K` to move, `A` approve, `R` reject, `E` edit-then-approve):

```
┌──────────────────────────────────────────────────────────────────────┐
│  ⚠ Possible duplicate — 94% semantic match                          │
│                                                                      │
│  NEW                                                                 │
│  Who originally developed the Linux kernel?                          │
│  A. Linus Torvalds  B. Richard Stallman  C. Ken Thompson  D. …       │
│                                                                      │
│  EXISTING #1842 (published)                                          │
│  Who created Linux?                                                  │
│  A. Linus Torvalds  B. …                                             │
│                                                                      │
│  [ Keep Anyway ]   [ Reject Duplicate ]   [ Merge → keep existing ]  │
├──────────────────────────────────────────────────────────────────────┤
│  Backstory preview …                                                 │
│                                                                      │
│  [ Approve ]  [ Approve & Edit ]  [ Reject ]  [ Defer ]              │
└──────────────────────────────────────────────────────────────────────┘
```

### 9.7 Duplicates

Two tabs:
- **Candidates** — AI candidates flagged as duplicates awaiting a decision.
- **Bank sweep** — existing published questions flagged against each other by `sweepExistingQuestions()`. Batch actions: confirm duplicate (archive one), dismiss, merge.

### 9.8 The "no third level" rule in the admin UI

There is no "Add sub-category" button anywhere. Sets are always created *inside* a selected category. This is not a limitation to work around — it is the product (§2.1).

---

## 10. HTTP API surface

Route handlers live in `src/app/api/**/route.ts`. All responses are JSON. All mutations require a session; all `/api/admin/*` require `role='admin'` re-checked server-side.

### 10.1 Public / user

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Start session |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/me` | Current user |
| `GET` | `/api/categories` | Published categories (cursor-paginated) |
| `GET` | `/api/categories/:slug` | Category + its sets (+ progress if authed) |
| `GET` | `/api/sets/:id` | Set metadata, counts, progress |
| `POST` | `/api/sets/:id/attempts` | **Start or resume** → attempt |
| `GET` | `/api/attempts/:id` | Attempt state + next question **without** answers |
| `GET` | `/api/attempts/:id/questions?from=&count=` | Prefetch upcoming questions, answer-stripped |
| `POST` | `/api/attempts/:id/answers` | Submit answer → correctness + backstory |
| `POST` | `/api/attempts/:id/complete` | Finalize; returns summary |
| `GET` | `/api/attempts/:id/summary` | Results screen data |
| `POST` | `/api/attempts/:id/abandon` | Explicitly give up (keeps answers) |
| `GET` | `/api/me/stats` | Dashboard aggregates |
| `GET` | `/api/me/history` | Paginated attempt history |
| `GET` | `/api/me/in-progress` | The "Continue" banner source |
| `GET` | `/api/search?q=` | FTS5 search across sets and questions |

### 10.2 Admin

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/api/admin/categories` | List / create |
| `PATCH/DELETE` | `/api/admin/categories/:id` | Update / archive |
| `POST` | `/api/admin/categories/reorder` | Bulk sort |
| `GET/POST` | `/api/admin/sets` | List / create |
| `PATCH/DELETE` | `/api/admin/sets/:id` | Update / archive |
| `POST` | `/api/admin/sets/:id/questions` | Attach |
| `DELETE` | `/api/admin/sets/:id/questions` | Detach |
| `POST` | `/api/admin/sets/:id/questions/reorder` | Reorder |
| `GET/POST` | `/api/admin/questions` | List (filters) / create |
| `GET/PATCH` | `/api/admin/questions/:id` | Read / update |
| `POST` | `/api/admin/questions/:id/status` | Status transition |
| `POST` | `/api/admin/questions/bulk-status` | Bulk transition |
| `POST` | `/api/admin/questions/import` | CSV import (same funnel) |
| `GET` | `/api/admin/questions/export` | CSV export |
| `POST` | `/api/admin/generation-jobs` | Enqueue generation → `202 { jobId }` |
| `GET` | `/api/admin/generation-jobs` | Job list |
| `GET` | `/api/admin/generation-jobs/:id` | Job detail + live counts |
| `POST` | `/api/admin/generation-jobs/:id/cancel` | Cancel |
| `POST` | `/api/admin/generation-jobs/:id/preview-digest` | Build digest without generating |
| `GET` | `/api/admin/candidates` | Review queue |
| `POST` | `/api/admin/candidates/:id/review` | approve / reject / merge / defer |
| `POST` | `/api/admin/candidates/bulk-review` | Bulk on a filtered set |
| `POST` | `/api/admin/candidates/:id/promote` | Candidate → `questions` via the funnel |
| `GET` | `/api/admin/duplicates` | Open flags |
| `POST` | `/api/admin/duplicates/:id/resolve` | confirm / dismiss / merge |
| `POST` | `/api/admin/duplicates/sweep` | Run a bank sweep (queued) |
| `POST` | `/api/admin/embeddings/backfill` | Queue embedding backfill |

### 10.3 Error shape

Every handler returns the same envelope:

```ts
type ApiError = {
  error: {
    code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION' |
          'CONFLICT' | 'DUPLICATE' | 'RATE_LIMITED' | 'INTERNAL';
    message: string;
    details?: unknown;
  };
};
```

---

## 11. Quiz engine

### 11.1 What the client knows and when

This is the core security design (§2.6):

```
START / RESUME
   └─> attempt { id, questionOrder, total, currentIndex, answered summary }
       + question[0..n]  ← stem + options ONLY. No is_correct. No explanation. No backstory.

ANSWER Q17
   └─> POST { questionId, selectedKey, timeTakenMs, clientSeq }
       <─ { isCorrect, correctOptionKey, explanation, backstory, runningScore, nextIndex }
```

Client prefetches the next ~5 questions on idle to hide latency. It never receives their answers.

### 11.2 Attempt lifecycle (state machine)

```
                 ┌──────────────────────────────┐
                 │                              │
   POST /attempts│                              │
   (no active)   ▼                              │
   ──────────> IN_PROGRESS ──── POST /complete ─┴──> COMPLETED
                 │  ▲
                 │  │ resume (POST /attempts)
                 │  │
                 │  └── (same row, no new row created — §11.4)
                 │
                 ├── POST /abandon ──────────────> ABANDONED
                 │
                 └── deadline passed ────────────> EXPIRED
                        (auto-scored on next touch)
```

**Allowed transitions only.** Any other transition returns `409 CONFLICT`. There is no "un-complete" and no "un-abandon".

### 11.3 Starting an attempt

```
POST /api/sets/:id/attempts
 1. Resolve set; must be status='published'.               else 404
 2. Resolve published questions attached to the set.
 3. If zero questions → 409 SET_EMPTY.
 4. If question_limit set → take first N by sort_order.
 5. If shuffle_questions → Fisher–Yates using crypto.getRandomValues
    (NOT Math.random — reproducible seeds are a cheat vector).
 6. Freeze question_order (JSON array) and option_order into the attempt row.
 7. INSERT attempt with server_deadline_at = now + time_limit_seconds*1000.
 8. On UNIQUE constraint violation (ux_attempt_active) → SELECT the existing
    in-progress attempt and return THAT instead. This is the resume path and
    it is also the race-condition path. Same code, one branch.
```

### 11.4 Resume — the exact semantics

**Guarantee:** *For a given (user, set) there is at most one in-progress attempt, and it always contains every answer already given.*

Why this works:
- The partial unique index makes "one active attempt" a database invariant, not application logic.
- `quiz_attempt_answers` rows are written on every submit, so the server always knows `current_index` and the full answer set.
- Resume is therefore **not** a restore operation — it is simply "read the existing attempt." Nothing can be lost because nothing was ever held only in memory.

**Resume UX:** opening `/quiz/[setId]` calls `POST /api/sets/:id/attempts`. If an active attempt exists, the response includes `resumed: true` and the runner jumps to `current_index` after showing a brief "Welcome back — question 26 of 50" toast (not a blocking modal, not a confirmation dialog — resuming is the expected behavior, not an error state).

**Edge cases:**

| Situation | Behavior |
|---|---|
| User answers 25/50, closes browser | Attempt intact. Resume at 26. |
| Same user opens the quiz in two tabs | Both drive the same attempt row. Answer writes are idempotent upserts, so double-submit is harmless. Last write for a given question wins only if it's a *different* question; re-answering the same question updates it and recomputes counts. |
| User clicks "Start over" | Explicit action: current attempt → `abandoned`, new attempt created. Never silently discards progress. |
| Timed attempt, browser closed past deadline | On next touch, `status → expired`, auto-scored from stored answers, appears in history. |
| Set content edited mid-attempt | `question_order` is frozen, so the attempt still completes against the questions it started with. Detached questions are still readable for scoring. |
| Attempt with 0 answers and no activity for 30 days | Sweeper marks `abandoned`. Keeps the DB tidy; history stays honest. |

### 11.5 Timer authority

- `server_deadline_at` is computed server-side at start and is **authoritative**.
- The client renders a countdown from the server-provided remaining time. A client clock skew of any size cannot extend the quiz.
- Answer submissions after the deadline are rejected with `409 ATTEMPT_EXPIRED` (with a 5-second grace window for in-flight network latency).
- The runner auto-submits on expiry: it calls `/complete`, and unanswered questions are scored as skipped.
- If the browser is closed and reopened after the deadline, `GET /api/attempts/:id` returns the expired state and the summary screen, not the runner.

### 11.6 Scoring

```
correct_count  = COUNT(answers WHERE is_correct = 1)
wrong_count    = COUNT(answers WHERE is_correct = 0)
skipped_count  = total_questions - answered_count

score_percent  = correct_count / total_questions * 100     -- unanswered counts against you
passed         = set.passing_percent IS NOT NULL AND score_percent >= set.passing_percent
```

Scoring is computed and persisted on completion inside a single `db.batch()`. **Never trust a client-submitted score.** The client's running score is display-only and is always recomputed server-side.

### 11.7 The backstory renderer

`<BackstoryRenderer content={string} format="markdown" />` — its own component, deliberately.

Responsibilities:
- Safe markdown → HTML (no `dangerouslySetInnerHTML` on unsanitized input; parse to a React tree or sanitize hard).
- Typography tuned for reading: measure capped at ~70ch, generous line height.
- Support (in this order of delivery): paragraphs, `###` headings, bold/italic, ordered/unordered lists, tables (GFM), blockquotes, inline code, fenced code, links (with `rel="noopener noreferrer"`), and a citations/footnotes block.
- **Later extension points (design for them now, don't build them yet):** images from R2, Mermaid/ASCII diagrams, highlighted key-fact callouts, audio.

The renderer is used in three places: the quiz runner, the admin editor preview, and the attempt review screen. One component, three contexts, identical output.

### 11.8 What the runner must NOT do

- Must not compute correctness client-side.
- Must not hold the whole question bank in memory.
- Must not lose an answer because the user navigated away — submissions are optimistic in the UI but *retried* until acknowledged, and `navigator.sendBeacon` fires a final submit on `pagehide`.
- Must not present a "Submit quiz?" confirm dialog on every navigation — only on explicit finish.

---

## 12. AI generation pipeline

### 12.1 Why async (and why not a page request)

A 25-question generation with detailed backstories is a 60–300 second LLM call producing 15–40 KB of text. Doing that inside an HTTP request would mean: a hung browser, a Worker wall-clock limit, a lost response on network blip, and no retry. So:

```
POST  /api/admin/generation-jobs   → validate → INSERT job(queued) → enqueue → 202 {jobId}
Queue consumer                     → the actual work (§12.3)
GET   /api/admin/generation-jobs/:id → poll for progress
```

If generation ever needs multiple retrying steps (generate → validate → repair invalid → embed), promote the consumer body into a **Cloudflare Workflow**. The job table already models the state, so that's a contained change.

### 12.2 Job lifecycle

```
queued ──> running ──┬──> succeeded          (all candidates stored)
                     ├──> partial            (some stored, some invalid)
                     ├──> failed             (provider error, parse failure, timeout)
                     └──> cancelled          (admin action)
```

Each transition writes `audit_log` and updates counters. `raw_response_key` points at the R2 object holding the untouched model output — non-negotiable for debugging a bad batch three weeks later.

### 12.3 Consumer steps

```
 1. Load job. If status != 'queued' → ack and exit (idempotent re-delivery).
 2. Mark running, started_at.
 3. Build the coverage digest (§12.4). Persist it on the job row.
 4. Render the prompt (§25.1) with digest + brief + constraints.
 5. Call OpenRouter (streaming; accumulate). Record token usage + cost.
 6. Store the raw payload to R2: jobs/{jobId}/response.json
 7. Parse → JSON repair pass if needed → Zod validate each candidate.
      invalid → INSERT ai_candidates(validation_status='invalid', errors)
 8. For each valid candidate:
      normalize → layer-1 hash check
      → layer-2 FTS5 candidate search  (§13.4)
      → layer-3 embedding + Vectorize (§13.5)   [M12+]
      → INSERT ai_candidates with dedupe_status
 9. Update job counters + terminal status.
10. ack.
```

**Idempotency:** step 1 makes redelivery safe. Additionally, `ai_candidates` inserts are guarded by `(job_id, normalized_hash)` uniqueness in practice via a pre-insert check, so a retry after a partial failure doesn't double-insert.

### 12.4 Solving the stateless-API repetition problem

The user's diagnosis is exactly right: the LLM has no memory of the 8,000 questions already in the bank. The fix is **coverage compression**, not context stuffing.

**Naive approach (rejected):** send all 8,000 stems. ~400 KB, ~100k tokens, expensive, slow, and quality actually *degrades* in long contexts.

**Chosen approach — a three-stage digest:**

```
STAGE A — CANDIDATE RETRIEVAL  (cheap, deterministic)
  Query FTS5 + topic/difficulty filters for questions related to the target topic.
  Take top ~300 by bm25 rank.

STAGE B — CONCEPT EXTRACTION  (deterministic first)
  For each retrieved question, extract a short "concept key":
    - strip interrogatives (who/what/which/when/where/how/why)
    - strip boilerplate ("In which year", "Which of the following")
    - keep the salient noun phrase + the answer, truncated
  e.g. "Who created Linux?" + answer "Linus Torvalds"
       → "Linux — creator — Linus Torvalds"
  Deduplicate concept keys, cluster near-identical ones, keep the top K.

STAGE C — COMPRESSION  (optional, budgeted)
  If concept keys exceed the digest budget, call a small/cheap model once to
  merge them into a tight bulleted list of covered concepts.
  This is a single short completion — not a per-question cost.
```

**Output** (what actually goes in the prompt):

```
ALREADY COVERED (do NOT create questions testing these facts):
- Linux — creator — Linus Torvalds
- Linux — first release year — 1991
- Linux — mascot — Tux
- GNU — founder — Richard Stallman
- Ubuntu — parent distribution — Debian
- Debian — founder — Ian Murdock
- systemd — creator — Lennart Poettering
- Red Hat — acquisition — IBM (2019)
… (≈150–400 keys, budget-capped)
```

Then the instruction: *"Generate questions that test concepts NOT in the list above. If you must cover a listed concept, it must require a different, deeper fact."*

**Budget:** digest capped at ~2,500 tokens by default (configurable per job). `coverage_tokens` is stored on the job so cost is attributable.

**Feedback loop:** after review, approved/rejected outcomes refine future digests — a rejected duplicate is a strong signal the concept was already covered and the digest missed it. Log these and widen the digest for that topic.

### 12.5 Structured output contract

The model must return JSON matching a Zod schema. Prompt demands JSON only; the parser is forgiving about fences and prose wrappers.

```ts
const GeneratedQuestion = z.object({
  stem: z.string().min(10).max(1000),
  options: z.array(z.object({
    key: z.enum(['A', 'B', 'C', 'D', 'E']),
    body: z.string().min(1).max(500),
  })).min(4).max(5),
  correct_option_key: z.enum(['A', 'B', 'C', 'D', 'E']),
  explanation: z.string().max(600),
  backstory: z.string().min(80).max(6000),
  difficulty: z.enum(['easy', 'medium', 'hard', 'expert']),
  topic: z.string().max(120),
  tags: z.array(z.string().max(40)).max(8).default([]),
  source: z.string().max(300).optional(),
});

const GenerationResponse = z.object({
  questions: z.array(GeneratedQuestion).min(1).max(60),
  notes: z.string().max(1000).optional(),
});
```

**Validation beyond Zod** (`validateQuestion()` — shared with manual entry, §2.9):

| Check | Rule |
|---|---|
| Option count | exactly 4 (or 5 if a 5th is provided) |
| Key uniqueness | no duplicate keys |
| Correct key exists | `correct_option_key` present in `options` |
| Distinct options | no two options with identical normalized text |
| No "all of the above" as correct without the parts being true | flag for human review, don't auto-reject |
| Stem not a giveaway | stem must not contain the correct option text verbatim |
| Backstory non-trivial | ≥ 80 chars, and must not merely restate the explanation |
| No placeholder text | reject `lorem ipsum`, `TODO`, `[insert]`, `Option A` |
| Language | detect and record |

Anything that fails lands in the candidate table **with its errors visible**, marked `invalid`. Admins can still see and salvage them. Silent dropping is forbidden — a systematically broken prompt should be visible, not invisible.

### 12.6 Cost controls

- `requested_count` capped per job (default 25, hard max 50). Smaller batches dedupe better and fail cheaper.
- Per-admin daily token budget in `app_settings`.
- Model allowlist in `app_settings` — no free-text model field.
- `cost_usd` recorded per job; a dashboard total.
- `include_examples` (sending full existing questions instead of a digest) is off by default and labelled with its cost.
- Dry-run: `POST .../preview-digest` returns the exact digest and estimated token count without calling the LLM. Admins should always be able to see what they're paying for.

### 12.7 Prompt versioning

Prompt templates are code (`modules/ai/prompts/*`), and every job stores `prompt_version`. When quality shifts, we can attribute it to a prompt change by querying acceptance rate grouped by version. Without this, prompt iteration is guesswork.

---

## 13. Duplicate detection engine

### 13.1 Design principle

A funnel, cheapest-first. Most duplicates die at layer 1 for free; only survivors reach an embedding call. **And the final decision is always human for anything ambiguous** — the engine flags, it does not silently delete.

```
candidate
   │
   ├─ LAYER 1  exact / normalized hash ──────────> DUPLICATE (auto-reject, free, instant)
   │
   ├─ LAYER 2  FTS5 + simhash near-match ────────> likely duplicate (auto-flag, ~free)
   │
   ├─ LAYER 3  embedding cosine via Vectorize ───> possible duplicate (flag with score)
   │
   └──────────────────────────────────────────────> CLEAN → review queue
```

### 13.2 Layer 1 — normalization and exact matching

```ts
// modules/questions/normalize.ts
export function normalizeStem(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")   // smart quotes → straight
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')              // drop punctuation
    .replace(/\s+/g, ' ')
    .trim();
}
```

Applied to stem, and to the sorted option bodies, producing two hashes:

- `normalized_hash` = sha256(normalizeStem(stem))
- `content_hash` = sha256(normalizeStem(stem) + '|' + sortedNormalizedOptionBodies.join('|'))

**Verdicts:**
- `normalized_hash` match → **exact duplicate**, auto-reject. `"Who created Linux?"` and `"who created linux"` are the same question.
- `content_hash` match → duplicate *with identical options* — stronger signal; also auto-reject.

Layer 1 must run **before** any LLM call and before any DB insert. It is the cheapest and catches the most common failure (a model regenerating an obvious question verbatim).

### 13.3 Layer 2a — simhash prefilter

A 64-bit SimHash over **word unigrams** of the normalized stem, stored as 16 hex chars.

> **Revised during M0, based on measurement.** The original design used token
> 3-grams with a Hamming threshold of ≤ 6. That was wrong for this corpus.
> Question stems are short (5–15 tokens), so a 3-gram signature has very few
> grams and ONE changed word perturbs most of them: a mere spelling variant
> (`organisation` → `organization`) measured **23 bits** apart — indistinguishable
> from an unrelated question. Unigrams keep one changed word to one changed
> feature.

Measured Hamming distances on real stems from `seed/questions.json`:

| Pair | Distance |
|---|---|
| identical / case + punctuation only | 0 |
| one-word spelling variant | 10 |
| paraphrase ("Who created Linux?" vs "Who was the original developer of the Linux kernel?") | 12 |
| same topic, different fact | 24 |
| different topic | 28 |
| unrelated | 36 |

**Threshold: ≤ 16** (`SIMHASH_NEAR_DUPLICATE_MAX_DISTANCE`), which sits in the gap
with margin on both sides. These are prefilter bands only — the thresholds that
actually drive admin review decisions live in `app_settings` (§13.4) so they can be
tuned without a deploy.

```ts
// modules/dedupe/simhash.ts
export function simhash64(text: string): bigint {
  const votes = new Array<number>(64).fill(0);
  for (const gram of shingles(normalizeStem(text), 1)) {   // WORD UNIGRAMS
    const h = fnv1a64(gram);
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      votes[i] = (votes[i] ?? 0) + (bit === 1n ? 1 : -1);
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if ((votes[i] ?? 0) > 0) out |= 1n << BigInt(i);
  return out;
}
```

Cheap, pure TypeScript, no dependencies. Since every question stores its simhash, a scan is a linear pass with a popcount — acceptable for tens of thousands of rows inside a queue consumer, and unnecessary in the hot path. It is a **coarse prefilter**: FTS5 + Jaccard does the real work at layer 2, and embeddings do the semantic work at layer 3.

### 13.4 Layer 2b — FTS5 candidate retrieval

For a candidate stem, build an FTS5 query from its most distinctive terms and take the top ~20 by `bm25`:

```sql
SELECT f.question_id, bm25(questions_fts) AS rank
FROM questions_fts f
WHERE questions_fts MATCH ?
  AND f.question_id IN (SELECT id FROM questions WHERE status = 'published')
ORDER BY rank
LIMIT 20;
```

The `MATCH` string is built by tokenizing the candidate stem, dropping stopwords, and OR-ing quoted terms. Then a token-overlap (Jaccard) score refines the FTS5 shortlist:

```
jaccard = |A ∩ B| / |A ∪ B|     over content-word sets

≥ 0.85  → near duplicate  (flag, default reject for AI candidates)
0.65–0.85 → possible duplicate (flag for human review)
< 0.65  → clean
```

Thresholds live in `app_settings` (`dedupe.jaccard_reject`, `dedupe.jaccard_review`) so they're tunable without a deploy.

### 13.5 Layer 3 — semantic similarity

Only runs on candidates that survived layers 1–2 and are not already layer-2 duplicates.

```ts
// modules/dedupe/embeddings.ts
const EMBED_MODEL = '@cf/baai/bge-m3';   // 1024-dim

type EmbedText = { questionId: string; text: string };   // stem + options, not backstory

async function embed(texts: string[]): Promise<number[][]> {
  const res = await bindings().AI.run(EMBED_MODEL, { text: texts });
  return res.data;
}
```

Vector payload — **only an id**, per §2.3:

```ts
{
  id: `q_${questionId}`,
  values: embedding,
  metadata: { questionId, status, topic, difficulty }
}
```

Query for a candidate:

```ts
const matches = await bindings().VECTORIZE.query(embedding, {
  topK: 5,
  returnMetadata: 'all',
});
```

Similarity thresholds (cosine):
- `≥ 0.95` → semantic duplicate, auto-flag as duplicate
- `0.85 – 0.95` → flag for human review with the score shown
- `< 0.85` → clean

**This is what catches the user's exact example:**

| Question | Wording |
|---|---|
| Existing | Who created Linux? |
| Candidate A | Who was the original developer of the Linux kernel? |
| Candidate B | Linux was initially developed by whom? |

Layers 1 and 2 miss all of these. Layer 3 clusters them tightly.

**Embedding text choice matters:** embed `stem + " " + option bodies joined`. Do **not** embed the backstory — it dilutes the topical signal and makes unrelated questions with similar prose look alike. Store `content_hash` in `question_embeddings` so a re-embed happens only when the embedded text actually changes.

### 13.6 Verdict type

```ts
type DedupeVerdict = {
  status: 'clean' | 'exact_dup' | 'near_dup' | 'semantic_dup';
  layer: 'exact' | 'text' | 'semantic';
  bestMatch?: {
    questionId: string;
    stem: string;
    similarity: number;
    status: string;
  };
  allMatches: Array<{ questionId: string; similarity: number; layer: string }>;
  autoReject: boolean;   // true only for layer-1 exact matches
};
```

**Policy:**
- `autoReject: true` only for layer-1 exact matches. These are provably identical after normalization; no human judgment is required.
- Everything else is **flagged, never auto-deleted**, and surfaces in the admin triage UI (§9.7) with the matched question shown side by side. The human picks Keep / Reject / Merge.

This is deliberately more conservative than the original "reject and only insert the remaining questions" idea. Silently discarding a question that is merely *similar* would throw away genuinely distinct content — "Who created Linux?" and "In what year was the Linux kernel first released?" are both good questions. Flag, don't destroy.

### 13.7 Retroactive sweep

Dedupe isn't only a generation-time concern. `sweepExistingQuestions()` runs over the published bank, recomputing layer-2 and layer-3 flags, and writes `duplicate_flags`. Triggered manually from `/admin/duplicates` or on a schedule. It's also the repair path after a threshold change.

### 13.8 Failure behavior

If the embedding provider or Vectorize is unavailable, layer 3 is **skipped**, not failed. The candidate is stored with `dedupe_status='clean'` but tagged `dedupe_detail = {"degraded": "layer3_unavailable"}`, and a background backfill re-checks it later. AI generation must not be blocked by an indexing outage.

---

## 14. Local development

### 14.1 Prerequisites

Node.js 22+, pnpm, a Cloudflare account (only needed for deploy), Wrangler CLI.

### 14.2 Setup

```bash
pnpm create vinext-app@latest quizmaster-supreme
cd quizmaster-supreme
pnpm add drizzle-orm zod
pnpm add -D drizzle-kit wrangler @cloudflare/vitest-pool-workers vitest
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button card dialog input label select table \
  badge progress tabs sheet textarea switch separator dropdown-menu \
  alert-dialog toast skeleton
```

### 14.3 `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "quizmaster-supreme",
  "main": "dist/server/index.js",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "account_id": "<your-account-id>",

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "quizmaster-supreme-db",
      "database_id": "<uuid>",
      "migrations_dir": "migrations"
    }
  ],

  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "quizmaster-supreme-assets" }
  ],

  "queues": {
    "producers": [{ "binding": "AI_JOBS", "queue": "quizmaster-supreme-ai-jobs" }],
    "consumers": [
      {
        "queue": "quizmaster-supreme-ai-jobs",
        "max_batch_size": 1,
        "max_batch_timeout": 5,
        "max_retries": 2,
        "dead_letter_queue": "quizmaster-supreme-ai-jobs-dlq"
      }
    ]
  },

  "vectorize": [
    {
      "binding": "VECTORIZE",
      "index_name": "quizmaster-supreme-questions"
    }
  ],

  "ai": { "binding": "AI" },

  "vars": {
    "APP_ENV": "development",
    "DEFAULT_GENERATION_MODEL": "anthropic/claude-sonnet-4.5",
    "EMBEDDING_MODEL": "@cf/baai/bge-m3"
  },

  "observability": { "enabled": true }
}
```

`max_batch_size: 1` is intentional: one generation job per consumer invocation, so a slow job can't block others and each gets its own full timeout budget.

### 14.4 The bindings adapter (§2.7)

```ts
// src/lib/cloudflare/bindings.ts — THE ONLY FILE THAT IMPORTS cloudflare:workers
import { env } from 'cloudflare:workers';

type Bindings = {
  DB: D1Database;
  STORAGE: R2Bucket;
  AI_JOBS: Queue;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  APP_ENV: string;
  DEFAULT_GENERATION_MODEL: string;
  EMBEDDING_MODEL: string;
  SESSION_SECRET: string;
  OPENROUTER_API_KEY: string;
};

export function bindings(): Bindings {
  return env as unknown as Bindings;
}
```

Migrating to OpenNext means changing this one file to use `getCloudflareContext().env`. That's the whole hedge.

### 14.5 Migrations

```bash
# generate SQL from the Drizzle schema
pnpm drizzle-kit generate

# apply locally (local D1, SQLite file in .wrangler/state)
pnpm wrangler d1 migrations apply quizmaster-supreme-db --local

# apply to production
pnpm wrangler d1 migrations apply quizmaster-supreme-db --remote
```

Migrations are **append-only**. Never edit an applied migration; add a new one. Production data exists.

### 14.6 Seeds

```bash
pnpm seed --local          # categories + sets + ~40 sample questions
pnpm seed --remote         # same, guarded by an explicit --yes in prod
```

`seed/questions.json` carries full backstories so the renderer has real content to exercise from day one.

### 14.7 Daily loop

```bash
pnpm dev            # vinext dev server          (primary)
pnpm dev:next       # plain Next.js dev server   (the hedge — §3.3)
pnpm test           # vitest against local D1
pnpm test:e2e       # playwright
pnpm drizzle-kit generate
pnpm wrangler d1 migrations apply quizmaster-supreme-db --local
pnpm wrangler tail  # live production logs
```

### 14.8 Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | `.dev.vars` local / `wrangler secret put` prod | LLM access |
| `SESSION_SECRET` | same | Cookie signing |
| `APP_ENV` | `wrangler.jsonc` vars | Behavior switches |
| `DEFAULT_GENERATION_MODEL` | vars | Model allowlist default |
| `EMBEDDING_MODEL` | vars | `@cf/baai/bge-m3` |

`.dev.vars` is gitignored. **No secret ever appears in `vars`** — `vars` are plainly readable in the dashboard.

---

## 15. Cloudflare deployment

### 15.1 Resource provisioning (one-time)

```bash
wrangler d1 create quizmaster-supreme-db
wrangler r2 bucket create quizmaster-supreme-assets
wrangler queues create quizmaster-supreme-ai-jobs
wrangler queues create quizmaster-supreme-ai-jobs-dlq
wrangler vectorize create quizmaster-supreme-questions --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index quizmaster-supreme-questions \
  --property-name=status --type=string
wrangler vectorize create-metadata-index quizmaster-supreme-questions \
  --property-name=topic --type=string
```

The metadata indexes matter: they let layer-3 queries filter to published questions *inside* Vectorize instead of post-filtering a topK list (which silently loses matches).

### 15.2 Environments

| Env | Worker | D1 | Purpose |
|---|---|---|---|
| local | `wrangler dev` | local SQLite | daily dev |
| staging | `quizmaster-supreme-staging` | `quizmaster-supreme-db-staging` | pre-prod checks |
| production | `quizmaster-supreme` | `quizmaster-supreme-db` | live |

Use `wrangler.jsonc` `env.staging` / `env.production` blocks. Staging gets its own D1 so a bad migration never touches production data.

### 15.3 Deploy

```bash
pnpm build
npx @vinext/cloudflare deploy                    # production
npx @vinext/cloudflare deploy --env staging      # staging
```

Guard the production deploy behind CI + a manual approval. Migrations run as a **separate, explicit step**, never bundled blindly into a deploy — apply migrations first, then deploy code that requires them, and only with backward-compatible migrations (add columns as nullable, backfill, then tighten).

### 15.4 CI (GitHub Actions)

```
on: pull_request
 - pnpm install
 - pnpm typecheck
 - pnpm lint
 - pnpm test                      # vitest + local D1
 - pnpm wrangler d1 migrations apply quizmaster-supreme-db-staging --remote   (on main only)
 - pnpm test:e2e                  (smoke subset)
```

Deploy on merge to `main` → staging automatically; production on tag.

### 15.5 Backups

D1 supports export. A scheduled Worker (Cron Trigger) runs `wrangler d1 export` to R2 nightly. **A content platform whose entire value is its question bank must have a restore path that has been tested at least once.** Write the restore procedure into `README.md` during M15.

---

## 16. Security

### 16.1 Authentication

Cookie sessions, `HttpOnly` + `Secure` + `SameSite=Lax`.

```
POST /api/auth/login
 1. email_norm lookup
 2. verify password (constant-time compare)
 3. generate 32 random bytes (crypto.getRandomValues) → raw token
 4. store sha256(raw token) as auth_sessions.id
 5. Set-Cookie: qm_session=<raw>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=...
```

**Password hashing — the CPU caveat.** Workers **Free** allows ~10 ms CPU per request. A properly-iterated KDF (OWASP recommends 600,000 PBKDF2-SHA256 iterations) costs far more than that and will fail on the free tier. Options, in preference order:

1. **Workers Paid ($5/mo)** — 30 s CPU default. Comfortable headroom. *(Recommended; this plan assumes it.)*
2. PBKDF2-SHA256 via WebCrypto at a reduced iteration count — weaker, and weakens with each passing year.
3. A managed auth provider (Clerk/Better Auth) — moves the KDF off our Worker, adds a vendor.

This is decision **D-1** in §24. It is a real fork and should be settled before M1.

Storage format is self-describing so the algorithm can be upgraded without a flag day:

```
pbkdf2-sha256$600000$<base64 salt>$<base64 hash>
```

On successful login, if the stored parameters are below current policy, transparently re-hash.

### 16.2 Authorization matrix

| Resource | Anonymous | User | Admin |
|---|---|---|---|
| Published categories/sets | read | read | read |
| Own attempts & answers | — | read/write | read (support) |
| Other users' attempts | — | — | read (support) |
| Question correctness before answering | **never** | **never** | read |
| Draft/archived content | — | — | read/write |
| AI generation | — | — | read/write |
| Review queue | — | — | read/write |
| Users & settings | — | — | read/write |

Enforced in the query (`WHERE user_id = ?`), not in a UI conditional.

### 16.3 Input handling

- Zod at every boundary: API bodies, query params, server-action inputs, and the LLM response.
- D1 parameterized statements only.
- Markdown sanitized before render — the backstory field is admin-authored, but "admin-authored" is not a security boundary if an admin account is ever compromised.
- Rate limits on login (per-IP and per-account), register, and generation requests.
- CSV import validated row-by-row with the same funnel; **no** formula-injection passthrough on export (prefix `=`, `+`, `-`, `@` cells).

### 16.4 Content-integrity rules

- The correct answer never leaves the server before an answer is submitted (§2.6).
- Scores are computed server-side only (§11.6).
- `question_order` is frozen per attempt, so editing a set can't be used to alter an in-flight attempt.
- Admin mutations are audited (§7.8).

---

## 17. Performance and cost budgets

### 17.1 Latency targets

| Interaction | Target (p75) |
|---|---|
| Home grid first paint | < 400 ms |
| Category page | < 400 ms |
| Answer submit → reveal | < 250 ms |
| Start/resume attempt | < 500 ms |
| Admin question save | < 600 ms |
| Generation job enqueue | < 300 ms (work happens async) |

### 17.2 Query discipline

- Screen 1 = one indexed query + one optional in-progress query.
- Screen 2 = **one** query joining sets to counts to `user_set_stats`. Not N+1. If D1's planner misbehaves, precompute `question_count` onto `quiz_sets` and maintain it on attach/detach.
- Screen 3 = fetch one question at a time (plus prefetch). Never load a 50-question set with options in one payload.
- Keyset pagination everywhere. No `OFFSET` on large tables.

### 17.3 Cost model

| Item | Driver | Control |
|---|---|---|
| Workers requests | traffic | edge caching for anonymous reads |
| D1 rows read/written | query volume | indexes, denormalized counters, prefetch batching |
| Queue operations | generation jobs | batch size 1, retries capped at 2 |
| Workers AI embeddings | re-embedding + new questions | `content_hash` guards; backfill only on change |
| Vectorize | vectors stored + queried | filtered queries; layer 3 runs only on survivors |
| OpenRouter | tokens | count cap, digest budget, per-admin daily budget |
| R2 | raw payloads + assets | lifecycle rule: raw responses → IA after 90 days |

### 17.4 The read-heavy path is cacheable

Published categories, sets, and questions change rarely. Anonymous reads of screen 1 and 2 can be served from cache with tag-based invalidation (`revalidateTag('category:xyz')` on admin publish). Do this in M8 only if measurements justify it — premature caching here would obscure real query problems.

### 17.5 Verified unit pricing

Checked against Cloudflare's live pricing pages on **2026-09-14**. Re-verify before budgeting; these change.

| Service | Free tier | Paid tier | Source |
|---|---|---|---|
| **Workers** | 100k requests/day; **10 ms CPU per invocation** | **$5/mo minimum**; 10M requests included, +$0.30/M; 30M CPU-ms included, +$0.02/M | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| **Workers static assets** | **free and unlimited** | free and unlimited | same |
| **D1** | 5M rows read/day; **100k rows written/day**; 5 GB total | 25B rows read + 50M rows written included/mo; +$0.001/M read, +$1.00/M written; 5 GB + $0.75/GB-mo | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| **Vectorize** | 30M queried dims/mo; **5M stored dims** | 50M queried dims included, +$0.01/M; 10M stored dims included, +$0.05/100M | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| **R2** | 10 GB-mo; 1M Class A; 10M Class B; **egress free** | $0.015/GB-mo; $4.50/M Class A; $0.36/M Class B | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| **Queues** | 10k ops/day | 1M ops included/mo, +$0.40/M | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| **Workers AI** | 10,000 Neurons/day | $0.011 per 1,000 Neurons | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| **`@cf/baai/bge-m3`** (our embedder) | — | **$0.012 per M input tokens** (1,075 Neurons/M) | same |
| **OpenRouter** | — | model-dependent; see §17.8 | — |

Two things worth reading twice:

1. **Requests to static assets are free and unlimited.** A Next.js app ships a lot of JS and CSS; none of it is billed. This is why the request line stays at $0 far longer than you'd expect.
2. **D1 charges by *rows scanned*, not rows returned.** `SELECT * FROM questions` on a 10k-row table costs 10,000 rows read even if you return one row. Every query in §17.2 must hit an index. This is also why `user_set_stats` exists rather than aggregating on read.

### 17.6 Workload model — 10 users

Assumptions (deliberately generous):

| Assumption | Value |
|---|---|
| Active users | 10 |
| Attempts per user per week | 5 |
| Questions per attempt | 50 |
| **Attempts per month** | **~200** |
| **Answers per month** | **~10,000** |
| Question bank (design target, §24 D-8) | 10,000 questions |
| Generation jobs per month | ~200 (batches of 25) |

Derived usage — dynamic Worker invocations only:

| Request type | Count/month |
|---|---|
| Answer submissions | 10,000 |
| Question prefetches | ~12,000 |
| Start / resume / complete | ~600 |
| Page navigation (RSC renders) | ~5,000 |
| Auth + misc API | ~2,000 |
| **Total billable invocations** | **~30,000** |
| Static asset requests | ~120,000 → **free** |

D1, per 50-question attempt: ~520 rows read (set metadata + 50×[1 question + 4 options], plus correctness verification) and ~310 rows written (answer row + indexes + attempt update + `user_question_seen` upsert + `user_set_stats` upsert, ×50).

| D1 metric | Monthly usage |
|---|---|
| Rows read | ~150,000 |
| Rows written | ~65,000 |
| Storage | ~0.1 GB (10k questions ≈ 3 KB each incl. backstory, options, FTS index) |

### 17.7 The monthly bill at 10 users

| Line item | Usage | Included | Overage | Cost |
|---|---|---|---|---|
| Workers Paid subscription | — | — | — | **$5.00** |
| Worker invocations | 30,000 | 10,000,000 | — | $0.00 |
| Static asset requests | ~120,000 | unlimited | — | $0.00 |
| Worker CPU time | 240,000 ms | 30,000,000 ms | — | $0.00 |
| D1 rows read | 150,000 | 25,000,000,000 | — | $0.00 |
| D1 rows written | 65,000 | 50,000,000 | — | $0.00 |
| D1 storage | 0.1 GB | 5 GB | — | $0.00 |
| Vectorize stored dims | 10.24M | 10M | 0.24M | $0.0001 |
| Vectorize queried dims | 15.36M | 50M | — | $0.00 |
| Workers AI embeddings | 0.6M tokens | 10k Neurons/day | — | $0.00 |
| R2 storage | 0.006 GB | 10 GB | — | $0.00 |
| R2 Class A ops | 200 | 1,000,000 | — | $0.00 |
| Queues operations | 600 | 1,000,000 | — | $0.00 |
| **TOTAL** | | | | **≈ $5.00 / month** |

**≈ ₹440/month** at ~₹88/USD. Rounded, the answer to "what does this cost for 10 users" is: **the $5 Workers Paid subscription, and nothing else.** Every variable line item sits inside its included allowance by two to four orders of magnitude.

And the $5 is not paying for the 10 users — 10 users consume roughly **0.3% of the included request allowance**. It is paying for **auth CPU headroom** (§22 R-1) and for removing the D1 daily write cap.

### 17.8 The real cost is content, not users

Question-bank generation with OpenRouter is the only line item that can produce a meaningful bill, and it scales with **how much content you author**, not with how many people take the quizzes.

Per question: ~200 input tokens amortized (the coverage digest is shared across a batch of 25) and ~450 output tokens (stem + 4 options + explanation + a 3-sentence-plus backstory).

Building a **10,000-question bank** = ~2M input + ~4.5M output tokens:

| Model tier | Example class | Input $/M | Output $/M | Raw cost | With 40% retry/duplicate waste |
|---|---|---|---|---|---|
| Budget | Gemini Flash / GPT-4o-mini class | ~$0.15 | ~$0.60 | ~$3 | **~$4** |
| Mid | Claude Haiku / GPT-4o class | ~$1.00 | ~$5.00 | ~$25 | **~$34** |
| Premium | Claude Sonnet class | ~$3.00 | ~$15.00 | ~$74 | **~$103** |

Steady-state top-up of ~200 new questions/month:

| Tier | Cost/month |
|---|---|
| Budget | ~$0.06 |
| Premium | ~$1.47 |

**Read this as: a one-time content investment of $4–$100 to build the bank, then roughly $0–$2/month to maintain it.** The model choice (decision D-4) is worth an order of magnitude more money than every infrastructure decision in this document combined. Choose it on measured output quality, not on price — a cheap model that produces questions a human rejects 60% of the time is the expensive option.

*(OpenRouter's per-model rates move. Treat the bands above as planning figures and confirm at D-4.)*

### 17.9 How the bill scales

| Monthly active users | Invocations | CPU (ms) | D1 read | D1 write | Est. monthly bill |
|---|---|---|---|---|---|
| **10** | 30k | 240k | 150k | 65k | **$5** |
| **100** | 300k | 2.4M | 1.5M | 650k | **$5** |
| **1,000** | 3M | 24M | 15M | 6.5M | **$5–8** |
| **10,000** | 30M | 240M | 150M | 65M | **~$30** |

The 10,000-user figure breaks down as: requests $6.00 + CPU $4.20 + D1 writes $15.00 + $5 subscription.

**The flat region is the important part.** Going from 10 users to 1,000 users — a hundredfold increase — moves the bill by roughly nothing, because the included allowances are enormous relative to this workload. The user count is not the cost driver. Content volume is, and even that is dominated by the one-time generation spend in §17.8.

### 17.10 Free-tier traps and cost levers

Four limits bind *before* user count does. Only two of them actually matter:

| # | Limit | Why it binds | Severity |
|---|---|---|---|
| 1 | **Workers Free: 10 ms CPU per invocation** | A properly-iterated PBKDF2 hash (~120 ms) is killed mid-request. Auth simply does not work on Free. | **Blocking** — this alone justifies the $5 |
| 2 | **D1 Free: 100,000 rows written per *day*** | Importing or generating 10,000 questions writes ~10,000 question rows + ~40,000 option rows + ~10,000 FTS rows ≈ **60,000 rows — 60% of one day's free budget in a single operation.** | **High** — hits bulk content ops, not quiz-taking |
| 3 | **Vectorize Free: 5M stored dimensions** | At 1024 dims that is **~4,882 questions**. The bank outgrows free Vectorize long before users outgrow anything else. | Medium |
| 4 | Workers Free: 100k requests/day; Queues Free: 10k ops/day | 30k invocations and 600 queue ops per month are nowhere near these. | Non-binding |

> **Doc discrepancy to verify in M11:** the Vectorize pricing page still carries a note stating Vectorize is "only available on the Workers paid plan," while its own table and FAQ describe free-tier allowances. Confirm which applies before assuming a free Vectorize tier exists.

**Note on #2 for M9/M10:** bulk generation and CSV import must be **chunked and paced**, not fired in one batch. On Workers Paid this is a non-issue (50M rows/month), which is a second reason the $5 is worth paying. On Free, a single 10k-question import would consume most of a day's write budget and then start erroring mid-import — the worst possible failure mode, because it leaves a half-imported bank.

**If you genuinely want $0/month**, all three of these are removable:
1. Use a managed auth provider (a free tier covering ~10k MAU removes the CPU requirement) — this is decision D-2.
2. Skip Vectorize: store embeddings as `BLOB` in D1 and compute cosine similarity in the Worker over the ~20 candidates that FTS5 layer 2 already shortlisted. At 10k questions that is a few milliseconds of arithmetic and removes both the Vectorize line item and its 5M-dimension ceiling.
3. Keep the bank under ~4,900 questions.

**Recommendation: pay the $5.** It removes the auth blocker, removes the daily write ceiling that bulk content operations would otherwise hit, and costs less than the coffee you'd drink while debugging a half-finished import.

---

## 18. Testing strategy

### 18.1 Layers

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | `normalize`, `simhash`, scoring, state-machine transitions, validation, digest builder |
| Integration | Vitest + `@cloudflare/vitest-pool-workers` | Real D1 + real migrations, no mocks: services, attempts, dedupe queries, FTS5 |
| Contract | Vitest | Zod schemas against a corpus of real (and malformed) LLM outputs |
| E2E | Playwright | Take a quiz end to end; resume after reload; admin create→publish→play |

### 18.2 Tests that must exist before v0.1

These are the ones that protect the constraints in §2:

1. **Resume integrity:** answer 25 of 50, simulate teardown, start again → same attempt id, `current_index == 25`, exactly 25 answer rows. *(§2.5, §11.4)*
2. **Idempotent answer write:** submit the same answer twice → one row, counts unchanged. *(§2.5)*
3. **One active attempt:** two concurrent starts → one attempt row; the loser receives the winner's attempt. *(§11.4)*
4. **Answer secrecy:** `GET /api/attempts/:id` response body contains no `is_correct`, no `explanation`, no `backstory`. *(§2.6)* — assert on the serialized payload, not the type.
5. **Server-authoritative timer:** submit with a forged client timestamp past the deadline → `409`. *(§11.5)*
6. **Score integrity:** POST a fabricated score to `/complete` → ignored, server recomputes. *(§11.6)*
7. **Authorization:** non-admin hits every `/api/admin/*` route → `403`. Admin A cannot read user B's attempt. *(§16.2)*
8. **No third level:** schema introspection asserts no `parent_id` column exists anywhere. *(§2.1)*
9. **AI never publishes:** run the generation pipeline to completion against a stubbed provider → zero rows in `questions`; all rows in `ai_candidates` with `review_status='pending'`. *(§2.2)*
10. **Dedupe funnel:** a fixture set of 12 candidate questions (3 exact dupes, 3 paraphrases, 6 clean) → exact dupes auto-rejected, paraphrases flagged for review, cleans pass. *(§13)*
11. **Single-correct invariant:** inserting two correct options for one question fails at the DB level. *(§6.4)*
12. **Vectorize disposability:** drop the Vectorize index, run the backfill, verify layer 3 works again — proving D1 is genuinely the source of truth. *(§2.3)*

### 18.3 LLM testing

No live LLM calls in CI. Store a corpus of recorded provider responses under `tests/fixtures/llm/`, including pathological ones (truncated JSON, markdown fences, prose preamble, 3 options, two correct answers, empty backstory, wrong key casing). The parser is tested against all of them. A live smoke test runs manually, never in CI.

### 18.4 Coverage expectations

Domain modules (`modules/**`): high coverage on pure logic and state machines. UI components: covered by E2E rather than unit snapshots. Don't chase a global percentage — the 12 tests above are worth more than 80% line coverage of presentational components.

---

## 19. Observability

- **Structured logs** (`console.log(JSON.stringify(...))`) with `requestId`, `userId`, `route`, `durationMs`. Workers Logs is enabled in `wrangler.jsonc`.
- **Job tracing:** every generation job is queryable end-to-end — job → candidates → promoted questions → review outcome. Store `prompt_version` to correlate quality with prompt changes.
- **Metrics that matter:** jobs succeeded/failed, candidates produced per job, **candidate acceptance rate**, duplicate rate by layer, answer-submit p95 latency, resume rate.
- **The single most important metric: AI candidate acceptance rate.** If it falls below ~60%, either the prompt or the coverage digest is failing, and the cause is discoverable by slicing acceptance rate by `prompt_version` and by `duplicate_count / produced_count`.
- **Error tracking:** a global error boundary in the app, plus a `dead_letter_queue` consumer that records failed jobs rather than dropping them.

---

## 20. Milestone roadmap

Each milestone is one work session for an agent, has a single demo, and does not start until the previous one's exit test passes.

### M0 — Foundation and risk spike
**Goal:** a deployed Worker that reads from D1, with the §3.3 spike checklist green.
**Deliverables:** `create-vinext-app` scaffold; `wrangler.jsonc` with all bindings; `drizzle` schema for `categories`; migration applied local **and** remote; a page that renders a category from D1; `scripts/reindex-fts.ts`; CI running typecheck+lint+test.
**Exit test:** `pnpm dev` renders a seeded category; the same page works on the deployed `*.workers.dev` URL; the FTS5 create/insert/search/reindex cycle passes **against remote D1**; all eight spike checklist items pass.
**Decision gate:** if any spike item fails irreparably → switch to `@opennextjs/cloudflare` here, before writing features.

### M1 — Auth and roles
**Goal:** accounts exist; `/admin` is protected.
**Deliverables:** `users`, `auth_sessions`; register/login/logout; `middleware.ts` guard **plus** per-handler role checks; `modules/auth`.
**Exit test:** register → login → see own email; non-admin GET `/admin` redirects and `/api/admin/*` returns 403; session survives reload; logout clears it. Password CPU cost measured and within the chosen tier's limit (decision D-1).

### M2 — Categories
**Goal:** admin creates a category; it appears on the home grid.
**Deliverables:** `categories` CRUD; `/admin/categories`; home grid with the responsive card layout; `CategoryCard`.
**Exit test:** create "Biology" in admin → refresh `/` → card present, sorted correctly; paginating past 24 categories works.

### M3 — Quiz sets
**Goal:** admin creates sets inside a category; screen 2 renders them.
**Deliverables:** `quiz_sets` CRUD; `/admin/sets`; `/category/[slug]`; `SetCard`; `group_label` sectioning.
**Exit test:** create 6 sets in "Biology" with two group labels → screen 2 shows two labelled sections in the right order; an empty category shows a friendly empty state.

### M4 — Questions (manual)
**Goal:** admin authors questions and attaches them to sets.
**Deliverables:** `questions`, `question_options`, `question_set_questions`; question editor; set membership picker + reorder; `validateQuestion()`; publish/approve flow; FTS5 triggers live.
**Exit test:** create 10 questions with backstories, attach them to "Mock Set 1", publish the set; all 10 appear via the set query in the right order. Attempting to save two correct options fails.

### M5 — Quiz engine v0
**Goal:** a user completes a quiz.
**Deliverables:** `quiz_attempts`, `quiz_attempt_answers`; start/resume; answer submit; reveal; next; `BackstoryRenderer`; result summary.
**Exit test:** complete a 10-question set end to end; correct answers reveal backstories rendered correctly (including a table and a blockquote fixture); final score is right; network response for a pre-answer question contains no correctness data.

### M6 — Persistence, resume, and history  ← **v0.1 ends here**
**Goal:** progress never lost; history visible.
**Deliverables:** immediate idempotent answer writes; `ux_attempt_active` enforcement; resume flow; `user_question_seen`; `user_set_stats`; `/account` dashboard; `/account/history`; attempt review.
**Exit test:** answer 5 of 10, kill the browser process, reopen `/quiz/[setId]` → resumes at question 6 with exactly 5 stored answers. Double-submitting an answer leaves counts unchanged. Two simultaneous starts produce one attempt. The completed attempt appears in history with the right score.

> ### 🚩 v0.1 SHIP GATE
> *Admin creates category → set → 10 manual questions → user takes the quiz → sees backstories → closes halfway → resumes → history is correct.*
> **No AI. No Vectorize. No analytics beyond the dashboard.** If this loop doesn't feel excellent, adding a question factory will not save it.

### M7 — Timer, mock mode, and scoring polish
`server_deadline_at`; countdown UI; auto-submit on expiry; per-question timing; passing percentage; question-map navigator; mobile layout.
**Exit test:** a 1-minute timed set auto-submits at 60 s and scores correctly; a forged late submission is rejected; refreshing does not reset the timer.

### M8 — Account analytics and progress on cards
Dashboard tiles, weak topics, streaks, set progress on screen-2 cards, in-progress banner on screen 1, FTS5 search.
**Exit test:** the set card shows a correct percentage for a partially completed set; search returns a set by a question's text.

### M9 — Admin scale-up
Question bank table with filters and keyset pagination; bulk status changes; CSV import/export (through the funnel); audit log view.
**Exit test:** import 500 questions from CSV — duplicates are flagged, invalid rows are reported with reasons, none silently dropped.

### M10 — AI generation pipeline
`ai_generation_jobs`, `ai_candidates`; OpenRouter client; prompt v1; Zod parsing with JSON repair; queue consumer; R2 raw payload storage; job status API + UI; review queue UI; approve/reject/promote.
**Exit test:** generate 10 questions against a **stubbed** provider → 10 candidates, zero in `questions`. Approve 3 → exactly 3 published questions with options intact. A malformed fixture produces `validation_status='invalid'` with readable errors, not a crash.

### M11 — Dedupe layers 1 and 2
`normalize`, `simhash`, layer-1 hashes on write; FTS5 candidate retrieval; Jaccard scoring; `duplicate_flags` for candidates; duplicate triage UI.
**Exit test:** the 12-question fixture set behaves as specified in §18.2 #10; exact duplicates never reach the review queue; near-duplicates do, with the match shown.

### M12 — Dedupe layer 3 (semantic)
Embeddings via Workers AI; Vectorize index + metadata indexes; layer-3 query; semantic thresholds; backfill script; `sweepExistingQuestions()`.
**Exit test:** the three Linux paraphrases collapse onto the same cluster; deleting the Vectorize index and running the backfill restores layer 3 completely from D1.

### M13 — Coverage-aware generation
Digest builder (retrieve → extract → compress); digest persistence on the job; `preview-digest` endpoint; token budget enforcement; acceptance-rate reporting by `prompt_version`.
**Exit test:** for a topic with 300 existing questions, the digest is < 3,000 tokens, contains the known-covered facts, and a 25-question generation produces a materially lower duplicate rate than the same job with an empty digest.

### M14 — Hardening and launch
Rate limits; backup + restore (actually rehearsed); staging environment; error boundaries; Lighthouse pass on all three screens; accessibility pass (keyboard-only quiz completion, focus management, contrast, screen-reader labels on options); README with runbook.
**Exit test:** the full E2E suite passes on staging; a restore from the nightly backup has been performed successfully at least once; a keyboard-only user can complete a quiz.

### M15 — Post-launch (unscoped)
See §23.

---

## 21. v0.1 definition of done

v0.1 is **M0–M6**. It is done when, on a deployed URL:

- [ ] An admin can log in, create a category, create a set inside it, author 10 questions with 4 options and backstories, attach them, and publish.
- [ ] An anonymous visitor sees the category on the home grid.
- [ ] A logged-in user opens the category, sees the set, and starts it.
- [ ] Answering reveals correctness and a rendered backstory; then advances.
- [ ] Closing the browser at question 5 of 10 and returning resumes at question 6 with 5 answers intact.
- [ ] Completing the quiz shows an accurate summary, and the attempt appears in history with the right score.
- [ ] The set card on screen 2 reflects progress.
- [ ] None of the §18.2 tests 1–8 fail.
- [ ] No AI generation exists in the codebase yet.

---

## 22. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R-1** | Workers **Free**'s ~10 ms CPU limit breaks password hashing | High if free tier | High — auth unusable | Workers Paid, or managed auth. Decide as **D-1** before M1 |
| **R-2** | vinext is `0.0.x` and may break on a needed feature | Medium | High | §3.3 spike in M0 + binding adapter + `next` kept alongside; hard switch point at M0 |
| **R-3** | D1 FTS5 behaves differently in production | Low | Medium | Verified in the M0 spike against **remote** D1 before §13.4 depends on it |
| **R-4** | D1 lacks genuine interactive transactions | Certain | Medium | `db.batch()` for atomic multi-writes; design so no logic spans an await inside a transaction |
| **R-5** | LLM output quality is poor or inconsistent | High | High | Strict Zod + repair pass + human review + acceptance-rate metric sliced by `prompt_version` |
| **R-6** | Duplicate detection over-rejects distinct questions | Medium | Medium | Auto-reject only layer-1 exact matches; everything else is human-triaged (§13.6) |
| **R-7** | Embedding/Vectorize outage blocks generation | Medium | Medium | Layer 3 degrades gracefully and backfills later (§13.8) |
| **R-8** | Generation cost runs away | Medium | Medium | Count caps, digest budget, per-admin daily budget, dry-run preview, per-job cost recording |
| **R-9** | Hierarchy creep — someone adds a third level | Medium | High (rework) | §2.1 + schema test + no admin affordance |
| **R-10** | AI content published unreviewed "just this once" | Medium | Very High (trust) | §2.2 + test #9; the review queue is the only promotion path |
| **R-11** | Answer keys leak to the client | Low | Very High | §2.6 + test #4 asserting on the serialized payload |
| **R-12** | Question bank lost (the product's entire value) | Low | Catastrophic | Nightly D1 export to R2 + **rehearsed** restore in M14 |
| **R-13** | Resume breaks under concurrency (two tabs) | Medium | Medium | Partial unique index + idempotent upserts; tests #1–#3 |
| **R-14** | Backstory markdown is an XSS vector | Low | High | Sanitize; never `dangerouslySetInnerHTML` on raw input |

---

## 23. Backlog (explicitly deferred)

Nothing here is planned. It is a parking lot so good ideas don't derail v0.1.

**Content & authoring:** PDF/Word import with AI extraction; bulk image upload; question versioning and edit history; multi-author workflows with assignments; content review comments; Malayalam/other language support (would require dropping `porter` from FTS5 and adding a `language` filter to dedupe); question difficulty calibration from real attempt data.

**Quiz experience:** flashcards mode; spaced repetition; adaptive difficulty; custom user-built quizzes from weak topics; bookmarking questions; notes per question; "challenge a friend" links; offline PWA mode.

**AI:** AI explaining a *specific* wrong answer on demand; auto-generating backstories for existing questions that lack them; automated fact verification against sources; a question-refinement agent that rewrites rejected candidates; difficulty re-estimation; topic taxonomy auto-suggestion; an adversarial "duplicate hunter" agent that stress-tests the dedupe engine.

**Platform:** leaderboards; streaks with notifications; email digests; certificates/PDF results; payments and premium sets; public API; embeddable quiz widget; native mobile app; analytics for admins (drop-off per question, discriminating power per question).

**Infrastructure:** multi-region read replicas; full-text search over backstories (not just stems); a Postgres migration (only if D1's write throughput becomes the bottleneck — unlikely at this scale).

---

## 24. Open questions — decisions requested

Answering these unblocks the corresponding milestone. Recommended defaults are given so work can proceed if you'd rather not decide now — but **D-1 must be decided before M1**.

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| **D-1** | Are we on **Workers Paid ($5/mo)**? Workers Free's ~10 ms CPU limit will fail password hashing. | **Yes, Workers Paid.** It also raises subrequest limits, which AI generation benefits from. | M1 |
| **D-2** | Auth: email+password with a `role` column, or Google OAuth, or a managed provider? | Email+password with a role column. Simplest thing that works; OAuth can be added later without changing `users`. | M1 |
| **D-3** | Is there an existing question bank to import (CSV/Excel/PDF)? If yes, in what shape? | If yes, it should become the **first** content and drives M9 earlier. | M9 ordering |
| **D-4** | Which OpenRouter models should be selectable, and which is the default? | Default to one strong model (e.g. `anthropic/claude-sonnet-4.5`) plus one cheap model for bulk; finalize at M10 against real output quality. | M10 |
| **D-5** | How rich must the backstory be? Markdown only, or images/diagrams too? | Markdown only for v0.1 (headings, lists, tables, blockquotes, code, links). Images mean R2 upload UI — real scope, M15+. | M5 |
| **D-6** | Can anonymous visitors take quizzes, or is login required? | Allow browsing anonymously; require login to *start* a quiz, since progress needs an owner. | M5 |
| **D-7** | Is Malayalam (or any non-English) content required? | Assume English-only for v0.1. Non-English changes FTS5 tokenization and dedupe thresholds. | M11 |
| **D-8** | Expected scale in year one? (users, questions, concurrent quiz-takers) | Planning for ~10k questions and ~1k users. Well inside D1/Workers limits; would change the caching plan, not the schema. | M8, M14 |
| **D-9** | Does "covered the set completely" gate re-taking a set, or just warn? | Warn + show the best score; never block. Blocking a retake is hostile. | M6 |
| **D-10** | Should questions be reusable across sets by default, or is that an admin-only power? | Reusable — the N:M join is already there and it's what makes the bank valuable. | M4 |

---

## 25. Appendices

### 25.1 Generation prompt template (v1)

**System:**

```
You are an expert exam-question author for competitive and school-level quizzes.
You write multiple-choice questions with exactly four options.

HARD RULES
1. Output ONLY valid JSON. No markdown fences, no commentary, no preamble.
2. Match the requested JSON schema exactly.
3. Exactly one option is correct.
4. Distractors must be plausible and of similar length and specificity to the answer.
5. Never write "All of the above" or "None of the above".
6. The stem must not contain the correct answer's wording.
7. Every question needs a backstory of at least 3 sentences of genuine context —
   history, mechanism, or a memorable fact. Not a restatement of the answer.
8. Do not create questions that test facts listed under ALREADY COVERED.
```

**User:**

```
TOPIC: {{topic}}
SUBTOPICS: {{subtopics}}
DIFFICULTY: {{difficulty}}
STYLE / EXAM BODY: {{examBody}}
COUNT: {{count}}

ADMIN BRIEF:
{{brief}}

ALREADY COVERED (do NOT test these facts):
{{coverageDigest}}

{{#if avoidTopics}}
ADDITIONALLY AVOID:
{{avoidTopics}}
{{/if}}

Return JSON:
{
  "questions": [
    {
      "stem": "...",
      "options": [{"key":"A","body":"..."}, {"key":"B","body":"..."},
                  {"key":"C","body":"..."}, {"key":"D","body":"..."}],
      "correct_option_key": "B",
      "explanation": "one or two sentences",
      "backstory": "markdown; 3+ sentences; may include a table or list",
      "difficulty": "medium",
      "topic": "{{topic}}",
      "tags": ["..."]
    }
  ]
}
```

### 25.2 Coverage digest format

```
ALREADY COVERED — {{topic}} ({{existingCount}} questions in bank)
Do not create questions testing these facts. If covering a listed concept is
unavoidable, it must require a materially different, deeper fact.

- Linux — creator — Linus Torvalds
- Linux — first release — 1991
- Linux — mascot — Tux
- GNU — founder — Richard Stallman
- Ubuntu — parent distribution — Debian
- Debian — founder — Ian Murdock
- systemd — creator — Lennart Poettering
- Red Hat — acquired by — IBM, 2019
- POSIX — purpose — OS portability standard
- kernel vs shell — distinction — core vs interface
… (capped at {{digestTokenBudget}} tokens)
```

### 25.3 Sample seed question

```json
{
  "stem": "Which organisation developed the Multics operating system?",
  "options": [
    { "key": "A", "body": "IBM" },
    { "key": "B", "body": "MIT, General Electric, and Bell Labs" },
    { "key": "C", "body": "Xerox PARC" },
    { "key": "D", "body": "Microsoft" }
  ],
  "correct_option_key": "B",
  "explanation": "Multics was a joint project between MIT, General Electric, and Bell Labs.",
  "backstory": "### Project MAC\n\nMultics (Multiplexed Information and Computing Service) was a pioneering **time-sharing** operating system begun in 1964 as a joint effort by MIT, General Electric, and Bell Labs.\n\n| Year | Milestone |\n|------|-----------|\n| 1964 | Project MAC begins at MIT |\n| 1969 | Bell Labs withdraws from the project |\n| 1970s | Multics enters commercial service |\n\n> Bell Labs' withdrawal in 1969 freed Ken Thompson and Dennis Ritchie to build something simpler — which became **Unix**.\n\nMultics introduced many ideas that later became standard: hierarchical file systems, dynamic linking, and ring-based security.\n\n**Sources**\n- [Multics history — MIT](https://example.org/multics)",
  "difficulty": "medium",
  "topic": "Operating Systems",
  "tags": ["history", "multics", "time-sharing"],
  "year": 2025,
  "exam_body": "Kerala PSC",
  "source": "Standard OS textbooks"
}
```

### 25.4 Dedupe worked example

```
CANDIDATE: "Who was the original developer of the Linux kernel?"

LAYER 1  normalize → "who was the original developer of the linux kernel"
         sha256 → 3f9a…   vs bank hashes → no match                  CLEAN

LAYER 2  FTS5 MATCH "original OR developer OR linux OR kernel"
         → shortlist: #1842 "Who created Linux?" (jaccard 0.33)
                      #2077 "Who maintains the Linux kernel?" (0.50)
         thresholds: reject ≥0.85, review ≥0.65 → BELOW THRESHOLD    CLEAN

LAYER 3  embed → cosine vs #1842 "Who created Linux?" → 0.94
         threshold: auto-flag ≥0.95, review ≥0.85 → 0.94             FLAG

VERDICT  semantic_dup, similarity 0.94, bestMatch #1842, autoReject false
         → surfaces in the review queue with both questions side by side
         → human chooses Keep / Reject / Merge
```

*This is the user's exact scenario, and it demonstrates why layer 3 exists: layers 1 and 2 both missed it, and the flag — not an automatic delete — is the right outcome at 94%.*

### 25.5 Glossary

| Term | Meaning |
|---|---|
| **Category** | Depth-1 content node. Appears as a card on the home grid. |
| **Quiz Set** | Depth-2 content node. Belongs to exactly one category. The thing a user plays. |
| **Question** | A stem, 4–5 options, one correct, an explanation, and a backstory. |
| **Attempt** | One user's run through one set. The resume unit. |
| **Backstory** | The rich post-answer explanation panel. |
| **Coverage digest** | The compressed list of already-covered facts fed to the LLM to reduce repetition. |
| **Candidate** | An AI-generated question awaiting human review. Not a Question. |
| **Layer 1/2/3** | Exact-hash / FTS5+Jaccard / embedding-cosine duplicate detection. |
| **Funnel** | The single `validate → normalize → dedupe → insert` path all questions take. |

### 25.6 Changelog

| Date | Change |
|---|---|
| 2026-09-14 | Initial plan. Content model frozen at 2 levels (Category → Set) per explicit instruction. Stack fixed on vinext + D1 + Drizzle + shadcn/ui + OpenRouter + Vectorize. Three-layer dedupe funnel specified. Milestones M0–M15 defined. Decisions D-1…D-10 raised. |
| 2026-09-14 | Added §17.5–17.10: verified deployment cost model. Confirmed against live Cloudflare pricing. Result: **~$5/month at 10 users** and effectively flat to ~1,000 users; real cost is one-time content generation ($4–$103 for a 10,000-question bank), not infrastructure. Identified Workers Free's 10 ms CPU cap as the binding auth blocker and D1's 100k rows/day free write cap as the bulk-import hazard. |
| 2026-09-14 | Product renamed to **Quiz Master Supreme**. Added §0.1 build status. **M0 implemented and verified locally** — see §0.1. Corrected §3.3 (vinext resolved at `1.0.0-beta.9`, spike passed) and §13.3 (SimHash switched from 3-grams to unigrams; threshold 6 → 16, based on measured distances). Recorded five as-built deviations in §0.1. Outstanding: the deploy half of M0's exit test. |
| 2026-09-14 | **M1 implemented and verified locally.** Decisions D-1/D-2/D-3 answered: Google-only login (direct OIDC, not Firebase), which makes D-1 (Workers Paid) moot — see §0.1 #6. Added migration `0002` (Google OIDC columns + `oauth_states`). Recorded three further as-built deviations (§0.1 #6–#8), including the `setDbForTests` test seam replacing `@cloudflare/vitest-pool-workers`. Test count 37 → 61. |
| 2026-09-14 | **M2 implemented and verified locally.** Admin category CRUD: `/admin/categories` management screen, validation (title/slug/icon/accent allowlists), slug-conflict 409s, reorder, publish/draft toggle, archive-not-delete (§2.1 RESTRICT FK), audit trail on every mutation. Verified live with a minted admin session: create → publish → home grid, 401/409/422 behaviours. |
| 2026-09-14 | **M3 implemented and verified locally.** Admin quiz-set CRUD at `/admin/sets`: subject picker, group labels, mode/difficulty/timer/question-limit/passing/shuffle, reorder within a subject, publish with one-time `publishedAt` stamping, archive. **Per-category slug uniqueness** enforced in the domain and covered by tests (the same slug IS allowed in different subjects). Added `pnpm dev:admin-token` — a local-only admin session minter for testing without Google. Test count 61 → 73. M3 exit test passed live. |
| 2026-09-14 | **M4 implemented and verified locally.** The `createQuestion` funnel (§2.9) with validation, normalization, layer-1 dedupe and audit; question bank UI with FTS5 search; set membership UI; `BackstoryRenderer` (react-markdown + GFM, React-tree output, no raw HTML) shared by editor and — from M5 — the runner and review screen. Added `modules/dedupe` with the final `DedupeVerdict` shape; layers 2/3 are reported as `degraded` rather than silently assumed clean. **Two real bugs found and fixed:** attachment order came from a SQL `IN` result instead of the caller's order (question order IS the paper — now regression-tested), and the backstory XSS test initially asserted on the word rather than the unescaped marker. Test count 73 → 100. M4 exit test passed live. |
| 2026-09-14 | **M5 implemented and verified locally.** Quiz engine per §11: start-or-resume (race-safe via `ux_attempt_active`), frozen question order, answer-stripped payloads (§2.6), idempotent answer upserts (§2.5), server-authoritative deadline with a submission grace window (§11.5), server-side scoring where blanks count against the candidate (§11.6), expiry auto-scoring, and a guarded reveal endpoint that refuses unanswered questions. Progress module added (`user_question_seen`, `user_set_stats` rollup). UI: the runner (timer rail, question map, inline reveal with backstory) and the results/review page. **One real bug fixed:** `settleIfExpired` ran before the deadline check in `submitAnswer`, making the grace window dead code — every slightly-late answer was rejected. Results live at `/attempts/:id` rather than the sketched `/quiz/:setId/summary`, because the summary belongs to an attempt, not a set. Test count 100 → 119, including all six §18.2 engine tests. |
| 2026-09-14 | **M6 implemented and verified locally — v0.1's ship gate is met locally.** Account dashboard (totals, accuracy, sets completed, weakest topics), paginated history, progress on the screen-2 cards, and the "Continue" banner on screen 1. All read-side reporting lives in `modules/progress/dashboard.ts`, bounded with GROUP BY and LIMITs. Test count 119 → 129. **Outstanding for a real launch: the deploy half** — nothing has run on a deployed Worker yet, and the Google login round-trip needs real OAuth credentials. |
| 2026-09-14 | **M7 + M8 implemented and verified locally.** M7: server-measured, capped per-question timing; accumulated time on task; elapsed counter; low-time warning; sticky mobile bar; timing surfaced on the results page. Found that `timeSpentMs` was declared but **never written** since M5 — every attempt recorded zero time. M8: day streak (IST-bucketed, from answers), and public search that finds a set by its question text. New `modules/search` is recorded as the single documented exception to §2.4 (read-only cross-module composition), because splitting the join across three modules would have meant three round trips. Also fixed a real UX gap the M7 test exposed: a timed-out attempt used to vanish silently when the set was reopened — now announced with a link to the result. Test count 129 → 144. |
| 2026-09-14 | **M9 implemented and verified locally.** CSV import/export, bulk status, audit-log view. Importer runs the SAME `validateQuestion()` and layer-1 dedupe as manual authoring but batches the I/O (per-row `createQuestion` would be ~1,500 round trips for 500 rows). **Three real bugs found and fixed — two of them production-grade:** (1) a dry run omitted the rows that *would* have been created, the exact silent-drop failure the milestone exists to prevent; (2) the FTS hit list was fed back through `inArray`, and D1 caps bound parameters at ~100, so a broad search generated ~509 parameters and **failed outright** — search would have broken on any real-sized bank; fixed with a subquery so the MATCH string is one parameter, which also makes `ORDER BY rank` apply to the candidate set; (3) `meta.changes` counts physical writes *including index entries*, so bulk-updating ONE question reported "updated 7" — the admin-facing counts were fiction, now resolved with a SELECT first. `detachQuestions` had the same over-reporting. Test count 144 → 174. |
| 2026-09-14 | **M13 implemented and verified locally.** Coverage-aware generation: `buildCoverageDigest` (exact-topic pass → conjunctive FTS top-up → concept keys → token budget), digest persisted on every job, `preview-digest` admin endpoint, and prompt-acceptance reporting by `prompt_version` surfaced on `/admin/generate`. **Live check:** "Operating Systems" digest is 5 on-topic concepts with 0 off-topic strays — the earlier OR-based FTS pull (Jupiter, binary numbers) is gone; unknown topic → empty block; "Linux kernel" → 2 on-topic. **Honest limitation:** the exit-test half that compares duplicate rates with vs without a digest requires a real model call and stays unverified until an OpenRouter key is configured. Test count 241 → 262. |
| 2026-09-14 | **M12 implemented and verified locally with injected deps.** Dedupe layer 3: `Embedder` and `VectorIndex` interfaces (same discipline as `LlmProvider`), Workers AI + Vectorize adapters, feature-hash and in-memory implementations for tests/dev, layer 3 wired into the shared funnel, and a `question_embeddings` backfill. **§2.3 proved by test:** destroy the index, rebuild from D1 alone, layer 3 works again. Degradation is explicit (`degraded: ["semantic"]`), never a false "clean". **One honesty fix during live verification:** the development fallback was writing `question_embeddings` rows while indexing into memory, so the database asserted vectors existed that did not — `persist: false` in fallback mode now keeps coverage truthful. The real Workers AI / Vectorize round trip is **not verified** and the bindings remain commented so local dev cannot break. Test count 223 → 241. |
| 2026-09-14 | **M10 + M11 implemented and verified locally.** M10: AI generation pipeline with a human review gate. **Discovered constraint:** vinext owns the Worker entry (`fetch-handler` re-exports a virtual entry) and has no `queue()` hook, so a Cloudflare Queue consumer would mean replacing that entry — the pipeline is therefore queue-agnostic and advances in two bounded steps; `runGenerationStep` is what a consumer would call. R2 enabled for raw-response archival. Honestly **not verified live: the OpenRouter round trip**, which needs a real key — request shape and every failure mode are covered by tests against an injected `fetch` instead. M11: dedupe layer 2 (FTS5 + Jaccard) with settings-backed thresholds, a bank sweep, and triage UI. **One real bug:** an empty `sql` fragment inside `and()` rendered as a dangling `and )` — a SQL syntax error — breaking 24 tests until conditions were built conditionally. Test count 174 → 223. |
