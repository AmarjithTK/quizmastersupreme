# Migration Register

Single source of truth for every schema change applied to the D1 database.
If a migration is not listed here, treat it as not real. **Migrations are
append-only: never edit an applied migration — add a new one.**

Current tip: **`0009_generation_planner`**

## How migrations work here

- Files live in `migrations/` and are tracked by `migrations/meta/_journal.json`
  (this is what `wrangler d1 migrations apply` and the test setup read).
- Drizzle-generated files come from `pnpm db:generate` (schema → next `000x`).
  Two are **hand-written** because drizzle-kit cannot model them (FTS5) or the
  change needs PRAGMA tricks: `0001` and `0002`. Hand-written files MUST be
  registered in `_journal.json` manually or the tooling will never run them.
- Apply locally: `pnpm db:migrate:local`
- Apply to production D1: `pnpm db:migrate:remote`
- Reset local: `pnpm db:reset:local` (wipes `.wrangler/state/v3/d1` first —
  re-run `pnpm seed` after).

## Register

| # | File | Kind | What it does | When |
|---|------|------|--------------|------|
| 0000 | `0000_classy_moira_mactaggert.sql` | Drizzle-generated | **Whole schema.** 17 `CREATE TABLE`, 25 indexes, 7 unique constraints: auth_sessions, users, oauth_states got rebuilt later (0002), categories, quiz_sets, question_set_questions, questions, question_options, quiz_attempts, quiz_attempt_answers, user_question_seen, user_set_stats, app_settings, audit_log, ai_generation_jobs, ai_candidates, question_embeddings, duplicate_flags (+ FTS5 table added by 0001). | M0 |
| 0001 | `0001_fts5.sql` | **Hand-written** | FTS5 virtual table `questions_fts` (porter + unicode61 tokenizer) with 3 triggers (insert / delete / update) that keep it in sync with `questions`. Powers admin question search (§9.4) and dedupe layer 2 (§13.4). | M0 |
| 0002 | `0002_tan_satana.sql` | **Hand-written** | Google OIDC: new `oauth_states` table (PKCE + state params), Rebuilds `users` with Google columns (`google_sub`, `google_email`, `google_name`, `google_avatar_url`, …), drops the old users table under `PRAGMA foreign_keys=OFF`, adds `sessions.last_seen_at` / `ip_hash`/`user_agent` and indexes. | M1 |
| 0003 | `0003_provider_routing.sql` | Hand-written (tiny) | Adds `provider_only` and `provider_order` (TEXT, JSON arrays of OpenRouter provider slugs) to `ai_generation_jobs` — the `provider.only` / `provider.order` cost-control routing. | M14+ |
| 0004 | `0004_ai_job_inputs.sql` | Hand-written (tiny) | Adds `target`, `sources` (generation input context) and `committed_set_id`, `committed_at` (batch-commit marker) to `ai_generation_jobs`. | M14+ |
| 0005 | `0005_revamp_pipeline.sql` | **Hand-written** | The simplification revamp (REVAMP-PLAN.md). (1) Rebuilds `questions` under `PRAGMA foreign_keys=OFF`: `status` collapses 8 values → `active`/`rejected`/`archived` (`ai_draft,draft,review,approved,published` → `active`; `duplicate` → `rejected`) and `simhash` is dropped; indexes + FTS triggers recreated and `questions_fts` rebuilt. (2) Rebuilds `ai_candidates` as a plain working set (drops validation/dedupe/review state machines + promote pointer; adds `rejected` 0/1). (3) Drops `duplicate_flags` and `question_embeddings`. (4) Adds `backfill_round` + `duplicate_skipped` to `ai_generation_jobs`. | Revamp |
| 0006 | `0006_candidate_dedupe.sql` | Hand-written (tiny) | Duplicate POLICY: `ai_candidates` gains `dedupe_status`, `dedupe_matched_question_id`, `dedupe_matched_stem`, `dedupe_similarity`, `dedupe_reason`. Flagged duplicates are now STORED and arrive `rejected = 1` (rejected by default) with the matching existing question, instead of being dropped. Values are app-validated (SQLite cannot add a CHECK without a rebuild). | Generation flow |
| 0007 | `0007_generation_batches.sql` | Hand-written | Small-batch generation pipeline: new `ai_generation_batches` table (one row per internal model call, with its own counts/tokens/cost/status), job counters for the accepted-target loop (`accepted_count`, `batch_size`, `max_calls`) plus `covered_concepts` and the (P2) grounding columns, and `ai_candidates.batch_no` / `superseded`. | Generation pipeline |
| 0008 | `0008_grounding.sql` | Hand-written (tiny) | Grounding: new `grounding_cache` table (a paid search result is cached by normalised topic + engine, so a repeat topic costs $0) and per-job `grounding_mode` / `grounding_at` / `grounding_error`. | Grounding (P2) |
| 0009 | `0009_generation_planner.sql` | Hand-written, additive | Plan-first job fields, phase/revision/hash/approval, provider and funnel forensics, lease recovery; creates `ai_generation_segments`, `ai_source_facts`, and `ai_generation_rejections`; adds unique job/batch and job/revision/segment keys. Existing jobs and candidates remain readable. | Generation planner |

## Adding a new migration (the rules)

1. **Prefer `pnpm db:generate`** — edit `src/db/schema/**`, run it, and it emits
   the next `NNNN_<name>.sql` + registers itself in `_journal.json`.
2. **Hand-write only** when drizzle cannot express it (FTS, `PRAGMA`, complex
   data migration). If you hand-write:
   - Save as `migrations/NNNN_<name>.sql` (next free number).
   - Manually append `{"idx": N, "version": "7", "tag": "NNNN_<name>", "breakpoints": true}` to
     `migrations/meta/_journal.json`.
   - Separate statements with `--> statement-breakpoint`.
3. **Never** edit an already-applied migration. The journal numbers are monotonically increasing;
   a gap or renumber breaks every environment that already applied them.
4. Test the migration end-to-end locally (`pnpm db:migrate:local`), and keep the
   change honest: if it moves data, it belongs in the migration, not in app code.
5. Update this register: bump "Current tip", add a row, note any deploy order
   (apply remote BEFORE deploying code that writes the new columns).

## Gotchas seen in the field

- **Deploy-order bug (real):** code writing `provider_only`/`provider_order`
  (M14 routing) shipped before the local migration was applied — every job
  create 500'd with `Failed query: insert into "ai_generation_jobs"`. Apply
  migrations to an environment BEFORE deploying code that references new
  columns. Fix in the field was `pnpm db:migrate:local` and restart.
- `--persist-to X` vs `getPlatformProxy({ persist })` resolve to different
  paths (`X/v3/...` vs `X/...`) — the test setup applies the migration files
  directly so the contract is the SQL, not the CLI.
- Migration files are also the thing `tests/global-setup.ts` replays on every
  test run — a broken migration breaks the whole suite, loudly, which is the
  point.

## Verify what's applied

```bash
wrangler d1 migrations list quizmaster-supreme-db --local
wrangler d1 migrations list quizmaster-supreme-db --remote
```
