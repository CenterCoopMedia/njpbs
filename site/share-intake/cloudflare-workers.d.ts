// The site checks DOM code in one TypeScript program. A full Workers global
// declaration replaces DOM types there, so this module declares only the
// Durable Object base used by this entry point.
declare module "cloudflare:workers" {
  export interface DurableObjectState {
    storage: { sql: import("./rate-limit").SqlStore };
  }

  export abstract class DurableObject<Env> {
    protected ctx: DurableObjectState;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
