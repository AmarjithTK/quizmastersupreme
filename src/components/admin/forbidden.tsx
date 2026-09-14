/** Shared 403 card for admin-only pages. */
export function ForbiddenCard() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">You do not have access</h1>
      <p className="mt-2 text-sm text-slate-500">The admin console is restricted to administrators.</p>
    </div>
  );
}