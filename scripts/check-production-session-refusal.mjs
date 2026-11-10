#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { launchCmsBrowser, parseBrowserCredential, submitCmsSignIn } from "./cms-debug-browser.mjs";
import { developmentInstallAccess, developmentInstallCredential } from "./lib/development-install-credentials.mjs";

const ADMIN = "https://admin.njpbs.org";
const SIGN_IN = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const ROUTE = "https://dev-public.example.org/__cms-session";
const DEV_ADMIN = "https://dev-admin.example.org";

// The normal shell can register a profile after authentication. This probe
// blocks every CMS/Firestore request, including reads, before loading the app.
export function productionProbeRequestAllowed(url, method) {
  const target = new URL(url);
  if (target.username || target.password || target.protocol !== "https:") return false;
  return target.origin === ADMIN && ["GET", "HEAD"].includes(method) ||
    `${target.origin}${target.pathname}` === SIGN_IN && method === "POST";
}

function productionToken(value, now) {
  const token = value?.idToken;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 3500) {
    throw new Error("invalid_production_session");
  }
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  const seconds = Math.floor(now / 1000);
  // Provenance is the successful HTTPS Firebase response, not an untrusted
  // caller-supplied JWT. These checks classify its production audience only.
  if (claims.aud !== "njpbs-site" || claims.iss !== "https://securetoken.google.com/njpbs-site" ||
      typeof claims.sub !== "string" || !claims.sub || claims.sub !== value.localId ||
      typeof claims.exp !== "number" || claims.exp <= seconds ||
      typeof claims.iat !== "number" || claims.iat > seconds + 5 || claims.iat < seconds - 120) {
    throw new Error("invalid_production_session");
  }
  return token;
}

// Only the four bounded refusal fields leave this function. No browser console,
// response body, redirect, token, cookie, storage state or trace is exported.
export async function checkProductionSessionRefusal({
  chromium, readCredential, readAccess, fetchImpl = fetch, now = Date.now,
}) {
  let browser;
  let token;
  try {
    browser = await launchCmsBrowser(chromium);
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await context.route("**/*", (route) => productionProbeRequestAllowed(route.request().url(), route.request().method())
      ? route.fallback() : route.abort("blockedbyclient"));
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`${ADMIN}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (new URL(page.url()).origin !== ADMIN) throw new Error("invalid_production_session");
    token = await submitCmsSignIn(page, readCredential, async () => {
      const response = await page.waitForResponse((reply) =>
        `${new URL(reply.url()).origin}${new URL(reply.url()).pathname}` === SIGN_IN &&
        reply.request().method() === "POST", { timeout: 30_000 });
      if (response.status() !== 200) throw new Error("invalid_production_session");
      return productionToken(await response.json(), now());
    });
    // Dispose of Firebase's incognito in-memory storage before probing dev.
    await browser.close();
    browser = undefined;
    const access = await readAccess();
    const response = await fetchImpl(ROUTE, {
      method: "POST", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      headers: { ...access, origin: DEV_ADMIN, authorization: `Bearer ${token}` },
    });
    token = undefined;
    await response.body?.cancel();
    // Outer Access challenges, origin refusals, outages and rate limits are
    // inconclusive. The Worker's credentialed CORS/no-store contract plus 401
    // distinguishes staff admission from those earlier gates.
    const refused = response.status === 401 &&
      response.headers.get("access-control-allow-origin") === DEV_ADMIN &&
      response.headers.get("access-control-allow-credentials") === "true" &&
      response.headers.get("cache-control") === "private, no-store" &&
      !response.headers.getSetCookie().some((cookie) => /^\s*__Host-njpbs-staff=/.test(cookie));
    return { status: response.status, route: ROUTE, refused,
      audienceMismatch: refused ? "production_token_refused_by_dev" : "unproven" };
  } catch {
    return { status: null, route: ROUTE, refused: false, audienceMismatch: "unproven" };
  } finally {
    token = undefined;
    await browser?.close().catch(() => {});
  }
}

async function main() {
  let credentialPipe;
  let accessPipe;
  let result = { status: null, route: ROUTE, refused: false, audienceMismatch: "unproven" };
  try {
    // Reserve inherited pipes before SDK initialization can reuse their FDs.
    // Refuse regular files and TTYs; credentials are fetched only at use.
    if (process.argv.length !== 2 || process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_OPTIONS) throw new Error();
    credentialPipe = developmentInstallCredential(3, parseBrowserCredential);
    accessPipe = developmentInstallCredential(4, developmentInstallAccess);
    const require = createRequire(new URL("../admin/package.json", import.meta.url));
    const { chromium } = require("@playwright/test");
    result = await checkProductionSessionRefusal({
      chromium, readCredential: credentialPipe.read, readAccess: accessPipe.read,
    });
  } catch { /* Only the bounded result below may reach stdio. */ }
  finally { credentialPipe?.close(); accessPipe?.close(); }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.refused) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
