import { Container, getContainer } from "@cloudflare/containers";
import { readNoBuildPublicationWork as readPublicationWork } from "./pending-work";
import targets from "../functions/lib/publication-target.js";
import { publishWithdrawalCatalog } from "./withdrawal-catalog";
import { publishPageWithdrawalCatalog } from "./page-withdrawal-catalog";
import { publishRecordWithdrawalCatalog } from "./record-withdrawal-catalog";

type PublicationEnvironment = Env & { R2_MEDIA_CREDENTIAL?: string };

export class PublicationRuntime extends Container<PublicationEnvironment> {
  defaultPort = 8080;
  sleepAfter = "3m";
  envVars = {
    CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_PUBLIC_WORKER_TAG: this.env.CLOUDFLARE_PUBLIC_WORKER_TAG,
    CMS_DEPLOYMENT_ENVIRONMENT: this.env.CMS_DEPLOYMENT_ENVIRONMENT,
    CMS_PUBLICATION_COMMIT_SHA: this.env.PUBLICATION_COMMIT_SHA,
    CMS_PUBLICATION_SERIALIZER_ID: this.env.PUBLICATION_SERIALIZER_ID,
    CMS_PUBLICATION_FIREBASE_ACCOUNT: this.env.FIREBASE_SERVICE_ACCOUNT,
    CMS_PUBLICATION_R2_CREDENTIAL: this.env.R2_PUBLICATION_CREDENTIAL,
    CMS_PUBLICATION_PREVIEW_R2_CREDENTIAL: this.env.R2_PREVIEW_CREDENTIAL,
    CMS_PUBLICATION_ACTIVATION_TOKEN: this.env.ACTIVATION_TOKEN,
    CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL: this.env.MEDIA_MANAGER_CREDENTIAL,
    ...(this.env.R2_MEDIA_CREDENTIAL ? { CMS_PUBLICATION_MEDIA_R2_CREDENTIAL: this.env.R2_MEDIA_CREDENTIAL } : {}),
    CMS_MEDIA_R2_ENDPOINT: this.env.CMS_MEDIA_R2_ENDPOINT,
    CMS_MEDIA_R2_BUCKET: this.env.CMS_MEDIA_R2_BUCKET,
    PUBLIC_GA4_MEASUREMENT_ID: this.env.PUBLIC_GA4_MEASUREMENT_ID,
    PUBLIC_REPORT_ENDPOINT: this.env.PUBLIC_REPORT_ENDPOINT,
    PUBLIC_SHARE_INTAKE_ENDPOINT: this.env.PUBLIC_SHARE_INTAKE_ENDPOINT?.trim() || "https://intake.njpbs.org",
    PUBLIC_TURNSTILE_SITEKEY: this.env.PUBLIC_TURNSTILE_SITEKEY,
    PUBLIC_SHARE_PAGE: this.env.PUBLIC_SHARE_PAGE,
    PUBLIC_SHARE_UPLOAD_ORIGIN: this.env.PUBLIC_SHARE_UPLOAD_ORIGIN,
  };

  async check() {
    let healthy = false;
    let diagnostics: { reasons: string[]; oldestDueAt: number | null } | undefined;
    try {
      if (this.env.PUBLICATION_ENABLED !== "true") {
        await this.stop();
        return;
      }
      const work = await readPublicationWork({
        account: this.env.FIREBASE_SERVICE_ACCOUNT,
        commitSha: this.env.PUBLICATION_COMMIT_SHA,
        serializerId: this.env.PUBLICATION_SERIALIZER_ID,
        target: targets.publicationTarget(this.env.CMS_DEPLOYMENT_ENVIRONMENT),
      });
      diagnostics = work.diagnostics;
      if (work.needsRuntime) {
        const response = await this.containerFetch("http://container/wake", { method: "POST" });
        // Drain even error replies: the SDK retains activity until the body ends.
        const health = await response.json<{
          status: string;
          commitSha: string;
          serializerId: string;
        }>();
        if (!response.ok)
          throw new Error("Cloud publication runtime is not ready");
        if (
          health.status !== "ready" ||
          health.commitSha !== this.env.PUBLICATION_COMMIT_SHA ||
          health.serializerId !== this.env.PUBLICATION_SERIALIZER_ID
        )
          throw new Error("Cloud publication runtime identity differs");
      }
      healthy = work.healthy;
      try {
        const target = targets.publicationTarget(this.env.CMS_DEPLOYMENT_ENVIRONMENT);
        const options = { store: this.env.DURABLE_POST_WITHDRAWALS, target,
          account: this.env.FIREBASE_SERVICE_ACCOUNT, commitSha: this.env.PUBLICATION_COMMIT_SHA };
        const catalogs = await Promise.allSettled([publishWithdrawalCatalog(options),
          publishPageWithdrawalCatalog(options), publishRecordWithdrawalCatalog(options)]);
        if (catalogs.some(result => result.status === "rejected")) throw new Error("Withdrawal catalog unavailable");
      } catch {
        // Observation/write failure keeps the prior durable catalog and does
        // not prevent the existing accepted-work recovery from running.
        healthy = false;
        diagnostics = { reasons: [...(diagnostics?.reasons ?? []), "withdrawal_catalog_unavailable"],
          oldestDueAt: diagnostics?.oldestDueAt ?? null };
        console.error("Durable withdrawal catalog publication failed");
      }
    } catch {
      // Provider responses and credentials never enter logs or public health.
      console.error("Cloud publication health check failed");
    } finally {
      await this.ctx.storage.put("health", {
        healthy,
        checkedAt: Date.now(),
        commitSha: this.env.PUBLICATION_COMMIT_SHA,
        ...(diagnostics ? { diagnostics } : {}),
      });
    }
  }

