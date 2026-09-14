# PIPELINE-PLAN — Quiz Master generation pipeline

**Status:** **ALL PHASES SHIPPED** — P0 (loop), P1 (review UX), P2 (grounding),
P3 (telemetry/docs). Migrations `0007` + `0008`, 289 tests green. Decisions resolved (§13).
Supersedes the "one big call" assumption in `REVAMP-PLAN.md` §3; builds on what already
ships (auto-opening batch review, flagged duplicates with the matched question, Accept
override, migration `0006`).

**The one-sentence idea:** a user request is one **Generation Job**, but internally it is
many small **generation calls** that each get filtered, deduplicated and fed forward into
the next call's context — so quality stays high across 200 questions and the permanent
question bank becomes the system's memory.

---

## 0. Why this shape (the cost reality that drives it)

DeepSeek V4 Flash 0731 on OpenRouter is roughly **$0.05 / M input** and **$0.16 / M output**.
A 25-question call (≈5k in, ≈8k out) costs:

```
input   5,000 / 1M × $0.05 = $0.00025
output  8,000 / 1M × $0.16 = $0.00128
                            ─────────
                    per call ≈ $0.0015
```

| Target | Calls (25/call) | +25% refill | Approx LLM cost |
|---|---|---|---|
| 25 | 1 | 1.3 | **$0.002** |
| 100 | 4 | 5 | **$0.008** |
| 200 | 8 | 10 | **$0.015** |
| 300 | 12 | 15 | **$0.023** |
| 500 | 20 | 25 | **$0.038** |

**Design implication:** never optimise for fewer model calls. Optimise for *question
quality and diversity*, and spend the calls. A 200-question job is ~1.5 cents; one extra
refill round costs less than a rounding error.

**Grounding is the one thing worth optimising — and the naive way is the expensive way.**
OpenRouter's web search is billed **per request**, not per question: Exa (the default
fallback for models without native search, which includes DeepSeek) is **$0.007 per
search request** for up to 10 results; Parallel is $0.001–$0.005; Perplexity $0.005.
Those results are then injected into the prompt as text (~2,000–4,000 chars per result),
so they are *also* charged as input tokens on whichever call carries them. Grounding
**every batch** with `:online` would therefore cost 8 × $0.007 = **$0.056** for a
200-question job — about 4× the entire generation cost, and the results would be sent 8
times over. Grounding **once per job** into a shared pool costs $0.007 once, and the pool
is reused as plain text by every batch. Repeated topics hit the 14-day cache: **$0**.

---

## 1. Current state → target state (gap analysis)

| Area | Today | Target |
|---|---|---|
| Call sizing | One call asks for the whole shortfall (up to 50) with a token budget derived from the count | **Fixed internal batch size (default 25)**; N questions = ⌈N/25⌉ calls + refills |
| Count semantics | `producedCount` = rows stored, **including** flagged duplicates; backfill only when the model returns fewer rows | `requestedCount` = **target ACCEPTED (unique) questions**; loop **refills** until reached or a stop condition fires |
| Cap | `MAX_REQUESTED = 50` | **300 default** (configurable), UI presets 25/50/100/200/300 |
| Job progress | `backfill_round`, `produced/valid/duplicate` counters | Per-**batch** records (asked/produced/accepted/flagged/tokens/cost/status) + `accepted_count` on the job |
| Context | Bank coverage digest + accepted stems appended per round | Same, plus a compact **covered-concept list** that grows per batch; optional **grounding source pool** |
| Grounding | `sources` free-text field only | **Grounding stage**: capped web research + user sources → shared source pool, cached in D1 |
| Review | Flat list; **all** non-rejected committed | Grouped **by batch**, per-batch **Regenerate**, per-question **selection** for commit |
| Duplicates | Flagged, rejected by default, match shown, Accept override | **Unchanged** — this part is already right (3 bands: accept / flag / reject) |

Everything below the "Filter" line already works; the work is in the loop, the batch
records, grounding, and the review UX.

---

## 2. Architecture: three separate layers

