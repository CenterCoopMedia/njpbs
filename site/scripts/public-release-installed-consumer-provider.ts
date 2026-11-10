import { GoogleAuth } from "google-auth-library";
import targets from "../../functions/lib/publication-target.js";
import { jsonResponse } from "../../publisher/pending-work";
import { parseInstalledConsumerProbe } from "./public-release-installed-consumer-contract";

type Row = Record<string, any>;
export type InstalledConsumerProvider = ReturnType<typeof createInstalledConsumerProvider>;
export type InstalledFunctionRecord = ReturnType<typeof safeFunction>;
function refuse(): never { throw new Error("Installed consumer provider evidence is unavailable"); }
const record = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  return value as Row;
};
const text = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 4096) return refuse();
  return value;
};
const storageSource = (value: unknown) => {
  if (!value) return null;
  const source = record(value);
  // Never retain a signed upload URL from provider metadata.
  return { bucket: text(source.bucket), object: text(source.object), generation: text(source.generation) };
};
function safeFunction(raw: unknown, projectId: string) {
  const row = record(raw), build = record(row.buildConfig ?? {}), service = record(row.serviceConfig ?? {});
  if (typeof row.name !== "string" || !row.name.startsWith(`projects/${projectId}/locations/us-central1/functions/`) ||
      !/^[A-Za-z][A-Za-z0-9-]*$/.test(row.name.split("/").at(-1) ?? "")) refuse();
  const variables = record(service.environmentVariables ?? {});
  if (Object.keys(variables).length > 200 || Object.keys(variables).some(name => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) ||
      service.allTrafficOnLatestRevision !== undefined && typeof service.allTrafficOnLatestRevision !== "boolean") refuse();
  const secrets = service.secretEnvironmentVariables ?? [];
  if (!Array.isArray(secrets) || secrets.length > 100) refuse();
  // The existing inventory digest consumes key names and secret references,
  // never environment values. Keep only that safe projection in the proof.
  return { name: row.name, state: text(row.state), updateTime: text(row.updateTime), environment: text(row.environment),
    buildConfig: { runtime: text(build.runtime), entryPoint: text(build.entryPoint),
      source: { storageSource: storageSource(build.source?.storageSource) },
      sourceProvenance: { resolvedStorageSource: storageSource(build.sourceProvenance?.resolvedStorageSource) } },
    serviceConfig: { uri: text(service.uri), revision: text(service.revision), service: text(service.service),
      allTrafficOnLatestRevision: service.allTrafficOnLatestRevision ?? null,
      environmentVariables: Object.fromEntries(Object.keys(variables).map(name => [name, null])),
      secretEnvironmentVariables: secrets.map(raw => {
        const item = record(raw);
        return { key: text(item.key), projectId: text(item.projectId), secret: text(item.secret), version: text(item.version) };
      }) } };
}

/** Read-only closed provider paths. No credential or raw provider response
 * escapes this adapter. Construction does not initialize ADC or read a secret. */
export function createInstalledConsumerProvider({ environment, request = fetch, readGoogleToken,
  signal = AbortSignal.timeout(30_000) }: {
  environment: "production" | "development"; request?: typeof fetch;
  readGoogleToken?: () => Promise<string>; signal?: AbortSignal;
}) {
  const target = targets.publicationTarget(environment);
  let client: Awaited<ReturnType<GoogleAuth["getClient"]>> | undefined;
  const token = readGoogleToken ?? (async () => {
    client ??= await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
    const result = await client.getAccessToken();
    if (!result.token) refuse();
    return result.token;
  });
  const credentialWithinDeadline = async () => {
    signal.throwIfAborted();
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([Promise.resolve().then(token), new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Installed consumer credential deadline exceeded"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
    } finally { signal.removeEventListener("abort", onAbort); }
  };
  const google = async (url: string) => {
    try {
      signal.throwIfAborted();
      const credential = await credentialWithinDeadline();
      signal.throwIfAborted();
      if (!/^[\x21-\x7e]{1,32768}$/.test(credential)) refuse();
      return await jsonResponse(await request(url, { headers: { authorization: `Bearer ${credential}` }, redirect: "error",
        cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }), 2 * 1024 * 1024);
    } catch { return refuse(); }
  };
  return {
    async readInventory() {
      const found: ReturnType<typeof safeFunction>[] = [], names = new Set<string>(), tokens = new Set<string>();
      let pageToken = "";
      for (let page = 0; page < 20; page++) {
        const url = new URL(`https://cloudfunctions.googleapis.com/v2/projects/${target.projectId}/locations/us-central1/functions`);
        url.searchParams.set("pageSize", "100"); if (pageToken) url.searchParams.set("pageToken", pageToken);
        const value = record(await google(url.href));
        if (Object.keys(value).some(key => !["functions", "unreachable", "nextPageToken"].includes(key)) ||
            !Array.isArray(value.functions ?? []) || (value.functions?.length ?? 0) > 100 ||
            !Array.isArray(value.unreachable ?? []) || value.unreachable?.length ||
            value.nextPageToken !== undefined && (typeof value.nextPageToken !== "string" || value.nextPageToken.length > 2048)) refuse();
        for (const raw of value.functions ?? []) {
          const row = safeFunction(raw, target.projectId);
          if (names.has(row.name)) refuse(); names.add(row.name); found.push(row);
        }
        pageToken = value.nextPageToken ?? "";
        if (!pageToken) return found;
        if (tokens.has(pageToken)) refuse(); tokens.add(pageToken);
      }
      return refuse();
    },
    async readProbe(inventory: readonly InstalledFunctionRecord[], nonce: string) {
      if (!/^[a-f0-9]{64}$/.test(nonce)) refuse();
      const name = `projects/${target.projectId}/locations/us-central1/functions/cmsGetPublicPage`;
      const matches = inventory.filter(row => row.name === name);
      if (matches.length !== 1) refuse();
      const secrets = matches[0].serviceConfig.secretEnvironmentVariables.filter(item => item.key === "CMS_EDGE_ORIGIN_SECRET");
      if (secrets.length !== 1 || secrets[0].secret !== "CMS_EDGE_ORIGIN_SECRET" || !/^(latest|[1-9]\d{0,18})$/.test(secrets[0].version ?? "")) refuse();
      let secretBytes: Buffer | undefined;
      try {
        const body = record(await google(`https://secretmanager.googleapis.com/v1/projects/${target.projectId}/secrets/CMS_EDGE_ORIGIN_SECRET/versions/${secrets[0].version}:access`));
        const payload = record(body.payload);
        if (typeof payload.data !== "string" || payload.data.length > 64 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.data)) refuse();
        secretBytes = Buffer.from(payload.data, "base64"); payload.data = "";
        const credential = secretBytes.toString("utf8").trim();
        if (!/^[\x21-\x7e]{1,32768}$/.test(credential)) refuse();
        signal.throwIfAborted();
        return parseInstalledConsumerProbe(await jsonResponse(await request(`https://us-central1-${target.projectId}.cloudfunctions.net/cmsGetPublicPage`, {
          method: "POST", headers: { "content-type": "application/json", "x-njpbs-cms-edge": credential },
          body: JSON.stringify({ mode: "release-installed-consumers-v2", nonce }), redirect: "error", cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }), 64 * 1024), nonce);
      } catch { return refuse(); }
      finally { secretBytes?.fill(0); }
    },
  };
}
