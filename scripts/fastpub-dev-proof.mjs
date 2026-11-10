#!/usr/bin/env node
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import { deploymentEmail } from "./lib/deployment-settings.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ADMIN_ORIGIN,
  PUBLIC_ORIGIN,
  openDevEditor,
  openCredentialPipe,
} from "./lib/dev-editor-browser.mjs";
import { openDevAdmission } from "./lib/dev-proof-admission.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const {
  projectNoBuildFamilyAdmission,
} = require("../functions/lib/no-build-family-admission.js");
const { publicationTarget } = require("../functions/lib/publication-target.js");
const { principalFromUserDoc } = require("../functions/lib/principal.js");
const { can } = require("../functions/lib/rbac.js");
const OPERATION = /^[A-Za-z0-9]{20}$/;
const POST_ID = /^(?:[a-f0-9]{32}|[A-Za-z0-9]{20})$/;
const SHA = /^[a-f0-9]{64}$/;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const escaped = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function parseOptions(args) {
  const options = { publish: false, output: resolve("fastpub-dev-proof") };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--publish") {
      options.publish = true;
      continue;
    }
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (
      flag !== "--output" ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    ) {
      throw new Error("invalid_arguments");
    }
    options[flag.slice(2)] = args[++index];
  }
  if (options.publish && options.dryRun) throw new Error("invalid_arguments");
  return options;
}

export function assertDevUrl(value) {
  const url = new URL(value);
  if (
    url.origin !== PUBLIC_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname)
  )
    throw new Error("dev_target_required");
  return url.href;
}

export function publicReceiptEvidence(
  response,
  { operationId, sourceVersion, withdrawn, texts },
) {
  const headers = response.headers;
  if (
    !OPERATION.test(operationId) ||
    headers.get("x-njpbs-content-source") !== "cms-no-build" ||
    headers.get("x-njpbs-publication-operation") !== operationId ||
    Number(headers.get("x-njpbs-source-version")) !== sourceVersion ||
    !/^[a-f0-9]{40}$/.test(headers.get("x-njpbs-renderer-sha") ?? "") ||
    !SHA.test(headers.get("x-njpbs-context-sha256") ?? "")
  )
    return false;
  if (withdrawn) return response.status === 410;
  if (
    response.status !== 200 ||
    !SHA.test(headers.get("x-njpbs-input-sha256") ?? "") ||
    headers.get("x-njpbs-html-sha256") !==
      createHash("sha256").update(response.body).digest("hex")
  )
    return false;
  return texts.every((text) => response.body.includes(escaped(text)));
}

export function publicEvidence(response, expected) {
  return (
    publicReceiptEvidence(response, expected) &&
    (expected.withdrawn || response.renderedVisible === true)
  );
}

export function assertOrdinaryEditor(uid, profile) {
  if (
    !profile ||
    profile.active === false ||
    profile.role != null ||
    profile.email?.toLowerCase() !== deploymentEmail("CMS_DEV_EDITOR_EMAIL") ||
    !Array.isArray(profile.grants) ||
    !profile.grants.length ||
    profile.grants.some((grant) => grant?.role !== "editor")
  ) {
    throw new Error("ordinary_editor_required");
  }
  const principal = principalFromUserDoc(uid, profile);
  const resource = { section: "news", ownerId: uid, type: "post" };
  if (
    [
      "content.create",
      "content.edit.any",
      "content.publish",
      "content.unpublish",
    ].some((capability) => !can(principal, capability, resource))
  ) {
    throw new Error("ordinary_editor_required");
  }
  return { role: "editor", section: "news" };
}

