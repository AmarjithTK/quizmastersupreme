import Link from "next/link";
import { Search as SearchIcon } from "lucide-react";
import { searchSets } from "@/modules/search";
import { formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: PageProps) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  return { title: q ? `Search: ${q}` : "Search" };
}

/**
 * Search (M8).
 *
 * Finds a SET by the text of a QUESTION inside it — "who created linux" should
 * surface the papers that ask about it, not just sets with "Linux" in the
 * title. Question-level hits are shown so the reason for the match is visible.
 */
export default async function SearchPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";

  const results = q.length >= 2 ? await searchSets(q, 20) : [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <form action="/search" method="get" className="flex max-w-xl gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              name="q"
              defaultValue={q}
              autoFocus
              placeholder="Search questions, sets or subjects…"
              className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            />
          </div>
          <button
            type="submit"
            className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Search
          </button>
        </form>
      </header>

      {q.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Type at least two characters. You can search for a phrase from a question,
          a set name, or a subject.
        </p>
      ) : results.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Nothing published matches “{q}”.
        </p>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {results.length} {results.length === 1 ? "set" : "sets"} matching “{q}”
          </h2>

          <ul className="flex flex-col gap-2">
            {results.map((hit) => (
              <li key={hit.setId} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/category/${hit.categorySlug}`}
                      className="text-[11px] font-medium uppercase tracking-wide text-slate-400 hover:text-slate-700"
                    >
                      {hit.categoryTitle}
                    </Link>
                    <p className="text-sm font-semibold text-slate-900">{hit.setTitle}</p>
                    <p className="text-xs text-slate-500">
                      {formatNumber(hit.questionCount)}{" "}
                      {hit.questionCount === 1 ? "question" : "questions"}
                      {hit.matchedCount > 0 && (
                        <>
                          {" · "}
                          <span className="text-slate-700">
                            {hit.matchedCount} matching{" "}
                            {hit.matchedCount === 1 ? "question" : "questions"}
                          </span>
                        </>
                      )}
                      {hit.titleMatched && hit.matchedCount === 0 && " · matched by title"}
                    </p>
                  </div>

                  <Link
                    href={`/quiz/${hit.setId}`}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
                  >
                    Start
                  </Link>
                </div>

                {hit.matchedStems.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1 border-t border-slate-100 pt-3">
                    {hit.matchedStems.map((stem) => (
                      <li key={stem} className="line-clamp-1 text-xs text-slate-500">
                        • {stem}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
