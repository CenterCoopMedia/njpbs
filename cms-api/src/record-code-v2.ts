import { Buffer } from "node:buffer";

type Environment = { FUNCTIONS_ORIGIN: string; CMS_EDGE_ORIGIN_SECRET: string };
const LIMIT = Math.ceil(20 * 1024 * 1024 / 3) * 4 + 64 * 1024;
/** Called only after the existing record-code route's private channel, target
 * and bounded-input checks. The request never supplies an origin or endpoint.
 */
export async function handlePairRecordCode(input: unknown, env: Environment, request: typeof fetch = fetch) {
  const editorial = typeof input === "object" && input !== null && "mode" in input &&
    typeof input.mode === "string" && input.mode.startsWith("current-editorial");
  const refused = (pending = false) => Response.json({ error: "Versioned current CODE unavailable",
    ...(pending ? { code: "pair_editorial_context_refreshing" } : {}) }, { status: editorial && !pending ? 409 : 503,
    headers: { "cache-control": "private, no-store" } });
  try {
    const upstream = await request(`${env.FUNCTIONS_ORIGIN}/cmsReadPairCurrentCodeV2`, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json", "x-njpbs-cms-edge": env.CMS_EDGE_ORIGIN_SECRET },
      body: JSON.stringify(input) });
    if (!upstream.body || !upstream.headers.get("content-type")?.startsWith("application/json")) {
      await upstream.body?.cancel(); return refused();
    }
    const reader = upstream.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const row = await reader.read(); if (row.done) break;
      size += row.value.length; if (size > (upstream.ok ? LIMIT : 4096)) return refused(); chunks.push(row.value); }
    } finally { await reader.cancel(); }
    if (!upstream.ok) return refused(editorial && upstream.status === 503 &&
      JSON.parse(Buffer.concat(chunks, size).toString("utf8"))?.code === "pair_editorial_context_refreshing");
    return new Response(Buffer.concat(chunks, size), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });
  } catch (error) { return refused(editorial && ["TimeoutError", "AbortError"].includes((error as { name?: string })?.name ?? "")); }
}
