export type WorkflowAction = "start" | "approve" | "recover" | "cancel";

/** No secret or prompt data in the URL/body; the token stays in a private header. */
export async function sendWorkflowAction(
  fetcher: Pick<Fetcher, "fetch">,
  token: string,
  action: WorkflowAction,
  jobId: string,
): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(jobId)) return false;
  const response = await fetcher.fetch(new Request(`http://generation-workflow/${action}/${jobId}`, {
    method: "POST",
    headers: { "x-generation-orchestration-token": token },
  }));
  return response.ok;
}