// Mirrors the wire contract in functions/save.js recordIdForCreateAttempt.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function createAttemptId(request, title) {
  if (
    request?.collection !== "cmsPosts" ||
    request.id !== undefined ||
    request.document?.title !== title ||
    typeof request.idempotencyKey !== "string" ||
    !request.idempotencyKey ||
    request.postSource ||
    request.postTemplate
  ) {
    throw new Error("create_request_required");
  }
  const input = `cmsPosts:create:${request.idempotencyKey}:${request.section ?? ""}:${canonicalJson(request.document)}${request.slug === undefined ? "" : `:slug:${request.slug}`}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export function proofPass(publicResult, cmsSeconds, noFullBuild) {
  return (
    publicResult.pass &&
    Number.isFinite(cmsSeconds) &&
    cmsSeconds <= 20 &&
    noFullBuild
  );
}

// Only the network and clock are replaceable. Tests use real HTTP serialization.
export async function pollPublic({
  url,
  expected,
  startedAt,
  fetchResponse,
  now = Date.now,
  wait = sleep,
}) {
  assertDevUrl(url);
  const deadline = startedAt + 60_000;
  while (now() <= deadline) {
    try {
      const response = await fetchResponse(
        url,
        Math.max(1, Math.min(5_000, deadline - now())),
      );
      if (publicEvidence(response, expected)) {
        return {
          pass: now() - startedAt <= 20_000,
          seconds: (now() - startedAt) / 1000,
          saveToLiveSeconds: (now() - startedAt) / 1000,
          publicStatus: response.status,
        };
      }
    } catch {
      /* A transient refused or unavailable public read is not confirmation. */
    }
    if (now() >= deadline) break;
    await wait(Math.min(1000, deadline - now()));
  }
  return {
    pass: false,
    seconds: null,
    saveToLiveSeconds: null,
    publicStatus: null,
  };
}

export function assertNoBuild(before, after) {
  if (
    before.buildBatchId !== after.buildBatchId ||
    before.generation !== after.generation ||
    after.runAttempts.some((attempt) => !before.runAttempts.includes(attempt))
  )
    throw new Error("full_build_observed");
}

export function assertFamilyAdmission(value) {
  const admission = projectNoBuildFamilyAdmission(value, process.env, publicationTarget("development"));
  if (
    value?.schemaVersion !== 2 ||
    !admission.valid ||
    !admission.enabled ||
    admission.families.posts?.mode !== "all"
  ) {
    throw new Error("dev_family_admission_required");
  }
  return admission.admissionRevision;
}

export function markdownReceipt(receipt) {
  const rows = receipt.steps.map(
    (step) =>
      `| ${step.step} | ${step.seconds ?? "-"} | ${step.receiptId ?? "-"} | ${step.pass ? "Pass" : "Fail"} |`,
  );
  return (
    `# Dev fast publication proof\n\nMode: ${receipt.mode}. Result: ${receipt.result}.\n\n` +
    "| Step | Seconds | Receipt id | Pass/fail |\n| --- | ---: | --- | --- |\n" +
    rows.join("\n") +
    "\n"
  );
}

async function ghRead(path) {
  const { stdout } = await run(
    "gh",
    ["api", `repos/${repositoryIdentity().repository}/${path}`],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function publishEnabled(admission) {
  const flag = await ghRead("actions/variables/CMS_DEV_PUBLISH_ENABLED");
  if (flag.value !== "true") throw new Error("dev_publication_held");
  if (admission) assertFamilyAdmission(await admission.read());
}

async function buildState(context) {
  const response = await context.request.get(
    `${PUBLIC_ORIGIN}/_publication.json?cms-context=code`,
    {
      maxRedirects: 0,
      timeout: 10_000,
    },
  );
  if (response.status() !== 200) throw new Error("dev_receipt_unavailable");
  const receipt = await response.json();
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.buildBatchId ?? "") ||
    !Number.isSafeInteger(receipt.generation)
  )
    throw new Error("dev_receipt_unavailable");
  const runs = await ghRead(
    "actions/workflows/cms-dev-publish.yml/runs?per_page=100",
  );
  if (
    !Array.isArray(runs.workflow_runs) ||
    runs.workflow_runs.some(
      (item) =>
        !Number.isSafeInteger(item.id) ||
        !Number.isSafeInteger(item.run_attempt),
    )
  )
    throw new Error("build_audit_unavailable");
  return {
    buildBatchId: receipt.buildBatchId,
    generation: receipt.generation,
    runAttempts: runs.workflow_runs.map(
      (item) => `${item.id}:${item.run_attempt}`,
    ),
  };
}

async function click(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
}

async function lifecycle(page, name, confirmation) {
  const control = page.getByRole("button", { name, exact: true });
  if (!(await control.isVisible())) {
    const menu = name === "Publish" ? "Publishing" : "Post actions";
    await page.getByRole("button", { name: menu, exact: true }).click();
  }
  await control.click();
  // Publish executes directly. Removal actions have a confirmation panel.
  if (confirmation) await click(page, confirmation);
}

