/**
 * Tiny structured logger (M14 debugging aid).
 *
 * Every line is prefixed `[qms]` so worker output is greppable in the dev
 * terminal. Timestamps are ISO. `meta` is collapsed JSON — always pass secrets
 * through `maskSecret` first; this module never redacts for you.
 *
 * Where do these lines go? In `pnpm dev` (vinext) worker console output is
 * streamed to the terminal that runs the dev server. In production they land
 * in the Cloudflare dashboard → Workers → quizmaster-supreme → Logs.
 */

export function nowStamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function emit(level: "INFO" | "WARN" | "ERROR", scope: string, message: string, meta?: unknown): void {
  const tail = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  // eslint-disable-next-line no-console
  console[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log"](
    `[qms] ${nowStamp()} ${level} [${scope}] ${message}${tail}`,
  );
}

export const logInfo = (scope: string, message: string, meta?: unknown): void =>
  emit("INFO", scope, message, meta);
export const logWarn = (scope: string, message: string, meta?: unknown): void =>
  emit("WARN", scope, message, meta);
export const logError = (scope: string, message: string, meta?: unknown): void =>
  emit("ERROR", scope, message, meta);

/** Log an arbitrary thrown value with its stack when present. */
export function logException(scope: string, message: string, error: unknown): void {
  const detail =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack?.split("\n").slice(0, 6) }
      : { raw: String(error) };
  logError(scope, message, detail);
}

/** Never log a raw secret. Shows `set(1234…)` instead of the value. */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return "unset";
  return secret.length <= 8 ? "set(****)" : `set(${secret.slice(0, 4)}…${secret.slice(-2)})`;
}