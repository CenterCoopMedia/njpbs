import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { launchCmsBrowser, parseBrowserCredential, submitCmsSignIn } from "./cms-debug-browser.mjs";
import { developmentInstallAccess } from "./lib/development-install-credentials.mjs";
import { developmentValues } from "./render-development-config.mjs";

const production = { admin: "https://admin.njpbs.org", preview: "https://preview.njpbs.org" };
const editorPath = /^\/content\/(?:pages|posts)\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/edit$/;
const previewPath = /^\/p\/[A-Za-z0-9]{20}\//;

export function previewSmokeSettings(environment, env) {
  if (!env.CMS_PREVIEW_SMOKE_CREDENTIAL) throw new Error("missing_credential");
  if (!env.CMS_PREVIEW_SMOKE_TARGET) throw new Error("missing_target");
  const input = JSON.parse(env.CMS_PREVIEW_SMOKE_CREDENTIAL);
  const credential = parseBrowserCredential(env.CMS_PREVIEW_SMOKE_CREDENTIAL);
  const { editor, heading } = JSON.parse(env.CMS_PREVIEW_SMOKE_TARGET);
  if (typeof editor !== "string" || !editorPath.test(editor) ||
      typeof heading !== "string" || !heading.trim() || heading.length > 300) throw new Error("invalid_target");

  if (environment === "production") return { ...production, credential, editor, heading, access: [] };
  if (environment !== "development") throw new Error("invalid_environment");
  const { CMS_DEV_ADMIN_ORIGIN: admin, CMS_DEV_PREVIEW_ORIGIN: preview } = developmentValues(env, {
    only: ["CMS_DEV_ADMIN_ORIGIN", "CMS_DEV_PREVIEW_ORIGIN"],
  });
  if ([admin, preview].some(origin => Object.values(production).includes(origin))) throw new Error("invalid_environment");
  const access = [[admin, developmentInstallAccess(JSON.stringify(input.adminAccess))],
    [preview, developmentInstallAccess(JSON.stringify(input.previewAccess))]];
  return { admin, preview, credential, editor, heading, access };
}

export async function routePreviewSmokeAccess(context, origin, headers) {
  await context.route(url => url.origin === origin, async route => {
    let response;
    try {
      // Fetch one hop so Access credentials cannot follow a redirect.
      response = await route.fetch({ headers: { ...route.request().headers(), ...headers }, maxRedirects: 0 });
      await route.fulfill({ response });
    } catch {
      await route.abort().catch(() => {});
    } finally {
      await response?.dispose().catch(() => {});
    }
  });
}

class PreviewSmokeFailure extends Error {}

export async function checkSignedInPreview(browser, { admin, preview, credential, editor, heading, access }) {
  let phase = "admin_unavailable";
  try {
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    for (const [origin, headers] of access) await routePreviewSmokeAccess(context, origin, headers);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const entry = await page.goto(`${admin}/`, { waitUntil: "domcontentloaded" });
    if (entry?.status() !== 200 || new URL(page.url()).origin !== admin) throw new Error();

    phase = "staff_sign_in_failed";
    await submitCmsSignIn(page, async () => credential, () => page
      .getByRole("button", { name: /^Account menu for / }).waitFor({ state: "visible" }));
    if (new URL(page.url()).origin !== admin) throw new Error();

    phase = "editor_unavailable";
    const editorUrl = `${admin}${editor}`;
    await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
    if (page.url() !== editorUrl) throw new Error();
    const button = page.getByRole("button", { name: "Preview", exact: true });
    await button.waitFor({ state: "visible" });

    phase = "private_preview_unavailable";
    // The initial document must render directly with the new staff cookie.
    // Following a sign-in redirect and then succeeding would miss the race.
    const [popup, , document] = await Promise.all([
      context.waitForEvent("page", { timeout: 60_000 }),
      page.waitForResponse(reply => reply.url() === `${preview}/__cms-session` &&
        reply.request().method() === "POST", { timeout: 60_000 }).then(reply => {
        if (reply.status() !== 204) throw new PreviewSmokeFailure("preview_session_failed");
      }),
      context.waitForEvent("response", { timeout: 60_000, predicate: reply => {
        const url = new URL(reply.url());
        return url.origin === preview && previewPath.test(url.pathname) &&
          reply.request().isNavigationRequest() && reply.request().resourceType() === "document";
      }}).then(reply => {
        if (reply.status() !== 200) throw new PreviewSmokeFailure("preview_document_failed");
        return reply;
      }),
      button.click(),
    ]);
    phase = "preview_heading_missing";
    if (document.frame() !== popup.mainFrame()) throw new Error();
    await popup.waitForURL(url => url.href === document.url(), { timeout: 15_000 });
    await popup.getByRole("heading", { name: heading, exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    return { ok: true, code: "signed_in_private_preview" };
  } catch (error) {
    return { ok: false, code: error instanceof PreviewSmokeFailure ? error.message : phase };
  }
}

async function main() {
  let browser;
  let result = { ok: false, code: "preview_smoke_configuration_invalid" };
  try {
    const [environment, mode] = process.argv.slice(2);
    if (process.env.DEBUG || process.env.PWDEBUG || process.env.NODE_OPTIONS ||
        process.argv.length > 4 || (mode !== undefined && mode !== "--check-config")) throw new Error();
    const settings = previewSmokeSettings(environment, process.env);
    delete process.env.CMS_PREVIEW_SMOKE_CREDENTIAL;
    if (mode === "--check-config") {
      result = { ok: true, code: "preview_smoke_configuration_ready" };
    } else {
      result = { ok: false, code: "browser_unavailable" };
      const { chromium } = createRequire(import.meta.url)("@playwright/test");
      browser = await launchCmsBrowser(chromium);
      result = await checkSignedInPreview(browser, settings);
    }
  } catch { /* Browser errors and settings never enter the smoke receipt. */ }
  finally { await browser?.close().catch(() => {}); }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
