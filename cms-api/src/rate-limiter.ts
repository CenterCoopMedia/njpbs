import { DurableObject } from "cloudflare:workers";

export interface ConsumeRequest {
  capacity: number;
  refillPerSecond: number;
  cost?: number;
  nowMs?: number;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface BucketRow {
  [key: string]: SqlStorageValue;
  tokens: number;
  updated_at: number;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export class CmsRateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS token_bucket (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        tokens REAL NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async consume(input: ConsumeRequest): Promise<ConsumeResult> {
    const { capacity, refillPerSecond } = input;
    if (!finitePositive(capacity) || !finitePositive(refillPerSecond)) {
      throw new TypeError("Rate limit values must be positive finite numbers");
    }
    const cost = input.cost ?? 1;
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > capacity) {
      throw new TypeError("Rate limit cost must be a whole number within capacity");
    }

    const nowMs = input.nowMs ?? Date.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Rate limit time must be a nonnegative integer");
    }

    const stored = [
      ...this.ctx.storage.sql.exec<BucketRow>(
        "SELECT tokens, updated_at FROM token_bucket WHERE singleton = 1",
      ),
    ][0];
    const elapsedMs = stored ? Math.max(0, nowMs - stored.updated_at) : 0;
    const available = stored
      ? Math.min(capacity, stored.tokens + (elapsedMs / 1_000) * refillPerSecond)
      : capacity;
    const allowed = available >= cost;
    const remainingTokens = allowed ? available - cost : available;
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((cost - available) / refillPerSecond));

    this.ctx.storage.sql.exec(
      `INSERT INTO token_bucket (singleton, tokens, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         tokens = excluded.tokens,
         updated_at = excluded.updated_at`,
      remainingTokens,
      nowMs,
    );

    return {
      allowed,
      remaining: Math.max(0, Math.floor(remainingTokens)),
      retryAfterSeconds,
    };
  }
}
