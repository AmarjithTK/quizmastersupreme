import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Google uses its own multicolour mark; lucide removed brand icons. */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export const metadata = { title: "Sign in" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Simply landing on /login signs you in — there is no password to enter. */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 py-16">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-slate-500">
          Sign in with Google to track your progress. Your answers and scores
          are saved to your account.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <a
        href="/api/auth/google/start?redirect=/"
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3",
          "text-sm font-semibold text-slate-800 shadow-sm transition-colors",
          "hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2",
          "focus-visible:ring-slate-900 focus-visible:ring-offset-2",
        )}
      >
        <GoogleMark className="size-5" />
        Continue with Google
      </a>

      <p className="text-center text-xs text-slate-400">
        You will be redirected to Google to authorize access. We only ever see
        your name, email and profile picture.
      </p>
    </div>
  );
}