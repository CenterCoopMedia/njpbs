import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { CmsRateLimiter } from "../src/rate-limiter";

// First exercise real admission, then verify its persisted capacity/debit before
// moving to the last token. Avoid hundreds of identical transport round trips.
export async function leaveOneRateToken(scope: "actor" | "ip", rateClass: "staffSite" | "upload",
  subject: string, expectedRemaining: number, nowMs: number) {
  const key = createHash("sha256").update(`${scope}\0${rateClass}\0${subject}`).digest("base64url");
  const namespace = env.RATE_LIMITERS as unknown as DurableObjectNamespace<CmsRateLimiter>;
  const rows = await runInDurableObject(namespace.getByName(`v1:${scope}:${rateClass}:${key}`), (_instance, state) => {
    const rows = [...state.storage.sql.exec("SELECT tokens, updated_at FROM token_bucket WHERE singleton=1")];
    state.storage.sql.exec("UPDATE token_bucket SET tokens=1, updated_at=? WHERE singleton=1", nowMs);
    return rows;
  });
  expect(rows).toEqual([{ tokens: expectedRemaining, updated_at: nowMs }]);
}