function responseFor(page, endpoint) {
  const pending = page
    .waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith(`/${endpoint}`) &&
        response.request().method() === "POST"
      );
    })
    .then(async (response) => {
      if (!response.ok()) throw new Error("cms_action_failed");
      return response.json();
    })
    .catch(() => {
      throw new Error("cms_action_failed");
    });
  // A failed click must not leave an unhandled Playwright rejection with a URL.
  void pending.catch(() => {});
  return pending;
}

export function savedPost(result, title, id, receipt = {}) {
  // Capture a successful create before validating its remaining response fields.
  // A malformed version must still leave an exact cleanup target in the receipt.
  if (
    !id &&
    result.created === true &&
    result.collection === "cmsPosts" &&
    POST_ID.test(result.id ?? "")
  ) {
    receipt.postId = result.id;
    receipt.cleanup = "pending";
  }
  const document = result.document;
  if (
    result.collection !== "cmsPosts" ||
    !POST_ID.test(result.id ?? "") ||
    document?.title !== title ||
    (!id && result.created !== true) ||
    (id && result.id !== id) ||
    !Number.isSafeInteger(document.version)
  ) {
    throw new Error("owned_post_receipt_required");
  }
  return { id: result.id, version: document.version, document };
}

async function savePost(page, receipt, admission, title, id) {
  await publishEnabled(admission);
  const response = responseFor(page, "cmsSaveContent");
  const request = !id
    ? page
        .waitForRequest(
          (request) =>
            new URL(request.url()).pathname.endsWith("/cmsSaveContent") &&
            request.method() === "POST",
        )
        .then((request) => {
          receipt.postId = createAttemptId(request.postDataJSON(), title);
          receipt.cleanup = "pending-create";
        })
    : Promise.resolve();
  void request.catch(() => {});
  const startedAt = Date.now();
  await click(page, "Save draft");
  await request;
  const result = await response;
  return { ...savedPost(result, title, id, receipt), startedAt };
}

