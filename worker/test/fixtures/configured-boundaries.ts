// Local-only instrumentation: no handler or instrumentation enters the shipped Worker.
import { observerRequest } from "../../src/observer-http.ts";
export default {
  async fetch(request: Request, env: Record<string, unknown>) {
    if (new URL(request.url).pathname === "/runtime-date-probe") {
      // Default-on since 2026-10-01 in pinned workerd's compatibility schema.
      return Response.json(Cloudflare.compatibilityFlags.durable_object_io_tasks_prevent_eviction === true);
    }
    let acquisitions = 0;
    const result = await observerRequest(request, env, async () => {
      acquisitions++;
      throw new Error("binding unavailable");
    });
    const response = new Response(result.body, result);
    response.headers.set("x-test-ledger-acquisitions", String(acquisitions));
    return response;
  },
};
