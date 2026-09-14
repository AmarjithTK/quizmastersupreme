# Quiz Master Supreme

A two-surface quiz platform: a user-facing card grid for browsing and taking quizzes
with rich post-answer explanations, and an admin console for authoring content and
reviewing AI-generated questions.

**Read [`PLAN.md`](./PLAN.md) first.** It is the contract for this codebase — the frozen
design constraints in §2 explain *why* the code is shaped the way it is.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js App Router via **vinext** (Vite-based, Workers target) |
| UI | Tailwind CSS v4 + `lucide-react` |
| Database | **Cloudflare D1** (SQLite) — identical engine locally and in production |
| ORM | Drizzle ORM + Drizzle Kit |
| Search | D1 **FTS5** (virtual table + triggers) |
| Tests | Vitest (unit) + real local D1 (integration) |

## Current status

**v0.1 complete and verified locally** — milestones M0–M6. See `PLAN.md` §0.1 for the
as-built status and §20 for the roadmap.

Built so far:

- ✅ Full schema with migrations (18 tables), including FTS5 and every CHECK / partial-unique constraint
- ✅ Local D1 workflow: generate → migrate → seed → query
- ✅ Domain module layout (`src/modules/**`) with zero React inside it
- ✅ Google-only auth (OIDC + PKCE, not Firebase), D1 sessions, admin role gate
- ✅ Admin: subjects, quiz sets, questions, set membership — all CRUD with validation and an audit trail
- ✅ The question funnel: validate → normalize → dedupe layer 1 → insert (every write path uses it)
- ✅ Screen 1 (subject grid + Continue banner) and Screen 2 (set grid with per-set progress)
- ✅ Screen 3: the quiz runner with timer, question map, inline reveal and rich backstories
- ✅ Resume that survives closing the browser; results, history and an account dashboard
- ✅ 129 tests, including every §18.2 constraint test

Not built yet: dedupe layers 2–3 (M11–M12), AI generation (M10), CSV import (M9).

**Never run on a deployed Worker.** Everything above is verified against local D1 with
`vinext dev`. The deploy half of the M0/M1 exit tests, and the live Google round-trip,
still need real credentials — see "Deploying" below.

## Getting started

```bash
pnpm install

# Create the local database and load starter content
pnpm db:migrate:local
pnpm seed

pnpm dev          # http://localhost:3000
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
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Unit + integration tests (builds a clean test DB automatically) |
| `pnpm dev:admin-token` | **Local only.** Mint an admin session for testing without Google |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate:local` | Apply migrations to local D1 |
| `pnpm db:migrate:remote` | Apply migrations to production D1 |
| `pnpm db:reset:local` | Wipe and rebuild the local database |
| `pnpm seed` | Load `seed/*.json` (idempotent) |
| `pnpm reindex:fts` | Rebuild the FTS5 index from `questions` |

## Things that will bite you

These are non-obvious and each one has already cost time once:

1. **Migrations are append-only.** Never edit an applied migration. Add a new one.
2. **`migrations/0001_fts5.sql` is hand-written.** Drizzle cannot model FTS5 virtual
   tables or triggers. It is registered in `migrations/meta/_journal.json` as `idx 1`
   so the next `drizzle-kit generate` emits `0002` instead of colliding.
3. **Bulk inserts must be chunked.** D1 rejects statements with too many bound
   parameters. See the `insertChunked` helper in `scripts/seed.ts`.
4. **`wrangler types` must be re-run** after changing `wrangler.jsonc`. Bindings are
   typed from the generated `worker-configuration.d.ts`.
5. **Only `src/lib/cloudflare/bindings.ts` may import `cloudflare:workers`**
   (PLAN.md §2.7). This is what keeps a vinext → OpenNext migration to one file.
6. **`--persist-to X` ≠ `getPlatformProxy({ persist: { path: X } })`.** The CLI
   resolves to `X/v3/...` and the proxy to `X/...`. That is why tests apply the
   migration files directly in `tests/global-setup.ts` rather than shelling out.
7. **The content tree is exactly two levels deep** — Category → Quiz Set. There is no
   `parent_id` anywhere, by design, and a test enforces it.

## Adding a category icon

Icons are stored as *names* and resolved through an allowlist in
`src/components/ui/category-icon.tsx`. Add the import and the map entry, or the icon
silently falls back to a book.

Accent colours work the same way — `src/components/cards/accents.ts` spells out every
Tailwind class in full, because Tailwind's JIT cannot see dynamically constructed
class names like `bg-${color}-50`.

## Deploying

Not yet configured — `wrangler.jsonc` carries a placeholder D1 `database_id`.

```bash
wrangler d1 create quizmaster-supreme-db   # then paste the UUID into wrangler.jsonc
pnpm db:migrate:remote
pnpm deploy
```

R2, Queues and Vectorize bindings are commented out in `wrangler.jsonc` and get
enabled at M10/M12 — wiring them before their resources exist breaks local dev.