```
┌─────────────────────┐   ┌──────────────────────┐   ┌───────────────────────┐
│  GENERATION LAYER   │ → │  FILTERING LAYER     │ → │  HUMAN + STORAGE      │
│                     │   │                      │   │                       │
│ prompt building     │   │ normalize            │   │ review UI             │
│ batching            │   │ validate             │   │ accept / reject       │
│ provider calls      │   │ dedupe vs bank       │   │ override duplicate    │
│ grounding context   │   │ dedupe vs this job   │   │ edit                  │
│                     │   │ 3-band verdict       │   │ add to Q Set          │
└─────────────────────┘   └──────────────────────┘   └───────────────────────┘
        │                            │                            │
   modules/ai                  modules/dedupe            modules/ai commit +
   modules/grounding           modules/questions          modules/catalog
```

**Rule:** the AI proposes, the filter judges similarity, the human decides what becomes
permanent. The model never writes to `questions`; only `commitJobToSet()` does, and only
for what a human kept.

---

## 3. The pipeline, stage by stage

### S1 — Generation brief (user input)

```
Topic              [ Tech CEOs                        ]
Target questions   [ 200 ]            (accepted target)
Batch size         [ 25 ]   (advanced; 10–30)
Difficulty         [ medium ▾ ]
Audience/target    [ Kerala PSC exam                  ]
Instructions       [ focus on 2015–2025 changes       ]
Sources            [ https://… ]      (optional, free)
Web grounding      [x] Ground once per job, reuse for every batch
Model              [ deepseek/deepseek-v4-flash-0731  ]
```

Validation: `1 ≤ target ≤ MAX_REQUESTED (300)`; `5 ≤ batchSize ≤ 30`; batchSize default 25.

### S2 — Context preparation (once per job)

```
        ┌─────────────────┐
        │ Topic + sources │
        └────────┬────────┘
                 ▼
        sources given? ──yes──► use them directly (search cost $0)
                 │ no
                 ▼
      ┌──────────────────────────────┐
      │ GROUNDING RESEARCH CALL      │   ONE provider call, not one per batch
      │ model + web plugin           │   engine: exa (default) | parallel | native
      │   → fact sheet + citations   │   max_results: 5
      │   → url_citation annotations │   billed once: ~$0.007 + result tokens
      └──────────────┬───────────────┘
                     ▼
      ┌──────────────────────────────┐
      │ SOURCE POOL (stored on job)  │   grounded extracts + citations
      │  reused verbatim by every    │   + user sources
      │  batch prompt as plain text  │   + bank coverage digest
      └──────────────────────────────┘
```

- **One research call, many batches.** The grounding call's prompt is "research this
  topic and return a structured fact sheet with citations", *not* "write questions". Its
  output plus the response's `url_citation` annotations become the pool.
- **Per-batch calls never enable search.** They embed the pool as text. Enabling
  `:online`/the web plugin on a generation call would pay the per-request search fee on
  every batch and re-inject the same results each time.
- **Bank coverage digest** (`modules/ai/coverage.ts`, already built): the concepts the
  bank already covers for this topic, budget-capped by tokens.
- **Grounding cache** (`grounding_cache` table): sha256(normalised topic + sources +
  engine) → `{queries, extracts, citations, costUsd, fetchedAt}` with a TTL (default 14
  days). A repeat topic costs **$0** and is marked `grounding_cached = 1`.

### S3 — Split generation (the core change)

```
target = 200, batchSize = 25

call 1 → ask for 25   … accepted  23   flagged 2
call 2 → ask for 25   … accepted  21   flagged 4
call 3 → ask for 25   … accepted  24   flagged 1
…
call 8 → ask for 25   … accepted  22   flagged 3
                       ─────────────────────────────
                       accepted 178 / 200 → REFILL
```

- Each call is a normal provider call with `max_tokens` sized for `batchSize`
  (`outputBudgetFor(batchSize, model)`), versioned prompt, and the **shared** context:
  source pool + bank digest + this job's covered concepts.
- Sequential, never parallel (see §7): batch *k+1* must see what batch *k* produced.
- One call per HTTP `/step` request, so no request owns the whole job and a closed
  browser loses nothing.

