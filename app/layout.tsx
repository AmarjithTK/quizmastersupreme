import type { Metadata } from "next";
import Link from "next/link";
import { LogOut, Search as SearchIcon, ShieldCheck } from "lucide-react";
import { getCurrentPageUser } from "@/lib/server/get-current-user";
import { cn } from "@/lib/utils";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Quiz Master Supreme",
    template: "%s · Quiz Master Supreme",
  },
  description:
    "Practice quizzes with rich explanations, timed mock papers and progress that survives closing the browser.",
  // Brand assets live in `web/` (source of truth) and are served from `public/`.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/manifest.webmanifest",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentPageUser();

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-slate-900 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
            <Link
              href="/"
              className="rounded font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
            >
              Quiz Master <span className="text-slate-400">Supreme</span>
            </Link>

            <form
              action="/search"
              method="get"
              className="relative hidden max-w-xs flex-1 sm:block"
            >
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <input
                name="q"
                type="search"
                placeholder="Search quizzes…"
                aria-label="Search quizzes"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-sm focus:border-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/10"
              />
            </form>

            <nav className="flex items-center gap-2">
              {user ? (
                <>
                  {user.role === "admin" && (
                    <Link
                      href="/admin"
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600",
                        "hover:bg-slate-100 hover:text-slate-900",
                      )}
                    >
                      <ShieldCheck className="size-4" />
                      Admin
                    </Link>
                  )}
                  <Link
                    href="/account"
                    className={cn(
                      "inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-700",
                      "hover:bg-slate-100",
                    )}
                  >
                    {user.avatarUrl ? (
                      <img
                        src={user.avatarUrl}
                        alt=""
                        className="size-6 rounded-full"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="flex size-6 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
                        {user.displayName?.charAt(0)?.toUpperCase() ?? "?"}
                      </span>
                    )}
                    <span className="hidden sm:inline">{user.displayName ?? "Account"}</span>
                  </Link>
                  <form action="/api/auth/logout" method="post">
                    <button
                      type="submit"
                      aria-label="Sign out"
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                    >
                      <LogOut className="size-4" />
                      <span className="hidden md:inline">Sign out</span>
                    </button>
                  </form>
                </>
              ) : (
                <Link
                  href="/login"
                  className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-slate-700"
                >
                  Sign in
                </Link>
              )}
            </nav>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>

        <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-xs text-slate-400">
          Quiz Master Supreme
        </footer>
      </body>
    </html>
  );
}