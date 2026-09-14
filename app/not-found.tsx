import Link from "next/link";

/**
 * 404 page (M14) — a real not-found screen instead of the framework default.
 */

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-2xl">
          🧭
        </div>
        <h1 className="mt-4 text-xl font-semibold text-slate-800">Page not found</h1>
        <p className="mt-2 text-sm text-slate-500">
          That page does not exist, or it has been moved. Quiz Master Supreme still has
          plenty of sets worth a look.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          Back home
        </Link>
      </div>
    </div>
  );
}