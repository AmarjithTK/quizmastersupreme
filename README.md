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

**Milestones M0 complete and verified.** See `PLAN.md` §20 for the full roadmap.

Built so far:

- ✅ Full 17-table schema with migrations, including FTS5 and all CHECK/partial-unique constraints
- ✅ Local D1 workflow: generate → migrate → seed → query
- ✅ Domain module layout (`src/modules/**`) with zero React inside it
- ✅ Screen 1 (home, category card grid) and Screen 2 (category → set grid) rendering from D1
- ✅ Normalization + SimHash (dedupe layers 1–2 foundations)
- ✅ 37 tests guarding the frozen constraints

Not built yet: auth (M1), admin CRUD (M2–M4), quiz runner (M5), resume (M6).

## Getting started

```bash
pnpm install

# Create the local database and load starter content
pnpm db:migrate:local
pnpm seed

pnpm dev          # http://localhost:3000
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
