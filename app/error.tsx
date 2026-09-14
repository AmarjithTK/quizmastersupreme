"use client";

/**
 * Root error boundary (M14) — catches render errors anywhere in the app.
 *
 * On the Worker, a crash during SSR would otherwise surface as a blank or
 * half-rendered page. This is the last line: a message, no stack trace shown
 * to the visitor (it is in the server logs), and a way back.
 */

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-2xl">
          ⚠️
        </div>
        <h1 className="mt-4 text-xl font-semibold text-slate-800">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-500">
          This page hit an unexpected problem. Your data is safe — try again, and if it
          keeps happening the error has been logged.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-6 rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          Try again
        </button>
      </div>
    </div>
  );
}