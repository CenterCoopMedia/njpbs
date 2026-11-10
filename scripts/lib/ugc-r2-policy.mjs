import { readFile } from "node:fs/promises";

const EXPECTED = Object.freeze({
  lifecycle: {
    rules: [
      { id: "delete-ugc-quarantine-after-90-days", enabled: true,
        conditions: { prefix: "ugc-quarantine/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 90 * 86400 } } },
      { id: "abort-ugc-multipart-after-7-days", enabled: true,
        conditions: { prefix: "" },
        abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * 86400 } } },
    ],
  },
  cors: {
    rules: [{ id: "ugc-browser-upload", allowed: {
      origins: ["https://njpbs.org"], methods: ["PUT", "HEAD"],
      headers: ["Content-Type", "If-None-Match"],
    }, maxAgeSeconds: 600 }],
  },
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => !((key === "exposeHeaders" || key === "storageClassTransitions") &&
        Array.isArray(item) && item.length === 0))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function assertUgcR2Policy(kind, policy) {
  if (!Object.hasOwn(EXPECTED, kind)) throw new Error("Unknown UGC R2 policy");
  const rules = policy?.rules;
  if (!Array.isArray(rules) || JSON.stringify(canonical({ rules })) !==
      JSON.stringify(canonical(EXPECTED[kind]))) {
    throw new Error(`UGC R2 ${kind} rules differ from the approved rule set`);
  }
}

export async function runUgcR2Policy(kind, args, env = process.env) {
  if (args.length !== 1 || !["--check", "--apply"].includes(args[0])) {
    throw new Error(`Usage: node scripts/ugc-r2-${kind}.mjs --check|--apply`);
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = env.UGC_R2_BUCKET;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/i.test(account ?? "") ||
      !/^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/.test(bucket ?? "") || !token?.trim()) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID, UGC_R2_BUCKET and CLOUDFLARE_API_TOKEN are required");
  }
  const policy = JSON.parse(await readFile(new URL(`../ugc-r2-${kind}.json`, import.meta.url), "utf8"));
  assertUgcR2Policy(kind, policy);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/${kind}`;
  async function request(method, body) {
    const response = await fetch(endpoint, { method, headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok || result.success !== true) {
      throw new Error(`UGC R2 ${kind} ${method} failed (${response.status})`);
    }
    return result.result;
  }
  if (args[0] === "--apply") await request("PUT", policy);
  assertUgcR2Policy(kind, await request("GET"));
  console.log(`UGC R2 ${kind} verified for ${bucket}.`);
}
