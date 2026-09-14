# Quiz Master Supreme

A two-surface quiz platform: a user-facing card grid for browsing and taking quizzes
with rich post-answer explanations, and an admin console for authoring content and
generating fresh questions with AI.

**The revamp (2026-09) simplified the content pipeline.** [`REVAMP-PLAN.md`](./REVAMP-PLAN.md)
is the record: question statuses collapsed 8 → 3 (`active`/`rejected`/`archived`),
playability is derived from set membership (no per-question publish step), generation
asks for N and gets N (duplicates auto-filtered, shortfall backfilled), and the review
queue, duplicate triage and vector-index machinery were removed. Where `PLAN.md`'s
"frozen constraints" disagree with the code, the revamp wins.

**Read [`PLAN.md`](./PLAN.md) for the original design.** Every schema change is tracked in
[`MIGRATIONS.md`](./MIGRATIONS.md).

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js App Router via **vinext** (Vite-based, Workers target) |
| UI | Tailwind CSS v4 + `lucide-react` |
| Database | **Cloudflare D1** (SQLite) — identical engine locally and in production |
| ORM | Drizzle ORM + Drizzle Kit |
| Search | D1 **FTS5** (virtual table + triggers) |
| Dedupe | Exact hash (L1) → FTS5 + Jaccard (L2), auto-filtering at write time |
| AI generation | OpenRouter behind a transport-agnostic pipeline; count-sized output budget + backfill rounds |
| Tests | Vitest (unit) + real local D1 (integration) — **259 tests** |

## Current status

**M0–M14 implemented, then simplified by the revamp — all verified locally.**
See `PLAN.md` §0.1 for the as-built status and §20 for the roadmap. Highlights:

- ✅ Full schema with migrations (16 tables), FTS5, CHECK / partial-unique constraints
- ✅ Google-only auth (OIDC + PKCE), D1 sessions, admin role gate
- ✅ Admin: categories, quiz sets, questions, set membership — CRUD with validation + audit trail
- ✅ The question funnel: validate → normalize → dedupe (layers 1–2) → insert on every write path
- ✅ Quiz runner (timed mock exams, resume, server-owned clock), results, history, dashboard, search
- ✅ CSV import/export with dry run, bulk status changes
- ✅ AI generation: ask for N, get N — count-sized output budget, backfill rounds, duplicates
  auto-filtered against the whole bank, coverage-aware prompts, one-click add-to-set
- ✅ M14 hardening: rate limits, error boundaries, backup/restore (rehearsed by test), staging config,
  keyboard accessibility (skip link, focus management, live regions)

**Never run on a deployed Worker.** Everything is verified against local D1 with `vinext dev`.
The live OpenRouter, Google login and deploy round-trips still need real
credentials/resources — see "Deploying".

## Getting started

```bash
pnpm install

# Create the local database and load starter content
pnpm db:migrate:local
pnpm seed

pnpm dev          # http://localhost:3000 (vinext dev)
```

To exercise the admin screens without Google credentials, mint a local session:

```bash
pnpm dev:admin-token
# prints a Cookie: header you can paste into curl, or set in a browser
```