### S4 — Normalize each batch

Parse with the existing repair chain (fences, prose wrapper, truncation), validate each
question individually (`validateQuestion`). One malformed item rejects itself, never the
batch. Invalid items are counted and reported, not stored.

### S5 — Filter each batch (3-band verdict)

Every valid candidate is compared against **all three references**:

```
candidate
   │
   ├── vs permanent bank        (every active question, in any Q Set)
   ├── vs earlier batches       (candidates already accepted in this job)
   └── vs this batch            (questions earlier in the same response)
                │
                ▼
        Jaccard / exact-hash score
                │
   ┌────────────┼─────────────────────┐
   ▼            ▼                     ▼
 LOW        MEDIUM                 HIGH
 accept     FLAG + reject          REJECT by default
            by default             + show match
            + show match
            + reason
```

| Band | `dedupe_status` | Default | UI |
|---|---|---|---|
| low similarity | `clean` | accepted, counts toward target | normal card |
| uncertain | `possible_dup` | **rejected**, does not count | amber badge + reason + matched question + **Accept** |
| near | `near_dup` | **rejected**, does not count | amber badge + match |
| identical | `exact_dup` | **rejected**, does not count | red badge + match |

Nothing is ever hidden: every candidate is stored and rendered. Accepting one clears
`rejected`; on commit it is inserted through the explicit `allowDuplicate` override.

**Only `clean` counts toward the target.** Flagged rows are a visible by-product, not
progress.

### S6 — Refill loop until full

```
while accepted < target
      and calls_made < max_calls
      and not saturated:

    shortfall = target − accepted
    ask = min(batchSize, max(shortfall, MIN_REFILL))
    run one batch (S3–S5)
    merge accepted into the job's covered-concept list
    write the batch record

terminal:
    accepted >= target            → succeeded (may overshoot by < batchSize)
    calls_made == max_calls       → partial (honest shortfall report)
    saturation detected           → partial ("the bank already covers this topic")
```

- `MIN_REFILL = 5` so the last call is never a degenerate 1-question prompt.
- **Saturation**: if two consecutive batches yield < 25% new accepted questions, stop
  and say so rather than burning calls on a topic the bank already covers.
- **Overshoot** is allowed and reported (`200 requested · 204 accepted`): more good
  questions for the same pennies is not a problem.

### S7 — Review screen opens automatically

Already shipped; keep it: the batch view mounts when the job is created and refreshes
after every call, and the panel scrolls it into view when the run finishes. The reviewer
never refreshes and never clicks "Review batch".

### S8 — Generated set, grouped by batch

```
Batch 1 · asked 25 · 23 accepted · 2 flagged        [ Regenerate this batch ]
  ✓ Q1  …
  ✓ Q2  …
  ⚠ Q3  Possible duplicate — "Who is the CEO of Apple?"  [Accept]
  …
Batch 2 · asked 25 · 21 accepted · 4 flagged
  …
```

### S9 — Human review

Per question: **Accept / Reject**, **override** a duplicate rejection, **inspect** the
matching existing question (link into the bank), **edit** (opens the question editor), and
per batch: **Regenerate this batch** (supersedes that batch's rows and re-runs one call —
weak batch 6 costs one call, not a whole re-run).

### S10 — Add to Q Set

Select individually or **bulk select**; then **Add to existing Q Set** or **Create a new
Q Set and add**. Commit inserts them as `active` questions and attaches them in order.
Publish the set and they are playable immediately.

### The loop that makes it smarter over time

```
        committed questions
                │
                ▼
        PERMANENT POOL ──────────────┐
                │                    │
                │   next job's digest │
                ▼                    │
        new generation ──────────────┘
```

Job 1: the bank knows nothing about Tech CEOs → expects 200 accepted from ~10 calls.
Job 10: the bank holds 600 reviewed Tech CEO questions → the digest is richer, more
candidates are flagged as duplicates, and the **refill loop supplies genuinely new
concepts** instead of the model rehashing Tim Cook. The model needs no memory; the
database is the memory.

