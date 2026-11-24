import { pathToFileURL } from "node:url";
import releaseWait from "../../functions/lib/release-wait.js";

const { callOutside } = releaseWait;

const failure = () => new Error("Cloud preview Containers reads could not be verified");

// A development run reads only the dev renderer the workflow names (cms-target.mjs rule).
export function probeApplication(env = process.env) {
  if (env.CMS_TARGET !== "development") return "njpbs-cms-preview-renderer";
  const name = env.CMS_DEV_PREVIEW_RENDERER ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || !name.split("-").includes("dev")) throw failure();
  return name;
}

// This trusted-workflow gate uses only Node built-ins and the release-gate
// checkout's wait module. Older selected releases do not need a new CLI
// command, dependencies or a copied deployment helper.
export async function probeCmsContainers(token, {
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID, application = probeApplication(), request = fetch,
} = {}) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "")) throw failure();
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/applications`;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token ?? "")) throw failure();
  const read = async suffix => {
    let response;
    try {
      response = await callOutside(`Cloudflare Containers read ${suffix || "/"}`, async () => {
        const answer = await request(api + suffix, { method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
        if (answer.ok || (![408, 429].includes(answer.status) && answer.status < 500)) return answer;
        await answer.body?.cancel();
        throw Object.assign(new Error(`Containers read answered ${answer.status}`), { retry: true });
      });
    } catch { throw failure(); }
    if (!response.ok) { await response.body?.cancel(); throw failure(); }
    let body;
    try { body = await response.json(); } catch { throw failure(); }
    if (body?.success !== true) throw failure();
    return body.result;
  };
  const applications = await read("");
  if (!Array.isArray(applications) || applications.some(row => !row || typeof row !== "object")) throw failure();
  const matches = applications.filter(row => row.name === application);
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