### All scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | vinext dev server (port 3000) |
| `pnpm build` | Production Worker build |
| `pnpm start` | Run the built Worker locally via Wrangler |
| `pnpm deploy` | Deploy to Cloudflare Workers |
| `pnpm deploy:staging` | Deploy to the isolated staging Worker (`wrangler.staging.jsonc`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Unit + integration tests (builds a clean test DB automatically) |
| `pnpm dev:admin-token` | **Local only.** Mint an admin session for testing without Google |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate:local` | Apply migrations to local D1 |
| `pnpm db:migrate:remote` | Apply migrations to production D1 |
| `pnpm db:reset:local` | Wipe and rebuild the local database |
| `pnpm seed` | Load `seed/*.json` (idempotent) |
| `pnpm reindex:fts` | Rebuild the FTS5 index from `questions` |
| `pnpm backup` | Dump the dev D1 to `.tooling/backups/backup-<ts>.json` |
| `pnpm restore --file <.json>` | **Destructive.** Wipe the dev D1 and restore that backup |

## Operations runbook (M14)

### Backup & restore

The product's value is the question bank, so restore is *rehearsed*, not assumed:
`tests/integration/backup-restore.test.ts` exports the database, wipes it, imports it back,
and proves FTS search still works afterwards. The script path and the test share
`src/modules/backup` — the same code.

```bash
pnpm backup                                  # every table → .tooling/backups/backup-<ts>.json
pnpm restore --file .tooling/backups/backup-2026-09-14T19-12-11-341Z.json
```

Restore wipes every table first (children-first, FKs off for the wipe). The FTS5 table is
**not** backed up — its insert/delete triggers rebuild it from `questions`.

**Production:** back up remotely with `wrangler d1 export quizmaster-supreme-db --remote --no-schema > backup.sql`
(or upload a `pnpm backup` JSON to R2) on a schedule, and restore with
`wrangler d1 execute quizmaster-supreme-db --remote --file backup.sql`. The restore path is
tested locally; rehearse it remotely before you need it.

### Staging

`wrangler.staging.jsonc` points at a **separate** Worker (`*-staging`) and D1 database, with
`APP_ENV=staging`:

```bash
wrangler d1 create quizmaster-supreme-db-staging   # paste UUID into wrangler.staging.jsonc
pnpm db:migrate:remote --config wrangler.staging.jsonc  # apply to staging D1
pnpm deploy:staging
```

Same code, isolated data. Production `wrangler.jsonc` is untouched.

### Rate limits

In-memory fixed-window limits per IP: `auth` 30/15 min, `attempts` 30/min, `answer` 60/min,
`admin` 30/min, `search` 60/min (`src/modules/rate-limit`). They guard against surprise
bursts; they are **not** a defence against distributed attacks — a real deployment should add
a managed edge rate limiter in front.

### Failure handling

- `app/error.tsx` / `app/global-error.tsx` — render errors show a message + retry, never a stack trace.
- `app/not-found.tsx` — friendly 404.
- Every API route returns the single `{ error: { code, message } }` envelope (`src/lib/errors.ts`),
  with `RATE_LIMITED` (429) from the limiter.

### Accessibility

- Skip-to-content link in the root layout.
- Quiz runner: `aria-live` announcement of the verdict, and focus moves to **Next question**
  after a reveal so a keyboard-only user never tabs through the backstory.
- All interactive elements are native buttons/links with visible focus rings.
- Screen-reader labels on icon-only controls (e.g. sign-out).

## Things that will bite you

Non-obvious, and each one has already cost time once:

1. **Migrations are append-only.** Never edit an applied migration. Add a new one.
   See [`MIGRATIONS.md`](./MIGRATIONS.md) for the full register — every migration,
   what it did, and how to add the next one.
2. **`migrations/0001_fts5.sql` is hand-written.** Drizzle cannot model FTS5 virtual
   tables or triggers. It is registered in `migrations/meta/_journal.json` as `idx 1`
   so the next `drizzle-kit generate` emits `0002` instead of colliding.
3. **Bulk inserts must be chunked.** D1 rejects statements with too many bound
   parameters. See `insertChunked` in `scripts/seed.ts` and `CHUNK_ROWS` in
   `src/modules/backup`.
4. **`wrangler types` must be re-run** after changing `wrangler.jsonc` (and its
   `wrangler.staging.jsonc` twin). Bindings are typed from the generated file.
5. **Only `src/lib/cloudflare/bindings.ts` may import `cloudflare:workers`** (PLAN.md §2.7).
   This is what keeps a vinext → OpenNext migration to one file. It is also why
   `scripts/*.ts` never import `@/db/client` — Node cannot load that scheme.
6. **`--persist-to X` ≠ `getPlatformProxy({ persist: { path: X } })`.** The CLI resolves
   to `X/v3/...` and the proxy to `X/...`. Tests apply migration files directly in
   `tests/global-setup.ts` rather than shelling out.
7. **The content tree is exactly two levels deep** — Category → Quiz Set. There is no
   `parent_id` anywhere, by design, and a test enforces it (PLAN.md §2.1).
8. **vinext dev is a singleton per workspace.** If a stale dev server holds the lock
   (`node_modules/.vinext`-adjacent `.vinext/dev/lock.json`), delete the lock file
   before starting a new one.
9. **The rate limiter resets on every Worker restart** — per-instance memory by design.
10. **Never call `toLocaleString()` on a date inside a client component.** The server
    (Workers = UTC) and the browser (local time) render different strings, so React
    fails hydration. Use `<LocalTime value={ts} />` from `src/components/ui/LocalTime.tsx`
    — it renders a UTC-pinned value until mounted, then switches to the viewer's
    timezone. Server components (`app/account/*`, `app/admin/audit`) are unaffected
    because their HTML is not hydrated, but they show UTC.

## Adding a category icon

Icons are stored as *names* and resolved through an allowlist in
`src/components/ui/category-icon.tsx`. Add the import and the map entry, or the icon
silently falls back to a book.

Accent colours work the same way — `src/components/cards/accents.ts` spells out every
Tailwind class in full, because Tailwind's JIT cannot see dynamically constructed
class names like `bg-${color}-50`.

## Deploying

Not yet deployed — `wrangler.jsonc` carries a placeholder D1 `database_id`, and the
`vectorize`/`ai` bindings stay commented until those resources exist (uncommenting them
before creation breaks local dev).

```bash
wrangler d1 create quizmaster-supreme-db      # paste the UUID into wrangler.jsonc
pnpm db:migrate:remote
# .dev.vars → real secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET,
# OPENROUTER_API_KEY (CLI secrets for production: `wrangler secret put ...`)
pnpm deploy
```

Required before a production launch (each item is called out in PLAN.md §0.1 as unverified):

1. **Google OAuth** — real client id/secret, authorised JS origins + redirect URIs
   (`/api/auth/google/callback`), `googleEnabled()` gate off by default.
2. **OpenRouter key** — without it, generation jobs cannot run past `queued`.
3. **R2 bucket** — `quizmaster-supreme-assets` (raw model responses).
5. **Staging round** — deploy staging, run the E2E flow there, then production.