---

## 4. Data model changes (migration `0007`)

### `ai_generation_jobs` — add
| Column | Type | Purpose |
|---|---|---|
| `accepted_count` | INTEGER NOT NULL DEFAULT 0 | clean, un-flagged questions — the number the loop drives on |
| `batch_size` | INTEGER NOT NULL DEFAULT 25 | internal call size for this job |
| `max_calls` | INTEGER NOT NULL DEFAULT 20 | hard cap on provider calls |
| `covered_concepts` | TEXT (JSON) | the job-local "already generated" list, fed to later batches |
| `source_pool` | TEXT (JSON) | grounded extracts + user sources, shared by every batch |
| `grounding_cost_usd` | REAL | search cost attributed to the job |
| `grounding_cached` | INTEGER NOT NULL DEFAULT 0 | 1 when the pool came from cache (cost $0) |

(`backfill_round` is retained as **`calls_made`** — documented, not renamed, to avoid a
rebuild; it already counts model calls.)

### New table `ai_generation_batches`
| Column | Notes |
|---|---|
| `id`, `job_id` (FK cascade) | |
| `batch_no` | 1..n |
| `asked`, `produced`, `accepted`, `flagged` | per-call outcome |
| `status` | `running` / `succeeded` / `failed` / `superseded` |
| `prompt_tokens`, `completion_tokens`, `cost_usd`, `duration_ms` | per-call cost |
| `raw_response_key` | R2 object for this call |
| `error_code`, `error_message` | per-call failure, retryable in isolation |
| `started_at`, `finished_at` | |

This is what makes **batch-level recovery** possible: a failed or weak batch is a row
with its own state, and `Regenerate` supersedes just that row's candidates.

### `ai_candidates` — add
| Column | Purpose |
|---|---|
| `batch_no` | which internal call produced it (grouping + regenerate) |
| `superseded` | 1 when replaced by a regenerate; kept for audit, excluded from commit |

### New table `grounding_cache`
`key` (PK, sha256 of normalised topic+sources+provider) · `topic` · `payload` (JSON) ·
`queries` · `cost_usd` · `fetched_at` · `expires_at`.

---

## 5. Job state machine

```
queued
  │  (first /step)
  ▼
grounding ──► generating ──► refilling ──► succeeded
                  │              │              (accepted >= target)
                  │              └──► partial   (max_calls or saturation)
                  ├──► failed    (provider error on the FIRST call / unparseable job)
                  └──► cancelled (admin)
```

- A failed call **inside** the loop is a batch failure, not a job failure: record it,
  retry that batch once, and continue. Only a first-call failure or an unparseable job
  aborts.
- Every transition is audited; `Done` is reported to the client so the UI stops looping.

---

## 6. Cost & guardrails

| Guardrail | Default | Why |
|---|---|---|
| `MAX_REQUESTED` | 300 | bounded job size |
| `batchSize` | 25 (10–30) | quality sweet spot |
| `max_calls` | `⌈target/batchSize⌉ + 40%` | refills can't run away |
| Grounding calls / job | **1** | billed per request, so one call per job, never per batch |
| Grounding engine | `exa` (auto) — configurable | Exa $0.007/req (10 results); Parallel $0.001–0.005; Perplexity $0.005 |
| Grounding results | `max_results: 5` | result text is charged as input tokens on the call that carries it |
| Grounding TTL | 14 days | repeat topics cost $0 and are marked `grounding_cached` |
| Per-job cost ceiling | `app_settings` | stop before spending |
| Per-admin daily budget | `app_settings` | existing lever |

Prices live in **one place** (`modules/ai/provider.ts` `PRICE_PER_MILLION`, or
`app_settings` if we want them tunable) and must be corrected as part of this work:

| Model | Input /M | Output /M |
|---|---|---|
| `deepseek/deepseek-v4-flash-0731` | $0.05 | $0.16 |
| `deepseek/deepseek-v4.1-flash` | $0.15 | $0.60 |

Every batch record stores its own tokens and cost, so the job total is a sum of measured
numbers, never an estimate.

---

