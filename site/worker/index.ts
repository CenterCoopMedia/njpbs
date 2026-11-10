// Cloudflare Worker entry for the report-a-problem edge. Deliberately thin: it
// binds the real Workers globals (fetch, Date.now) as the injected dependencies
// and hands off to handleReport, which holds all the logic and is unit-tested
// without the Workers runtime. See report-intake.ts.
import { handleReport } from "./report-intake";
import type { Env, HandleDeps } from "./report-intake";

const deps: HandleDeps = {
  fetch: (input, init) => fetch(input, init as RequestInit),
  now: () => Date.now(),
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleReport(request, env, deps);
  },
};
