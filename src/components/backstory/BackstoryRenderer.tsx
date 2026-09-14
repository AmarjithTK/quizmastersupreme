/**
 * BackstoryRenderer — the ONE component that turns stored backstory text into
 * display, used in three places (PLAN.md §11.7):
 *
 *   1. the quiz runner (after answering)
 *   2. the admin question editor's live preview
 *   3. the attempt review screen
 *
 * If it looks right in the editor it looks right in the runner, because it is
 * literally the same code path.
 *
 * SAFETY: react-markdown builds a React element tree rather than an HTML
 * string, and raw HTML is NOT enabled. There is no `dangerouslySetInnerHTML`
 * anywhere in this path, so a backstory cannot inject script — §22 R-14.
 *
 * No `"use client"` on purpose: this renders on the server inside the runner
 * and is pulled into the client bundle only where a client component imports it.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Element mapping. Explicit Tailwind classes rather than a typography plugin,
 * so the reading styles are visible in the source and easy to tune.
 *
 * Measure is capped at ~70ch for readability — long-form backstories are the
 * point of this product and should be pleasant to read on a laptop.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h3 className="mt-5 mb-2 text-base font-semibold text-slate-900">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-5 mb-2 text-base font-semibold text-slate-900">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-5 mb-2 text-[15px] font-semibold text-slate-900">{children}</h4>
  ),
  h4: ({ children }) => (
    <h5 className="mt-4 mb-1.5 text-sm font-semibold text-slate-900">{children}</h5>
  ),
  p: ({ children }) => <p className="my-3">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-7">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-4 border-slate-300 pl-4 italic text-slate-600">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-slate-200 bg-slate-50 px-3 py-1.5 text-left font-semibold text-slate-900">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-slate-200 px-3 py-1.5">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[13px] leading-6 text-slate-100">
      {children}
    </pre>
  ),
  code: ({ children, className }) => {
    // Inside <pre> react-markdown passes a language-* className; those get the
    // dark block styling from the pre above and must not also get a light chip.
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) return <code className="font-mono">{children}</code>;
    return (
      <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[13px] text-slate-800">
        {children}
      </code>
    );
  },
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-700 underline underline-offset-2 hover:text-sky-900"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
  hr: () => <hr className="my-6 border-slate-200" />,
};

export function BackstoryRenderer({
  content,
  format = "markdown",
  className,
}: {
  content: string | null | undefined;
  format?: string;
  className?: string;
}) {
  const text = content?.trim() ?? "";

  if (!text) {
    return (
      <p className="text-sm italic text-slate-400">No backstory has been written for this yet.</p>
    );
  }

  if (format === "plain") {
    return (
      <p className={cn("whitespace-pre-wrap text-[15px] leading-7 text-slate-700", className)}>
        {text}
      </p>
    );
  }

  return (
    <div className={cn("max-w-[70ch] text-[15px] leading-7 text-slate-700", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
