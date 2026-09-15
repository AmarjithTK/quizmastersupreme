export type FunnelCounts = {
  askedCount: number;
  rawItemCount: number;
  modelShortfallCount: number;
  schemaValidCount: number;
  schemaInvalidCount: number;
  contentValidCount: number;
  contentInvalidCount: number;
  policyValidCount: number;
  policyRejectedCount: number;
  duplicateFlaggedCount: number;
  acceptedCount: number;
};

export function reconcileFunnel(input: Omit<FunnelCounts, "modelShortfallCount">): FunnelCounts {
  const counts: FunnelCounts = {
    ...input,
    modelShortfallCount: Math.max(0, input.askedCount - input.rawItemCount),
  };
  const failures: string[] = [];
  if (counts.rawItemCount !== counts.schemaValidCount + counts.schemaInvalidCount) {
    failures.push("raw != schema-valid + schema-invalid");
  }
  if (counts.schemaValidCount !== counts.contentValidCount + counts.contentInvalidCount) {
    failures.push("schema-valid != content-valid + content-invalid");
  }
  if (counts.contentValidCount !== counts.policyValidCount + counts.policyRejectedCount) {
    failures.push("content-valid != policy-valid + policy-rejected");
  }
  if (counts.policyValidCount !== counts.acceptedCount + counts.duplicateFlaggedCount) {
    failures.push("policy-valid != accepted + duplicate-flagged");
  }
  if (failures.length > 0) throw new Error(`Generation funnel invariant failed: ${failures.join("; ")}`);
  return counts;
}

