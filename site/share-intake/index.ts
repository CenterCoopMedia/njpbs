import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { handleShareIntake } from "./share-intake";
import { applyLimit, initializeLimiter } from "./rate-limit";
import type { Env, HandleDeps, ConfigCache } from "./share-intake";
import type { LimitAction, LimitResult } from "./rate-limit";

const configCache: ConfigCache = { expiresAt: 0, payload: null };
const deps: HandleDeps = { fetch: (input, init) => fetch(input, init), now: () => Date.now(), configCache };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleShareIntake(request, env, deps);
  },
};

// Cloudflare constructs this class from the RATE_LIMITER binding. Its only
// public method is an internal fetch from the Worker above.
export class ShareIntakeLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeLimiter(this.ctx.storage.sql);
  }

  apply(input: LimitAction): LimitResult {
    return applyLimit(this.ctx.storage.sql, input);
  }
}
