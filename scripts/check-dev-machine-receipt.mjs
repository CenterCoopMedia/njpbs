import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const receiptUrl = "https://dev-public.example.org/_publication.json";

// Statuses and a valid GET's exact byte digest leave this probe. Access redirect
// URLs, credentials and response bodies stay private.
export async function checkDevMachineReceipt({ env = process.env, fetchImpl = fetch, log = console.log, signal, requestTimeoutMs = 30_000 } = {}) {
  const id = env.CMS_DEV_ACCESS_CLIENT_ID;
  const secret = env.CMS_DEV_ACCESS_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Missing dev Access credentials");
  let passed = true;
  for (const method of ["GET", "HEAD"]) {
    const response = await fetchImpl(receiptUrl, {
      method,
      redirect: "manual",
      signal: AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), ...(signal ? [signal] : [])]),
      headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret },
    });
    log(`${method} /_publication.json: ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    let valid = response.status === 200 &&
      /^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") &&
      response.headers.get("cache-control") === "private, no-store";
    // Fetch hides HEAD payloads; this probe proves status and headers only.
    if (method === "GET") {
      try {
        const receipt = JSON.parse(body.toString("utf8"));
        valid &&= receipt !== null && typeof receipt === "object" && !Array.isArray(receipt);
      } catch { valid = false; }
      if (valid) log(JSON.stringify({ kind: "dev-machine-receipt-bytes", method: "GET",
        bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") }));
    }
    passed &&= valid;
  }
  if (!passed) throw new Error("Dev machine receipt proof failed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkDevMachineReceipt().catch(() => {
    console.error("Dev machine receipt proof failed");
    process.exitCode = 1;
  });
}