async function prepareFixture(page, fixture) {
  await page.getByRole("link", { name: "New post", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Post title", exact: true })
    .fill(fixture.title);
  await page
    .getByRole("textbox", { name: "Summary", exact: true })
    .fill(fixture.summary);
  const section = page.getByRole("combobox", { name: "Area", exact: true });
  if (await section.count()) await section.selectOption({ label: "News" });
  // The original pilot excludes registered credits. Exercise the minimal path first.
  const byline = page.getByRole("list", {
    name: "Byline, in order",
    exact: true,
  });
  for (const button of await byline
    .getByRole("button", { name: /^Remove .* from the byline$/ })
    .all())
    await button.click();
  await page
    .getByRole("textbox", { name: "Add a custom credit", exact: true })
    .fill(fixture.byline);
  await click(page, "Add custom credit");
  await page
    .getByRole("textbox", { name: "Body", exact: true })
    .fill(fixture.body);
}

export function publicationOperation(result, transition = false) {
  const publication = result.publication ?? result;
  if (
    publication.transport !== "post-no-build-v1" ||
    !OPERATION.test(publication.queueId ?? "") ||
    (transition
      ? publication.status !== "queued"
      : publication.dispatched !== false)
  )
    throw new Error("no_build_transport_required");
  const sourceVersion = result.document?.published?.sourceVersion;
  const workingVersion = result.document?.version;
  const editorialVersion = result.document?.published?.contentVersion;
  if (
    !Number.isSafeInteger(sourceVersion) ||
    sourceVersion < 1 ||
    !Number.isSafeInteger(editorialVersion) ||
    editorialVersion < 1 ||
    !Number.isSafeInteger(workingVersion) ||
    workingVersion < 1
  )
    throw new Error("publication_version_required");
  return {
    operationId: publication.queueId,
    sourceVersion,
    editorialVersion,
    workingVersion,
  };
}

export function cmsPublicationEvidence(metadata, expected) {
  if (
    metadata?.publishedSourceVersion !== expected.sourceVersion ||
    metadata.publishedContentVersion !== expected.editorialVersion ||
    (expected.workingVersion !== undefined &&
      !(metadata.workingVersion >= expected.workingVersion))
  )
    return false;
  return expected.withdrawn
    ? metadata.publiclyVisible === false &&
        metadata.publicSourceVersion === null
    : metadata.publiclyVisible === true &&
        metadata.publicSourceVersion === expected.sourceVersion;
}

function watchCmsPublication(page, postId) {
  let latest = null;
  page.on("response", async (response) => {
    try {
      if (
        !new URL(response.url()).pathname.endsWith("/cmsGetContent") ||
        !response.ok()
      )
        return;
      const request = response.request().postDataJSON();
      if (
        request?.collection !== "cmsPosts" ||
        request.id !== postId ||
        request.publicationOnly !== true
      )
        return;
      latest = (await response.json()).publication ?? null;
    } catch {
      /* Never report network payloads or Playwright exceptions. */
    }
  });
  return { read: () => latest };
}

async function readPublic(
  context,
  url,
  timeout,
  expected,
  publicPage,
  adminPage,
) {
  const response = await context.request.get(url, { maxRedirects: 0, timeout });
  const result = {
    status: response.status(),
    headers: new Headers(response.headers()),
    body: await response.text(),
    renderedVisible: false,
  };
  if (expected.withdrawn || !publicReceiptEvidence(result, expected))
    return result;
  try {
    const navigation = await publicPage.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    if (
      !navigation ||
      new URL(publicPage.url()).origin !== PUBLIC_ORIGIN ||
      !publicReceiptEvidence(
        {
          status: navigation.status(),
          headers: new Headers(navigation.headers()),
          body: await navigation.text(),
        },
        expected,
      )
    )
      return result;
    const fixture = expected.visible;
    const heading = publicPage.getByRole("heading", {
      name: fixture.title,
      level: 1,
      exact: true,
    });
    const article = publicPage.getByRole("article").filter({ has: heading });
    const byline = article.locator(".post-byline__credits");
    result.renderedVisible =
      (await heading.isVisible()) &&
      (await article.getByText(fixture.body, { exact: true }).isVisible()) &&
      (await article.getByText(fixture.summary, { exact: true }).isVisible()) &&
      (await byline.isVisible()) &&
      (await byline.textContent()).replace(/\s+/g, " ").trim() ===
        `By ${fixture.byline}`;
  } finally {
    await adminPage.bringToFront();
  }
  return result;
}

async function measureStep({
  page,
  context,
  receipt,
  step,
  expected,
  startedAt,
  cmsStatus,
  publicPage,
}) {
  const cmsConfirmation = (async () => {
    const status = page.getByText(
      expected.withdrawn
        ? "Not live"
        : `Version ${expected.editorialVersion} live`,
      { exact: true },
    );
    const deadline = startedAt + 60_000;
    while (Date.now() <= deadline) {
      if (
        cmsPublicationEvidence(cmsStatus.read(), expected) &&
        (await status.isVisible())
      )
        return (Date.now() - startedAt) / 1000;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(1000, deadline - Date.now()));
    }
    return null;
  })();
  void cmsConfirmation.catch(() => {});
  const [result, cmsSeconds] = await Promise.all([
    pollPublic({
      url: receipt.publicUrl,
      expected,
      startedAt,
      fetchResponse: (url, timeout) =>
        readPublic(context, url, timeout, expected, publicPage, page),
    }),
    cmsConfirmation,
  ]);
  const cmsConfirmed = cmsSeconds !== null;
  const after = await buildState(context);
  let noFullBuild = true;
  try {
    assertNoBuild(receipt.buildBefore, after);
  } catch {
    noFullBuild = false;
  }
  receipt.steps.push({
    step,
    ...result,
    publicSeconds: result.seconds,
    cmsSeconds,
    seconds:
      cmsSeconds == null || result.seconds == null
        ? null
        : Math.max(cmsSeconds, result.seconds),
    receiptId: expected.operationId,
    sourceVersion: expected.sourceVersion,
    editorialVersion: expected.editorialVersion,
    workingVersion: expected.workingVersion,
    cmsConfirmed,
    noFullBuild,
    pass: proofPass(result, cmsSeconds, noFullBuild),
  });
  if (!noFullBuild) throw new Error("full_build_observed");
  if (!proofPass(result, cmsSeconds, noFullBuild))
    throw new Error("publication_proof_failed");
}

async function cleanup(
  page,
  context,
  admission,
  post,
  title,
  publicUrl,
  withdrawal,
) {
  const cmsStatus = watchCmsPublication(page, post.id);
  await page.goto(`${ADMIN_ORIGIN}/content/post/${post.id}/edit`, {
    waitUntil: "domcontentloaded",
  });
  if (
    (await page
      .getByRole("textbox", { name: "Post title", exact: true })
      .inputValue()) !== title
  )
    throw new Error("cleanup_ownership_mismatch");
  // The normal Editor cannot delete. Confirm withdrawal and retain the owned
  // draft ID for the coordinator's later recycle-bin removal.
  const deadline = Date.now() + 60_000;
  while (!cmsStatus.read() && Date.now() < deadline) await sleep(1000);
  const current = cmsStatus.read();
  if (!current) throw new Error("cleanup_unconfirmed");
  if (!current.publishedSourceVersion)
    return { state: "draft-retained", status: null };
  let expected = {
    sourceVersion: current.publishedSourceVersion,
    editorialVersion: current.publishedContentVersion,
    workingVersion: current.workingVersion,
    operationId: withdrawal?.operationId ?? current.publicBuildQueueId,
    withdrawn: true,
  };
  if (current.publiclyVisible) {
    await publishEnabled(admission);
    const response = responseFor(page, "cmsTransitionContent");
    await lifecycle(page, "Unpublish", "Confirm unpublish");
    expected = {
      ...publicationOperation(await response, true),
      withdrawn: true,
    };
  }
  if (!OPERATION.test(expected.operationId ?? ""))
    throw new Error("cleanup_unconfirmed");
  const url = assertDevUrl(publicUrl);
  while (Date.now() < deadline) {
    let result;
    try {
      result = await readPublic(
        context,
        url,
        Math.max(1, Math.min(5000, deadline - Date.now())),
        expected,
      );
    } catch {
      await sleep(Math.max(0, Math.min(1000, deadline - Date.now())));
      continue;
    }

    const metadata = cmsStatus.read();
    const settled =
      metadata?.publicUpdatePending === false &&
      (metadata.queueStatus === "success" ||
        (!metadata.queueStatus && !metadata.publicBuildQueueId));
    if (
      publicEvidence(result, expected) &&
      cmsPublicationEvidence(metadata, expected) &&
      settled
    ) {
      return {
        state: "withdrawn-draft-retained",
        status: 410,
        receiptId: expected.operationId,
      };
    }
    await sleep(1000);
  }
  throw new Error("cleanup_unconfirmed");
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (process.env.DEBUG || process.env.PWDEBUG)
    throw new Error("debug_logging_not_allowed");
  const receipt = {
    schemaVersion: 1,
    mode: options.publish ? "publish" : "dry-run",
    role: null,
    adminOrigin: ADMIN_ORIGIN,
    publicOrigin: PUBLIC_ORIGIN,
    startedAt: new Date().toISOString(),
    result: "fail",
    steps: [],
    cleanup: "not-needed",
  };
  let session;
  let admission;
  let post;
  let credentialStream;
  let operatorStream;
  const title = `Fast publish proof ${receipt.startedAt}`;
  const fixture = {
    title,
    summary: `Proof summary ${receipt.startedAt}`,
    body: `Proof body ${receipt.startedAt}`,
    byline: "Dev proof",
  };
  try {
    // Reserve both inherited streams before any network client can reuse their FDs.
    credentialStream = openCredentialPipe(3);
    if (options.publish) operatorStream = openCredentialPipe(4);
    await mkdir(options.output, { recursive: true });
    if (options.publish) {
      await publishEnabled();
      admission = await openDevAdmission(operatorStream);
      receipt.admissionRevision = assertFamilyAdmission(await admission.read());
    }
    const require = createRequire(
      new URL("../admin/package.json", import.meta.url),
    );
    const { chromium } = require("@playwright/test");
    session = await openDevEditor({
      chromium,
      credentialStream,
      dryRun: !options.publish,
      onStage: async (stage) => {
        receipt.stage = stage;
        await writeFile(
          join(options.output, "receipt.json"),
          `${JSON.stringify(receipt, null, 2)}\n`,
          { mode: 0o600 },
        );
      },
    });
    const { page, context, publicPage } = session;
    if (options.publish) {
      receipt.editor = assertOrdinaryEditor(
        session.authUid,
        await admission.readEditor(session.authUid),
      );
      receipt.role = receipt.editor.role;
    }
    await page.getByRole("link", { name: "Posts", exact: true }).click();
    await page.getByRole("link", { name: "New post", exact: true }).waitFor();
    receipt.steps.push({
      step: "editor-login-and-posts",
      seconds: null,
      receiptId: null,
      pass: true,
    });
    receipt.buildBefore = await buildState(context);
    if (!options.publish) {
      receipt.result = "pass";
      return receipt;
    }
    await prepareFixture(page, fixture);
    post = await savePost(page, receipt, admission, title);
    receipt.postId = post.id;
    receipt.publicUrl = assertDevUrl(
      `${PUBLIC_ORIGIN}/posts/${post.document.slug}/`,
    );
    receipt.cleanup = "pending";
    const cmsStatus = watchCmsPublication(page, post.id);
    const publishResponse = responseFor(page, "cmsSaveContent");
    // The measured save-and-publish action was gated before its Save click.
    await lifecycle(page, "Publish");
    await measureStep({
      page,
      context,
      receipt,
      step: "publish",
      expected: {
        texts: [fixture.title, fixture.body, fixture.summary, fixture.byline],
        visible: fixture,
        ...publicationOperation(await publishResponse),
      },
      startedAt: post.startedAt,
      cmsStatus,
      publicPage,
    });

    const editText = `Proof edited summary ${receipt.startedAt}`;
    await page
      .getByRole("textbox", { name: "Summary", exact: true })
      .fill(editText);
    post = await savePost(page, receipt, admission, title, post.id);
    const editResponse = responseFor(page, "cmsSaveContent");
    await lifecycle(page, "Publish");
    await measureStep({
      page,
      context,
      receipt,
      step: "edit",
      expected: {
        texts: [fixture.title, fixture.body, editText, fixture.byline],
        visible: { ...fixture, summary: editText },
        ...publicationOperation(await editResponse),
      },
      startedAt: post.startedAt,
      cmsStatus,
      publicPage,
    });

    await publishEnabled(admission);
    const withdrawal = responseFor(page, "cmsTransitionContent");
    const startedAt = Date.now();
    await lifecycle(page, "Unpublish", "Confirm unpublish");
    receipt.withdrawal = publicationOperation(await withdrawal, true);
    await measureStep({
      page,
      context,
      receipt,
      step: "withdraw",
      expected: {
        ...receipt.withdrawal,
        withdrawn: true,
      },
      startedAt,
      cmsStatus,
      publicPage,
    });
    receipt.result = "pass";
  } catch (error) {
    // Never persist browser exceptions, page snapshots, API bodies or login URLs.
    const codes = [
      "dev_publication_held",
      "full_build_observed",
      "no_build_transport_required",
      "publication_proof_failed",
      "dev_editor_login_failed",
      "browser_version_below_156.0.8078.73",
      "browser_sandbox_required",
      "browser_safety_check_failed",
      "dev_family_admission_required",
      "dev_operator_credential_required",
      "dev_admission_read_failed",
      "credential_pipe_required",
      "ordinary_editor_required",
      "dev_editor_profile_read_failed",
      "create_request_required",
    ];
    receipt.error = codes.includes(error.message)
      ? error.message
      : "proof_failed";
  } finally {
    if (receipt.postId && session) {
      try {
        const removed = await cleanup(
          session.page,
          session.context,
          admission,
          { id: receipt.postId },
          title,
          receipt.publicUrl,
          receipt.withdrawal,
        );
        receipt.cleanup = removed.state;
        receipt.cleanupReceipt = removed;
      } catch {
        receipt.cleanup = "needs-coordinator";
        receipt.result = "fail";
      }
    }
    await session?.browser.close();
    await admission?.close();
    credentialStream?.destroy();
    operatorStream?.destroy();
    await mkdir(options.output, { recursive: true });
    await writeFile(
      join(options.output, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(options.output, "receipt.md"),
      markdownReceipt(receipt),
      { mode: 0o600 },
    );
  }
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const receipt = await main();
    process.stdout.write(
      `${JSON.stringify({ result: receipt.result, mode: receipt.mode, cleanup: receipt.cleanup })}\n`,
    );
    if (receipt.result !== "pass") process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Dev proof could not start. Check arguments and fd 3.\n",
    );
    process.exitCode = 1;
  }
}
