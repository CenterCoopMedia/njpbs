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

export async function checkSignedInPreview(browser, { admin, preview, credential, editor, heading, access },
  { noteMs = WAIT_NOTE_MS, note = text => console.error(text) } = {}) {
  let phase = "admin_unavailable";
  let popup;
  let watchTab;
  const saw = {};
  const notes = setInterval(() => note(`Still waiting: ${phase}, ${JSON.stringify(saw)}`), noteMs);
  notes.unref();
  try {
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    // Every wait below ends on what the browser, Admin or the preview reports; a long one prints and goes on.
    context.setDefaultTimeout(0);
    for (const [origin, headers] of access) await routePreviewSmokeAccess(context, origin, headers);
    const page = await context.newPage();
    const entry = await (page.goto(`${admin}/`, { waitUntil: "domcontentloaded" }));
    if (entry?.status() !== 200 || new URL(page.url()).origin !== admin) throw new Error();

    phase = "staff_sign_in_failed";
    // The sign-in wait ends on the Account menu, or on the sign-in service's refusal.
    const refusedSignIn = refusal(page, /\/accounts:signInWithPassword$/);
    await (submitCmsSignIn(page, async () => credential, () => Promise.race([refusedSignIn, page
      .getByRole("button", { name: /^Account menu for / }).waitFor({ state: "visible" })])));
    if (new URL(page.url()).origin !== admin) throw new Error();

    phase = "editor_unavailable";
    const editorUrl = `${admin}${editor}`;
    // An editor that cannot load its record says so and has no Preview button.
    const unavailable = page.getByText(editorUnavailable).first().waitFor({ state: "visible" }).then(() => { throw new Error(); });
    unavailable.catch(() => {});
    await (page.goto(editorUrl, { waitUntil: "domcontentloaded" }));
    if (page.url() !== editorUrl) throw new Error();
    const button = page.getByRole("button", { name: "Preview", exact: true });
    await (Promise.race([unavailable, button.waitFor({ state: "visible" })]));
    // The editor shows the button only after its load, with the saved receipt already recorded
    // (EditorWorkspace.tsx), so a button that is disabled when it appears stays disabled.
    if (await (button.isDisabled())) {
      const label = await (page.getByRole("group", { name: /^Preview unavailable: / })
        .evaluateAll(nodes => nodes[0]?.getAttribute("aria-label") ?? null).catch(() => null));
      saw.reason = disabledReasons.get(label?.replace(/^Preview unavailable: /, "")) ?? "unlisted";
      throw new PreviewSmokeFailure("preview_control_disabled");
    }

    phase = "private_preview_unavailable";
    const session = `${preview}/__cms-session`;
    const isSession = request => request.url() === session && request.method() === "POST";
    // The preview wait ends on the preview job, not on a clock. Admin follows the addressed
    // job (an older blocking job can fail before the requested one is made), so its terminal
    // state ends the wait at once: the progress state in the tab, or the error it shows in the
    // editor. A ready job is followed by the document. A failed session request and a closed
    // tab end it too.
    let stop;
    const stopped = new Promise((_, reject) => { stop = code => reject(new PreviewSmokeFailure(code)); });
    stopped.catch(() => {});
    const opened = context.waitForEvent("page");
    opened.catch(() => {});
    page.on("requestfailed", request => {
      if (!isSession(request) || saw.session) return;
      saw.session = { failed: failureName(request.failure()?.errorText) };
      // Admin aborts its own session request after the preview operation fails. It shows the preview
      // error first, so that error wins and this failure stays in the receipt as its consequence.
      void Promise.race([opened.then(readProgress), readCap()]).then(state =>
        stop(previewErrorStates.has(state) ? "preview_admin_stopped" : "preview_session_failed"));
    });
    // The receipt keeps the last job status and error code from Admin's own replies.
    page.on("response", reply => void readJob(reply, saw));
    for (const ended of ["close", "crash"]) page.on(ended, () => stop("preview_admin_stopped"));
    // The popup document's own network failure is its end: no response or terminal state follows it.
    const isDocument = request => {
      const url = new URL(request.url());
      return url.origin === preview && previewPath.test(url.pathname) &&
        request.isNavigationRequest() && request.resourceType() === "document";
    };
    context.on("requestfailed", request => {
      if (!isDocument(request)) return;
      saw.document = { ...saw.document, failed: failureName(request.failure()?.errorText) };
      stop("preview_document_failed");
    });
    page.getByRole("alert").filter({ hasText: editorStop }).first().waitFor({ state: "visible" })
      .then(() => stop("preview_admin_stopped"), () => {});
    const [, , document] = await (Promise.race([stopped, Promise.all([
      opened.then(value => {
        popup = value; saw.popup = true;
        value.on("close", () => stop("preview_tab_closed"));
        value.on("crash", () => stop("preview_tab_closed"));
        watchTab = watchAdminStop(value, () => stop("preview_admin_stopped"));
        return value;
      }),
      page.waitForResponse(reply => isSession(reply.request())).then(reply => {
        saw.session = { status: reply.status() };
        if (reply.status() !== 204) throw new PreviewSmokeFailure("preview_session_failed");
      }),
      context.waitForEvent("response", { predicate: reply => isDocument(reply.request()) }).then(reply => {
        saw.document = { status: reply.status() };
        if (reply.status() !== 200) throw new PreviewSmokeFailure("preview_document_failed");
        return reply;
      }),
      button.click(),
    ])]));
    clearInterval(watchTab);
    phase = "preview_heading_missing";
    if (document.frame() !== popup.mainFrame()) throw new Error();
    await (Promise.race([stopped, popup.waitForURL(url => url.href === document.url(), { waitUntil: "commit" })]));
    // The named heading is the success, whatever else is still loading. A parsed document without it has failed.
    const found = popup.getByRole("heading", { name: heading, exact: true });
    const absent = popup.waitForLoadState("domcontentloaded").then(async () => {
      if (!await popup.getByRole("heading", { name: heading, exact: true, includeHidden: true }).count()) throw new Error();
      return new Promise(() => {});
    });
    absent.catch(() => {});
    await (Promise.race([stopped, found.first().waitFor({ state: "visible" }), absent]));
    return { ok: true, code: "signed_in_private_preview" };
  } catch (error) {
    const code = error instanceof PreviewSmokeFailure ? error.message : phase;
    if (phase !== "private_preview_unavailable" && phase !== "preview_heading_missing") {
      return { ok: false, code, ...(saw.reason ? { reason: saw.reason } : {}) };
    }
    return { ok: false, code, missing: ["popup", "session", "document"].filter(key => !saw[key]),
      session: saw.session ?? null, job: saw.job ?? null, document: saw.document ?? null,
      popup: await describePopup(popup, { admin, preview }) };
  } finally {
    clearInterval(watchTab);
    clearInterval(notes);
  }
}