## 7. Concurrency, resumability, idempotency

- **Sequential batches (chosen).** Batch *k+1* depends on batch *k*'s accepted set and
  concepts. Parallel batches would lose that and duplicate work. Optional future
  optimisation: 2-way parallelism with a frozen pre-job snapshot, only if a job ever
  becomes time-bound (it is not — 10 sequential calls is ~2 minutes).
- **Resumable.** All state is in `ai_generation_jobs` + `ai_generation_batches` +
  `ai_candidates`; the browser closing mid-job loses nothing. The client re-drives
  `/step` until `done`.
- **Idempotent.** A terminal job is returned unchanged; a `running` batch is completed
  before a new one starts, so a double-click cannot double-generate.
- **Re-parse safe.** The raw response is archived per batch in R2, so a bug in the
  parser can be diagnosed (or a batch re-ingested) weeks later.

---

## 8. Grounding design (OpenRouter)

OpenRouter exposes grounding two ways; we use **one research call per job**, never a
searching generation call.

| Mechanism | Shape | When the model searches | Cost |
|---|---|---|---|
| **`web` plugin** (chosen for v1) | `plugins: [{ id: "web", engine, max_results, include_domains }]` (or `:online`) | exactly **once** per request | request fee + result tokens |
| `openrouter:web_search` **server tool** (upgrade path) | `tools: [{ type: "openrouter:web_search" }]` + `max_total_results` | model decides, **multiple** searches per request | one request fee **per search** |
| `openrouter:web_fetch` | separate tool | n/a | free (OpenRouter HTTP) or $0.001 via Exa extraction |

**Engine for DeepSeek:** no native search, so the plugin falls back to **Exa**. We pin it
explicitly so behaviour never changes silently:

| Engine | Mode | Per request | Notes |
|---|---|---|---|
| `exa` (default) | `auto` | **$0.007** | includes 10 results, +$0.001 each beyond |
| `exa` | `deep-lite` / `deep` | $0.012 | slower, deeper research |
| `parallel` | `turbo` / `fast` | $0.001 | cheapest; English/Japanese |
| `parallel` | `basic` / `advanced` | $0.005 | broad language support |
| `perplexity` | — | $0.005 | ranked results |

Result text is injected into the prompt as Exa *highlights*, typically **2,000–4,000
characters per result**, so 5 results ≈ 10–20k characters ≈ **3–5k input tokens** — charged
as normal input on the call that carries them. That is why the grounding call is a
*research* call with a generous output budget, and why the pool is then reused as plain
text rather than re-searched.

```
modules/grounding/
  index.ts     → buildSourcePool({ topic, sources, settings }) : SourcePool
  provider.ts  → GroundingProvider interface + no-op default
  openrouter.ts→ the web-plugin research call; reads url_citation annotations
  cache.ts     → D1 grounding_cache read/write + TTL
```

- `SourcePool = { extracts: [{title, url, excerpt}], citations: [url], queries: string[],
  costUsd: number, cached: boolean }` — stored on the job as JSON.
- **User sources win**: if the admin supplied sources, the search is skipped entirely
  (cost $0) and those sources become the pool.
- **No API key / grounding off** → the stage is a no-op and the pipeline behaves exactly
  as it does today. Grounding is never a hard dependency.
- **Never** put `:online` or the web plugin on a per-batch generation call: that would
  pay the per-request search fee on every batch and re-inject the same results each time
  (8 batches × $0.007 = $0.056, ~4× the generation cost, for zero extra information).
- Citations come from the response's `annotations[]` (`url_citation` → url, title,
  content), so every grounded question can carry a real source URL.

## 9. UI changes

| Screen | Change |
|---|---|
| Generate form | target count input (up to 300), batch size (advanced, default 25), grounding toggle, cost preview |
| Progress | `Batch 3 of 8 · 68 accepted of 200 · 7 flagged · refilling` with a per-batch list and running cost |
| Batch review | grouped by batch; per-batch header + **Regenerate this batch**; per-question Accept/Reject/override/inspect; **checkboxes + bulk select** for commit |
| Commit bar | `Add 184 selected to Q Set` → existing set or new set |
| Job list | per-job line: target, accepted, flagged, calls, cost |

