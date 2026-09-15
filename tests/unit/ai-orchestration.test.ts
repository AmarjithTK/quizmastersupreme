import { describe, expect, it } from "vitest";
import { sendWorkflowAction } from "@/modules/ai/orchestration-core";

describe("private generation Workflow dispatch", () => {
  it("uses a scoped service-binding request and header secret", async () => {
    const observed: Request[] = [];
    const fetcher = { async fetch(request: Request) { observed.push(request); return new Response("ok", { status: 200 }); } };
    expect(await sendWorkflowAction(fetcher as Pick<Fetcher, "fetch">, "fixture-secret", "start", "job_123")).toBe(true);
    expect(observed[0]?.url).toBe("http://generation-workflow/start/job_123");
    expect(observed[0]?.method).toBe("POST");
    expect(observed[0]?.headers.get("x-generation-orchestration-token")).toBe("fixture-secret");
  });

  it("rejects unsafe IDs and non-2xx dispatches without a second call", async () => {
    let calls = 0;
    const fetcher = { async fetch() { calls++; return new Response("unavailable", { status: 503 }); } };
    expect(await sendWorkflowAction(fetcher as Pick<Fetcher, "fetch">, "fixture", "recover", "../../other")).toBe(false);
    expect(calls).toBe(0);
    expect(await sendWorkflowAction(fetcher as Pick<Fetcher, "fetch">, "fixture", "recover", "job_123")).toBe(false);
    expect(calls).toBe(1);
  });
});