// The wait ends when a listed request is refused or fails; its absence leaves the next state to end it.
function refusal(page, path) {
  const matches = request => request.method() === "POST" && path.test(new URL(request.url()).pathname);
  const refused = new Promise((_, reject) => {
    page.on("response", reply => { if (reply.status() >= 400 && matches(reply.request())) reject(new Error("refused")); });
    page.on("requestfailed", request => { if (matches(request)) reject(new Error("refused")); });
  });
  refused.catch(() => {});
  return refused;
}

// A wait never fails on time: it prints what it waits for and goes on.
export const WAIT_NOTE_MS = 60_000;
// The errors that the editor shows when its record cannot load (ContentTab.tsx, EditorWorkspace.tsx).
const editorUnavailable = /(?:do not have permission to edit this (?:page|record)\.|This page is no longer available\.|The (?:page|record) could not be loaded\. Reload to try again\.|Deleted records cannot be edited here\.)/;
// The reasons the editor gives for a disabled Preview button (EditorWorkspace.tsx), as receipt codes.
const disabledReasons = new Map([
  ["Wait for a saved page to load before previewing.", "page_not_saved"],
  ["Wait for a saved record to load before previewing.", "record_not_saved"],
  ["Your access does not allow saving these changes for preview.", "save_not_allowed"],
  ["Finish or cancel the media changes before previewing.", "media_changes_open"],
]);
// The errors that Admin's Preview action shows in the editor when it stops (SavedPreview.tsx).
const editorStop = /(?:Allow pop-ups for this CMS|Preview could not open\.|Preview is temporarily unavailable\.|The preview service is updating\.|Previews are refreshing after a recent publish\.|Private preview access is taking longer)/;
const jobStatuses = new Set(["pending", "building", "ready", "failed", "expired"]);

