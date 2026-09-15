# Plan-first generation: operator notes

New jobs created through the admin API begin in `queued/planning`. Build a plan,
review and optionally edit its quotas and entity policy, then approve it. Approval
freezes the revision and enables generation. In local development the browser
advances one leased batch per `/step` request. In production/staging with the
shared orchestration token and service binding, the separate Workflow Worker
builds the plan, waits durably for approval, then advances generation batches
independently of the browser. A failed dispatch visibly falls back to manual
leased steps. Each generation step makes at most one generation call (plus a
first-batch grounding call if enabled); `grounding_at` prevents buying the same
failed source search again on an interrupted first step. Closing the tab
preserves finished batches and the review working set. An expired lease marks
its in-flight batch `INTERRUPTED` and uses a new batch number. The Workflow
class packages locally, but its live deployment has not been validated.

## Storage and reconciliation

- `ai_generation_jobs`: immutable input, approved blueprint JSON/hash/revision,
  job-wide counters, cost, phase/status and one step lease.
- `ai_generation_segments`: canonical segment quotas and accepted/rejected/
  invalid/source-fact ledgers for a plan revision.
- `ai_source_facts`: facts attached to an explicitly named segment and to a
  URL returned by a trusted web-search citation or a fetched admin-provided
  public source. Unassigned facts are retained but do not make a segment
  source-ready. A current/source-required segment without assigned evidence
  becomes `SOURCE_LIMITED` rather than receiving an uncited question.
- `ai_generation_batches`: immutable batch number, exact directive JSON/hash,
  response format, requested/raw/schema/content/policy/duplicate/accepted
  funnel, tokens, cost, finish reason and archive keys.
- `ai_candidates`: content-valid cards, including policy failures and flagged
  duplicates. Policy failures remain rejected and have a reason; reviewer
  decisions are recorded in D1 and audit history.
- `ai_generation_rejections`: raw schema/content/policy failures and their
  model index. `raw = schema_valid + schema_invalid`,
  `schema_valid = content_valid + content_invalid`, and
  `content_valid = policy_valid + policy_rejected` must hold for every
  successful batch. `asked - raw` is an explicit model shortfall, not a
  malformed-item count.
- R2 `ai-jobs/<id>/`: planner raw output, per-batch request/directive manifest,
  provider envelope and raw response. Keys and hashes live in D1. Archive
  failures are logged but currently do not block acceptance; production should
  alert on missing manifests because they reduce forensic completeness.

The stop code distinguishes `MAX_CALLS`, `SATURATED` bank coverage,
`NO_CANDIDATES`, `DELIVERY_STALL`, `FORMAT_STALL`, `POLICY_FAILURE`,
`SOURCE_LIMITED`, `PLAN_EXHAUSTED`, unparseable output and provider failures.
`partial` means at least one candidate was produced or accepted but the target
was not reached. Only terminal jobs may be committed. Source facts and raw
response archives are retained indefinitely by this code; configure an R2
lifecycle/retention policy only after deciding the required incident window,
and do not discard D1 rejection records before their associated archives.

## Local verification and deployment order

Run `pnpm db:migrate:local`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
Migration `0009_generation_planner` is additive and must be applied to each
remote D1 **before** deploying code that writes its columns. The local tests
stub all AI calls and exercise a real D1; they do not validate a paid model,
Google login, resource IDs, or live Workflow scheduling. All app and Workflow
configs still contain placeholder D1 IDs, so do not deploy them unchanged.
Production deployment uses `wrangler.production.jsonc` with
`APP_ENV=production`; development uses `wrangler.jsonc`. Provision production
and staging R2 buckets separately, apply migration 0009 to each matching D1,
put `OPENROUTER_API_KEY` and the same `GENERATION_ORCHESTRATION_TOKEN` secret
on both app and Workflow Workers, and deploy the Workflow Worker first. Fill
the real app URL, Google client ID and session secrets. The traces sampling
rate is 1%; logs are enabled.

Never include API keys, full prompts, question bodies or fetched source bodies
in console events. R2 objects are access-controlled forensic artifacts and
should be reviewed for retention/privacy requirements before production.
