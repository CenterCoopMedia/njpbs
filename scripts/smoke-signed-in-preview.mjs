import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { launchCmsBrowser, parseBrowserCredential, submitCmsSignIn } from "./cms-debug-browser.mjs";
import { developmentInstallAccess } from "./lib/development-install-credentials.mjs";
import { developmentValues } from "./render-development-config.mjs";

const production = { admin: "https://admin.njpbs.org", preview: "https://preview.njpbs.org" };
const editorPath = /^\/content\/(?:pages|post)\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/edit$/;
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
    } catch (error) {
      await route.abort(abortCode(error)).catch(() => {});
    } finally {
      await response?.dispose().catch(() => {});
    }
  });
}

// Keep the upstream failure class so the browser's requestfailed names it.
export function abortCode(error) {
  const text = String(error?.message ?? "");
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return "namenotresolved";
  if (/ECONNREFUSED/.test(text)) return "connectionrefused";
  if (/ECONNRESET|socket hang up/.test(text)) return "connectionreset";
  if (/EHOSTUNREACH|ENETUNREACH/.test(text)) return "addressunreachable";
  if (/ETIMEDOUT|Timeout \d+ms exceeded/.test(text)) return "timedout";
  return "failed";
}

class PreviewSmokeFailure extends Error {}

export async function checkSignedInPreview(browser, { admin, preview, credential, editor, heading, access }) {
  let phase = "admin_unavailable";
  let popup;
  let watchTab;
  const saw = {};
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
    const session = `${preview}/__cms-session`;
    const isSession = request => request.url() === session && request.method() === "POST";
    page.on("requestfailed", request => {
      if (isSession(request) && !saw.session) saw.session = { failed: failureName(request.failure()?.errorText) };
    });
    // The document wait ends on the preview job, not on a clock: a failed or expired job
    // (from Admin's own cmsPreview/cmsPreviewStatus replies) or Admin stopping in the tab
    // ends it at once, and a ready job is followed by the document.
    let stop;
    const stopped = new Promise((_, reject) => { stop = reject; });
    page.on("response", reply => void readJob(reply, saw).then(ended => {
      if (ended) stop(new PreviewSmokeFailure("preview_job_failed"));
    }));
    // The tab opens inside the click and Admin bounds the session request at 30 s,
    // so these 60 s waits end on Admin's own outcome for a working system.
    const [, , document] = await Promise.all([
      context.waitForEvent("page", { timeout: 60_000 }).then(value => {
        popup = value; saw.popup = true;
        watchTab = watchAdminStop(value, () => stop(new PreviewSmokeFailure("preview_admin_stopped")));
        return value;
      }),
      page.waitForResponse(reply => isSession(reply.request()), { timeout: 60_000 }).then(reply => {
        saw.session = { status: reply.status() };
        if (reply.status() !== 204) throw new PreviewSmokeFailure("preview_session_failed");
      }),
      Promise.race([stopped, context.waitForEvent("response", { timeout: DOCUMENT_HANG_BACKSTOP_MS, predicate: reply => {
        const url = new URL(reply.url());
        return url.origin === preview && previewPath.test(url.pathname) &&
          reply.request().isNavigationRequest() && reply.request().resourceType() === "document";
      }}).then(reply => {
        saw.document = { status: reply.status() };
        if (reply.status() !== 200) throw new PreviewSmokeFailure("preview_document_failed");
        return reply;
      })]),
      button.click(),
    ]);
    phase = "preview_heading_missing";
    if (document.frame() !== popup.mainFrame()) throw new Error();
    await popup.waitForURL(url => url.href === document.url(), { timeout: 15_000 });
    await popup.getByRole("heading", { name: heading, exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
    return { ok: true, code: "signed_in_private_preview" };
  } catch (error) {
    const code = error instanceof PreviewSmokeFailure ? error.message : phase;
    if (phase !== "private_preview_unavailable" && phase !== "preview_heading_missing") return { ok: false, code };
    return { ok: false, code, missing: ["popup", "session", "document"].filter(key => !saw[key]),
      session: saw.session ?? null, job: saw.job ?? null, document: saw.document ?? null,
      popup: await describePopup(popup, { admin, preview }) };
  } finally {
    clearInterval(watchTab);
  }
}

// Hang backstop only. Measured on dev, Nov. 24, 2026: with an idle container on a cached
// image the document arrived 30 s after the click (session +3 s, job accepted +6 s,
// building +21 s). In run 45436441069 the first job after the renderer image rollout
// (7 min 38 s after rollout, container idle) did not reach the document within 60 s.
// The server's own build limit, PREVIEW_BUILD_TIMEOUT_MS, is 45 min, which is longer
// than this step's 4 min; 180 s fits the step after sign-in (13 s) and the heading (15 s).
const DOCUMENT_HANG_BACKSTOP_MS = 180_000;
const jobStatuses = new Set(["pending", "building", "ready", "failed", "expired"]);

// Record the addressed job's status from Admin's preview replies; true when it ended without a preview.
async function readJob(reply, saw) {
  try {
    const request = reply.request();
    if (request.method() !== "POST" || !/\/cmsPreview(?:Status)?$/.test(new URL(reply.url()).pathname)) return false;
    if (reply.status() < 200 || reply.status() > 299) {
      saw.job = { ...saw.job, http: reply.status() };
      return false;
    }
    const body = await reply.json();
    if (!jobStatuses.has(body?.status)) return false;
    const error = typeof body.error === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(body.error) ? body.error
      : body.error ? "unlisted" : undefined;
    saw.job = { status: body.status, ...(error ? { error } : {}) };
    return body.status === "failed" || body.status === "expired";
  } catch { return false; }
}

// Admin's terminal progress states mean it stopped without opening the preview.
function watchAdminStop(tab, onStop) {
  const timer = setInterval(() => {
    void tab.locator("main.cms-preview-progress").first().getAttribute("data-progress", { timeout: 500 })
      .then(state => { if (settledStates.has(state)) { clearInterval(timer); onStop(); } }, () => {});
  }, 1_000);
  return timer;
}

// Receipts carry statuses, fixed place names and Admin progress state names only:
// never configured hosts, paths, bodies or page text.
function place(value, { admin, preview }) {
  try {
    const url = new URL(value);
    if (url.href === "about:blank") return "about:blank";
    if (url.origin === admin) return "admin";
    if (url.origin === preview) return "preview";
  } catch { /* An unreadable address is reported as other. */ }
  return "other";
}

function failureName(text) {
  return typeof text === "string" && /^net::ERR_[A-Z0-9_]{1,60}$/.test(text) ? text : "failed";
}

// Admin writes its preview state on the progress page it opens before navigation.
const progressStates = new Set(["preparing", "requesting", "waiting", "pending", "building", "refreshing",
  "refresh-failed", "opening", "error", "session-slow", "updating"]);
const settledStates = new Set(["refresh-failed", "error", "session-slow", "updating"]);

// A fast session failure can arrive before Admin moves the tab, so give it up to 5 s to settle.
async function describePopup(popup, origins) {
  if (!popup) return null;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const where = place(popup.url(), origins);
    const state = where !== "about:blank" ? null : await popup.locator("main.cms-preview-progress").first()
      .getAttribute("data-progress", { timeout: 1_000 }).catch(() => null);
    const progress = progressStates.has(state) ? state : null;
    if (where !== "about:blank" || settledStates.has(progress) || Date.now() >= deadline) return { place: where, progress };
    await new Promise(resolve => setTimeout(resolve, 250));
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