---

## 10. Failure modes

| Failure | Behaviour |
|---|---|
| Provider error on one call | batch row `failed`; retry once; continue the job |
| Model returns fewer than asked | batch records the shortfall; the loop asks for the remainder |
| Unparseable response | repair chain; if it still fails, that batch fails and is retried |
| All candidates duplicates | batches keep flagging; saturation stops the job with an honest reason |
| Grounding provider down | stage skipped, job continues ungrounded (logged) |
| Job cancelled | loop stops; already-produced batches stay visible and committable |

---

## 11. Test plan (invariants that must never regress)

1. **Batch splitting** — target 200 with `batchSize = 25` issues 8 calls (stub counts them).
2. **Accepted-target refill** — a stub that returns 20 clean + 5 duplicates per call keeps
   calling until `accepted >= target`, then stops.
3. **Cross-batch dedupe** — batch 2's repeat of a batch-1 question is flagged against its
   batch mate and does not count toward the target.
4. **Growing context** — the prompt for batch *k+1* contains the concepts accepted in
   batch *k* (assert on the captured prompt).
5. **Nothing hidden** — every produced question is stored and returned, flagged or not.
6. **Override** — accept a flagged duplicate, commit, and it lands in the bank
   (existing test; keep).
7. **Batch regenerate** — regenerating batch 2 supersedes only batch 2's rows; batches
   1 and 3 are untouched.
8. **Resume** — a job killed after batch 3 continues at batch 4 with its accepted set and
   concepts intact.
9. **Stop conditions** — `max_calls` → `partial` with a truthful message; saturation →
   `partial` naming the reason.
10. **Grounding cache** — a second job on the same topic hits the cache (0 searches) and
    records `grounding_cached = 1`.
11. **User sources bypass search** — grounding is skipped when sources are supplied.
12. **Cost accounting** — the job total equals the sum of its batch records.

---

## 12. Delivery phases

| Phase | Scope | Est. |
|---|---|---|
| **P0 — the loop** ✅ **SHIPPED** | `batchSize` + accepted-target + refill + stall/saturation + `max_calls` + one retry per call; migration `0007` (`accepted_count`, `batch_size`, `max_calls`, `covered_concepts`, `ai_generation_batches`, `ai_candidates.batch_no`/`superseded`); cap raised to 300; commit auto-trims to exactly N; target/batch-size controls + per-batch progress; generation settings editable in Admin → Settings | done |
| **P1 — review UX** ✅ **SHIPPED** | candidates grouped by batch with per-batch header (asked/accepted/flagged, cost, duration); **Regenerate this batch** supersedes its rows and refills in place; checkbox selection with "select all / exactly the target / clear" and `candidateIds` commit; job-row telemetry | done |
| **P2 — grounding** ✅ **SHIPPED** | `modules/grounding` (research call via the OpenRouter `web` plugin, tolerant fact-sheet parse, `url_citation` capture), `grounding_cache` + TTL, per-job and global mode (off/single/agentic), engine/results/domains settings, failure recorded not fatal, **generation calls never carry the plugin**; price table corrected (V4 Flash 0731 = $0.05/$0.16) and moved to the client-safe `src/lib/pricing.ts` | done |
| **P3 — telemetry & docs** ✅ **SHIPPED** | per-batch cost/duration in the review headers; grounding cost + cache status on the job row and in progress; live cost estimate on the generate form; docs (`MIGRATIONS.md`, `README.md`, this file) | done |

Each phase leaves the suite green; P0 is the only one that changes observable behaviour
for existing users, and it only makes big jobs possible.

---

## 13. Decisions (resolved)

### D1 — Count: `accepted >= N`, with auto-trim at commit ✅

Generation aims for **at least N accepted**; the final refill asks
`min(batchSize, max(shortfall, MIN_REFILL = 5))`, so a batch is never a degenerate
1–2 question prompt. Overshoot (< batchSize) is kept, shown, and simply **not selected**:
the commit bar pre-selects exactly the first N, so the Q Set receives exactly N.
Extras stay available to swap in if a selected question turns out weak.

