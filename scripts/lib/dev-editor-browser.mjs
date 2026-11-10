import { devAccessOrigin, deploymentEmail } from "./deployment-settings.mjs";
import { execFile } from "node:child_process";
import { createReadStream, fstatSync } from "node:fs";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  launchCmsBrowser,
  readBrowserCredential,
} from "../cms-debug-browser.mjs";

export const ADMIN_ORIGIN = "https://dev-admin.example.org";
export const PUBLIC_ORIGIN = "https://dev-public.example.org";

const EMAIL = (process.env.CMS_DEV_EDITOR_EMAIL ?? "").toLowerCase();
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function openCredentialPipe(fd) {
  // The Python launcher captures identity before Node can reuse a missing FD.
  // Metadata alone does not prove inheritance without that launcher contract.
  try {
    const identities = JSON.parse(process.env.NJPBS_DEV_PROOF_PIPE_IDENTITIES ?? "{}");
    const expected = identities[String(fd)];
    if (![3, 4].includes(fd) || !expected) throw new Error();
    const stat = fstatSync(fd, { bigint: true });
    const type = stat.isFIFO() ? "fifo" : stat.isSocket() ? "socket" : null;
    if (
      !type || expected.type !== type ||
      expected.dev !== String(stat.dev) || expected.ino !== String(stat.ino)
    ) throw new Error();
  } catch {
    // Do not read, wrap or close a descriptor whose provenance is unknown.
    throw new Error("credential_pipe_required");
  }
  return createReadStream("", { fd, autoClose: true });
}

// Read the password from an inherited credential pipe.
// Keep only the password line. Pass metadata never reaches a browser or report.
export async function readDevEditorCredential(stream) {
  let input = "";
  const timeout = setTimeout(
    () => stream.destroy(new Error("credential_timeout")),
    10_000,
  );
  try {
    for await (const chunk of stream) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 16 * 1024)
        throw new Error("invalid_credential");
    }
  } finally {
    clearTimeout(timeout);
  }
  return readBrowserCredential(
    Readable.from([`${input.split(/\r?\n/)[0]}\nemail: ${EMAIL}\n`]),
  );
}

async function inboxRequest(operation, params) {
  const command = process.env.CMS_DEV_INBOX_COMMAND;
  if (!command?.startsWith("/")) throw new Error("inbox_command_required");
  const { stdout } = await run(command, [operation, JSON.stringify(params)], {
    timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function accessCode(since) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const list = await inboxRequest("list", {
      userId: "me",
      q: `to:${EMAIL} newer_than:1h`,
      maxResults: 5,
    });
    for (const message of list.messages ?? []) {
      const item = await inboxRequest("get", {
        userId: "me",
        id: message.id,
        format: "metadata",
      });
      if (Number(item.internalDate) < since) continue;
      const code = item.snippet?.match(/\b(\d{6})\b/);
      if (code) return code[1];
    }
    await sleep(5_000);
  }
  throw new Error("access_code_unavailable");
}

export async function passDevAccess(page, destination) {
  const ACCESS_ORIGIN = devAccessOrigin();
  if (![ADMIN_ORIGIN, PUBLIC_ORIGIN].includes(new URL(destination).origin)) {
    throw new Error("dev_target_required");
  }
  await page.goto(destination, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).origin !== ACCESS_ORIGIN) return;
  await page.getByRole("textbox", { name: "Email", exact: true }).waitFor();
  await page.locator("body").ariaSnapshot(); // Before any credential is typed; never print it.
  // Allow a small clock offset from the mail service.
  const since = Date.now() - 5_000;
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(EMAIL);
  await page
    .getByRole("button", { name: "Send login code", exact: true })
    .click();
  const codeBox = page.getByRole("textbox").first();
  await codeBox.waitFor();
  const code = await accessCode(since);
  await codeBox.fill(code);
  try {
    await page
      .getByRole("button", { name: /sign in|submit|verify|continue/i })
      .click();
    await page.waitForURL((url) => url.origin === new URL(destination).origin, {
      timeout: 60_000,
    });
  } finally {
    // No snapshot after typing. Clear only our code field if the login did not leave.
    if (new URL(page.url()).origin === ACCESS_ORIGIN)
      await codeBox.fill("").catch(() => {});
  }
}

export async function openDevEditor({
  chromium,
  credentialStream,
  dryRun,
  onStage = () => {},
}) {
  devAccessOrigin();
  deploymentEmail("CMS_DEV_EDITOR_EMAIL");
  const browser = await launchCmsBrowser(chromium);
  try {
    const context = await browser.newContext();
    // Dry runs refuse content writes even if the UI changes or auto-save starts.
    if (dryRun)
      await context.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (
          /\/cms(?:Save|Publish|Transition|Upload|Replace|Delete|Update|Create|Assign|Set|Acquire|Renew)/.test(
            path,
          )
        ) {
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await onStage("admin-access");
    await passDevAccess(page, `${ADMIN_ORIGIN}/`);
    if (new URL(page.url()).origin !== ADMIN_ORIGIN)
      throw new Error("dev_target_required");
    await page.getByLabel("Password", { exact: true }).waitFor();
    await page.locator("body").ariaSnapshot();
    await onStage("cms-login");
    // Fetch the password only after the CMS form is ready.
    const credential = await readDevEditorCredential(credentialStream);
    const passwordField = page.getByLabel("Password", { exact: true });
    await page.getByLabel("Email", { exact: true }).fill(credential.email);
    const identity = page
      .waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith(
            "/accounts:signInWithPassword",
          ) && response.request().method() === "POST",
      )
      .then(async (response) => {
        const value = await response.json();
        if (
          !response.ok() ||
          value.email?.toLowerCase() !== EMAIL ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(value.localId ?? "")
        )
          throw new Error("dev_editor_login_failed");
        return value.localId;
      })
      .catch(() => {
        throw new Error("dev_editor_login_failed");
      });
    void identity.catch(() => {});
    await passwordField.fill(credential.password);
    credential.password = "";
    try {
      await page
        .locator("form")
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await page.getByRole("button", { name: /^Account menu for / }).waitFor();
    } finally {
      if (await passwordField.count())
        await passwordField.fill("").catch(() => {});
    }
    if (new URL(page.url()).origin !== ADMIN_ORIGIN)
      throw new Error("dev_target_required");
    // The top-level public visit obtains Access admission and the existing staff handoff.
    const publicPage = await context.newPage();
    publicPage.setDefaultTimeout(30_000);
    await onStage("public-access");
    await passDevAccess(publicPage, `${PUBLIC_ORIGIN}/`);
    await publicPage.waitForURL((url) => url.origin === PUBLIC_ORIGIN, {
      timeout: 60_000,
    });
    await page.bringToFront();
    await onStage("signed-in");
    return { browser, context, page, publicPage, authUid: await identity };
  } catch {
    credentialStream.destroy();
    await browser.close();
    throw new Error("dev_editor_login_failed");
  }
}
