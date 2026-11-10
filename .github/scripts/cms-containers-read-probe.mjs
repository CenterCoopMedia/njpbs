import { pathToFileURL } from "node:url";

const APPLICATION = "njpbs-cms-preview-renderer";
const failure = () => new Error("Cloud preview Containers reads could not be verified");

// This trusted-workflow gate uses only Node built-ins. Older selected releases
// do not need a new CLI command, dependencies or a copied deployment helper.
export async function probeCmsContainers(token, {
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID, request = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "")) throw failure();
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/applications`;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token ?? "")) throw failure();
  const read = async suffix => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response;
      try {
        response = await request(api + suffix, {
          method: "GET", headers: { Authorization: `Bearer ${token}` },
          redirect: "error", signal: AbortSignal.timeout(15_000),
        });
      } catch {
        if (attempt === 3) throw failure();
        await sleep(10_000);
        continue;
      }
      if (response.ok) {
        let body;
        try { body = await response.json(); } catch { throw failure(); }
        if (body?.success !== true) throw failure();
        return body.result;
      }
      await response.body?.cancel();
      if ((![408, 429].includes(response.status) && response.status < 500) || attempt === 3) throw failure();
      await sleep(10_000);
    }
  };
  const applications = await read("");
  if (!Array.isArray(applications) || applications.some(row => !row || typeof row !== "object")) throw failure();
  const matches = applications.filter(row => row.name === APPLICATION);
  if (matches.length === 0) return; // First installation has no application yet.
  if (matches.length !== 1 || !/^[a-f0-9-]{36}$/.test(matches[0].id ?? "")) throw failure();
  const id = matches[0].id;
  if ((await read(`/${id}`))?.id !== id) throw failure();
  const seen = new Set();
  let last;
  for (;;) {
    const result = await read(`/${id}/rollouts?limit=100${last ? `&last=${encodeURIComponent(last)}` : ""}`);
    const rows = Array.isArray(result) ? result : result?.rollouts;
    if (!Array.isArray(rows) || rows.length > 100) throw failure();
    for (const row of rows) {
      if (typeof row?.id !== "string" || !row.id || seen.has(row.id)
        || !Number.isFinite(Date.parse(row.created_at))
        || !["pending", "progressing", "completed", "reverted", "replaced"].includes(row.status)) throw failure();
      seen.add(row.id);
    }
    if (rows.length < 100) return;
    last = rows.at(-1).id;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  try {
    await probeCmsContainers(token);
    process.stdout.write("Cloud preview Containers reads verified\n");
  } catch {
    process.stderr.write("Cloud preview Containers reads could not be verified\n");
    process.exitCode = 1;
  }
}