*Why not hard-exact:* the tail becomes a sequence of tiny calls that each carry the full
~5k-token context and produce worse questions — paying in quality to save nothing.
Editable: `generation.count_mode = at_least_trim | exact`, `generation.min_refill`.

### D2 — Grounding: OpenRouter web search ✅

One **research call** per job using the `web` plugin, `engine: "exa"`, `max_results: 5`,
producing a shared source pool that every batch reuses as text. $0.007 once per job
(+ result tokens), cached 14 days → **$0** on repeat topics. User-supplied sources skip
the search entirely. Upgrade path: the `openrouter:web_search` server tool with
`max_total_results` for multi-query research (2–3 searches, ~$0.014–0.021) — same
interface, config flag `generation.grounding_mode = single | agentic`.

*Why not ground per batch:* the fee is per request, so per-batch grounding costs ~4×
the whole generation and adds no information the pool does not already carry.
Editable: on/off (global + per job), engine, mode, `max_results`, domain
include/exclude, cache TTL.

### D3 — Batch size: 25, editable 5–50 ✅

- **Context amortisation.** Every call carries ~4–8k tokens of fixed context (source
  pool + bank digest + covered concepts). At 25 questions that is ~240 tokens/question;
  at 10 it is ~600; at 50 it is ~120. 25 is the knee.
- **Quality.** Instruction-following and diversity degrade as one response grows; with
  per-question backstories, 20–30 items is the sweet spot, and beyond ~40 the model
  starts repeating structures and truncation risk climbs (and truncation wastes the
  whole call).
- **Blast radius.** One weak or duplicated batch costs 1/batchSize of the job — 4% at
  25, but 50% at 100. Cheap recovery is the point of batching.
- **Arithmetic.** 25 divides cleanly: 100 = 4 calls, 200 = 8, 300 = 12.
- **Fits the model.** 25 × ~850 tokens ≈ 21k requested output, far inside DeepSeek's
  ~96k ceiling; even 50 (≈43k) fits.

Editable: `generation.batch_size` global default + per-job override, range **5–50**
(soft guidance in the UI: 15–30).

### D4 — Max target: 300 by default, editable up to 1000 ✅

- **Money is not the limit** — 300 questions ≈ $0.023 of generation.
- **Human review is the limit.** 300 cards is roughly 30–60 minutes of real review; a
  1000-question job creates review debt that never gets cleared.
- **Duration.** 12 sequential calls × 10–20s ≈ 2–4 min (fine). 40 calls ≈ 8–13 min, still
  resumable but a worse experience.
- **Context growth.** Late batches carry a longer covered-concepts list, so input cost per
  batch rises across a job — bounded, but real at the top end.
- **Longer than 300?** Prefer *multiple jobs*: the bank is the memory, so job 2 on the
  same topic is cheaper and less repetitive than one enormous job.

Editable: `generation.max_requested` (default 300, hard ceiling configurable to 1000 with
a UI warning); per-job value validated against it; UI presets 25/50/100/200/300 + custom.

### D5 — Regenerate: supersede, never delete ✅

Regenerating a batch marks its candidates `superseded = 1` and its batch record
`status = 'superseded'`, then runs a new batch with a new `batch_no`. Superseded rows are
excluded from counts, commit, and the main review list (available in a collapsed
"Superseded" group).

*Why not delete:* (a) forensics — the batch's parsed questions alongside its
`raw_response_key` are how a bad prompt gets diagnosed; (b) safety — if the regenerate
call then fails, a delete has already destroyed the only copy, while supersede is
reversible; (c) consistency — the codebase is append-only/archive-not-delete everywhere
(`audit_log`, archived questions); (d) rows are tiny and D1 is cheap.

Not user-configurable: it is an internal invariant, not a preference.

### Everything editable, in one place

