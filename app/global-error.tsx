"use client";

/**
 * Global error boundary (M14).
 *
 * Next.js requires this file separately from `error.tsx`: it replaces the
 * ROOT layout when that layout itself throws, so it must render its own
 * minimal HTML (no shared layout components — they may be the thing that broke).
 */

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <div
          style={{
            minHeight: "60vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div style={{ maxWidth: 400, textAlign: "center" }}>
            <h1 style={{ fontSize: 20, fontWeight: 600 }}>Something went wrong</h1>
            <p style={{ marginTop: 8, fontSize: 14, color: "#64748b" }}>
              The app hit an unexpected error while rendering. Your data is safe.
            </p>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                marginTop: 24,
                padding: "8px 20px",
                borderRadius: 8,
                border: 0,
                background: "#0f172a",
                color: "#fff",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}