  async onActivityExpired() {
    // This hook runs for an already active container. Only unfinished bounded
    // work extends its lifetime; idle health observation never starts compute.
    try {
      if (!["running", "healthy"].includes((await this.getState()).status)) { await this.stop(); return; }
      const response = await this.containerFetch("http://container/health");
      const health = await response.json<{ busy?: boolean; commitSha?: string; serializerId?: string }>();
      if (response.ok && health.busy === true && health.commitSha === this.env.PUBLICATION_COMMIT_SHA &&
          health.serializerId === this.env.PUBLICATION_SERIALIZER_ID) {
        await this.renewActivityTimeout();
        return;
      }
    } catch { /* Stop; durable recovery owns any interrupted work. */ }
    await this.stop();
  }

  async health() {
    const health = await this.ctx.storage.get<{
      healthy: boolean;
      checkedAt: number;
      commitSha: string;
    }>("health");
    return (
      this.env.PUBLICATION_ENABLED === "true" &&
      health?.healthy === true &&
      health.commitSha === this.env.PUBLICATION_COMMIT_SHA &&
      Number.isFinite(health.checkedAt) && health.checkedAt <= Date.now() &&
      Date.now() - health.checkedAt < 150_000
    );
  }
}

export default {
  async fetch(request, env) {
    const wakeUrl = new URL(request.url);
    if (request.method === "POST" && wakeUrl.pathname === "/wake" && !wakeUrl.search) {
      if (!await authenticatedWake(request, env)) return new Response(null, { status: 403 });
      await getContainer(env.PUBLISHER, "publication-serializer").check();
      return new Response(null, { status: 204 });
    }
    const url = new URL(request.url);
    if (
      !["GET", "HEAD"].includes(request.method) ||
      url.pathname !== "/health" ||
      url.search
    )
      return new Response(null, { status: 404 });
    // A public request reads one aggregate result. It cannot start a container,
    // supply a queue identity, access private storage or request a publication.
    const healthy = await getContainer(
      env.PUBLISHER,
      "publication-serializer",
    ).health();
    return new Response(
      request.method === "HEAD"
        ? null
        : JSON.stringify({ status: healthy ? "ok" : "unavailable" }),
      {
        status: healthy ? 200 : 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  },
  async scheduled(_event, env) {
    await getContainer(env.PUBLISHER, "publication-serializer").check();
  },
} satisfies ExportedHandler<Env>;


async function authenticatedWake(request: Request, env: Env): Promise<boolean> {
  let environment: string;
  try { environment = targets.publicationTarget(env.CMS_DEPLOYMENT_ENVIRONMENT).environment; }
  catch { return false; }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(env.PUBLICATION_WAKE_TOKEN ?? "") ||
      request.headers.get("x-publication-target") !== environment ||
      request.headers.get("x-publication-release") !== env.PUBLICATION_COMMIT_SHA) return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.length > 160) return false;
  const bytes = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [actual, expected] = await Promise.all([bytes(authorization), bytes(`Bearer ${env.PUBLICATION_WAKE_TOKEN}`)]);
  const left = new Uint8Array(actual), right = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export { PublicationWake } from "./wake";