// The server's fixed failure texts and typed codes, as receipt codes. Any other text is "unlisted".
const jobErrors = new Map([
  ["Preview build did not finish within 45 minutes", "preview_build_timeout"],
  ["Preview build failed. Try again or contact an administrator.", "preview_build_failed"],
  ["Preview build failed", "preview_build_failed"],
  ["Previews are refreshing after a recent publish. Try again in a minute.", "preview_context_refreshing"],
]);
const replyCodes = new Set(["preview-renderer-updating", "preview-version-unavailable"]);

// A preview reply comes from the function, or from the installed reader with the endpoint named in its request.
function isPreviewReply(request, url) {
  if (request.method() !== "POST") return false;
  if (/\/cmsPreview(?:Status)?$/.test(url.pathname)) return true;
  if (!/^\/api\/cms\/v[12]\/reader$/.test(url.pathname)) return false;
  const body = JSON.parse(request.postData() ?? "null");
  return body?.action === "request" && ["cmsPreview", "cmsPreviewStatus"].includes(body.endpoint);
}

// Record the last job status and error code from Admin's preview replies.
async function readJob(reply, saw) {
  try {
    if (!isPreviewReply(reply.request(), new URL(reply.url()))) return;
    const body = await reply.json().catch(() => null);
    if (reply.status() < 200 || reply.status() > 299) {
      saw.job = { ...saw.job, http: reply.status(), ...(replyCodes.has(body?.code) ? { code: body.code } : {}) };
      return;
    }
    if (!jobStatuses.has(body?.status)) return;
    const error = body.failureReason === "preview_context_refreshing" ? body.failureReason
      : body.error ? jobErrors.get(body.error) ?? "unlisted" : undefined;
    saw.job = { status: body.status, ...(error ? { error } : {}) };
  } catch { /* A reply without a readable job leaves the last status in place. */ }
}

// Reads the progress state now. A build without data-progress still writes data-state, with failures folded into "error".
const readProgress = tab => tab.locator("main.cms-preview-progress").evaluateAll(nodes =>
  nodes[0]?.getAttribute("data-progress") ?? nodes[0]?.getAttribute("data-state") ?? null).catch(() => null);

// Caps a progress read of a page that does not answer; diagnostic reads only.
const readCap = () => new Promise(resolve => setTimeout(resolve, 1_000, null).unref());

// Admin's terminal progress states mean it stopped without opening the preview.
function watchAdminStop(tab, onStop) {
  const timer = setInterval(() => void readProgress(tab).then(state => {
    if (settledStates.has(state)) { clearInterval(timer); onStop(); }
  }), 1_000);
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
// The preview operation's own errors; session-slow reports the session request.
const previewErrorStates = new Set(["refresh-failed", "error", "updating"]);

// A fast session failure can arrive before Admin moves the tab, so give it up to 5 s to settle.
// Coordinator ruling (Nov. 24, 2026): the tab can still show an earlier state after a refused
// session when the job takes longer than 5 s; the session status already names that cause.
async function describePopup(popup, origins) {
  if (!popup) return null;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const where = place(popup.url(), origins);
    const state = where !== "about:blank" ? null : await Promise.race([readProgress(popup), readCap()]);
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