| Setting | Default | Range / options | Scope |
|---|---|---|---|
| `generation.batch_size` | 25 | 5–50 | global + per job |
| `generation.max_requested` | 300 | 1–1000 | global only |
| `generation.count_mode` | `at_least_trim` | `at_least_trim` / `exact` | global |
| `generation.min_refill` | 5 | 1–25 | global |
| `generation.max_calls` | 20 | 1–100 | global + per job |
| `generation.grounding_mode` | `single` | `single` / `agentic` / `off` | global + per job |
| `generation.grounding_engine` | `exa` | `exa` / `parallel` / `perplexity` | global |
| `generation.grounding_max_results` | 5 | 1–10 | global |
| `generation.grounding_ttl_days` | 14 | 0–90 | global |
| `generation.grounding_domains` | (none) | include/exclude lists | global |
| `dedupe.jaccard_reject` / `_review` | 0.85 / 0.65 | 0–1 | global |
| per-model prices | see §6 | — | global |

---

## 14. Deliberately NOT doing

- **No giant single call.** 200 questions in one prompt degrades diversity and makes one
  failure cost the whole job.
- **No silent dropping.** Duplicates and invalid items are reported and (for duplicates)
  kept visible.
- **No parallel batches (v1).** Cross-batch dedupe is the point; sequential keeps it exact.
- **No per-question grounding.** Search once per job, reuse for every batch, cache across
  jobs.
- **No model-side memory.** The database is the memory; every approved question makes the
  next job less repetitive.
- **No AI authority over the permanent bank.** Only a human commit inserts questions.

---

## 15. File change register

**Modified:** `src/modules/ai/pipeline.ts` (batch loop, accepted-target, saturation),
`src/modules/ai/prompts/generate.ts` (covered-concept block), `src/modules/ai/provider.ts`
(prices), `src/modules/ai/coverage.ts` (concepts for job-local candidates),
`src/components/admin/GenerationPanel.tsx` (batch progress, batch size, grounding toggle),
`src/components/admin/BatchReview.tsx` (grouping, regenerate, selection),
`src/db/schema/ai.ts`, `src/modules/settings/index.ts` (batch size, max calls, budgets).

**Created:** `migrations/0007_generation_batches.sql`, `src/modules/grounding/{index,provider,adapters,cache}.ts`,
`src/components/admin/BatchProgress.tsx`.

**New routes:** `POST /api/admin/generation-jobs/[id]/batches/[batchNo]/regenerate`,
`GET /api/admin/generation-jobs/[id]/batches`.

**New tests:** `tests/integration/ai-batching.test.ts`,
`tests/integration/grounding.test.ts`, plus additions to `ai-pipeline.test.ts`.

**Docs:** `PLAN.md` §12, `MIGRATIONS.md`, `README.md`, this file.

---

## 16. Brand assets & app icons (shipped alongside P0)

The `web/` folder holds the source-of-truth brand assets; `public/` serves them and
`app/layout.tsx` declares them through Next metadata, so no hand-written `<head>` is
needed.

| Asset (`web/` → `public/`) | Purpose | Wiring |
|---|---|---|
| `favicon.ico` | browser tab | `metadata.icons.icon` (`sizes: "any"`) |
| `icon-192.png`, `icon-512.png` | Android/desktop, PWA install | `metadata.icons.icon` |
| `icon-192-maskable.png`, `icon-512-maskable.png` | Android adaptive icons (`purpose: "maskable"`) | `manifest.webmanifest` |
| `apple-touch-icon.png` | iOS home-screen | `metadata.icons.apple` |
| — | PWA manifest | `public/manifest.webmanifest` + `metadata.manifest` |

- Verified live: `/favicon.ico`, `/icon-192.png`, `/icon-512.png`,
  `/apple-touch-icon.png` and `/manifest.webmanifest` all return 200 with the right
  content types, and the rendered document contains the five `<link>` tags.
- `manifest.webmanifest` carries `name`, `short_name`, `start_url`, `display:
  standalone`, `theme_color: #0f172a` (slate-900) and `background_color: #f8fafc`
  (slate-50), matching the app shell.
- **Rule:** `web/` is the only place assets are edited; copy to `public/` after a change
  (the folder's `README.txt` documents the exact tag/manifest snippets).
