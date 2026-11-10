process.env.CMS_DEV_EDITOR_EMAIL ??= "editor-4@example.org";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertDevUrl,
  assertNoBuild,
  assertFamilyAdmission,
  markdownReceipt,
  parseOptions,
  pollPublic,
  publicEvidence,
  publicReceiptEvidence,
  assertOrdinaryEditor,
  createAttemptId,
  proofPass,
  cmsPublicationEvidence,
  savedPost,
  publicationOperation,
} from "../../scripts/fastpub-dev-proof.mjs";
import { openDevEditor, readDevEditorCredential } from "../../scripts/lib/dev-editor-browser.mjs";
import { parseDevOperatorCredential } from "../../scripts/lib/dev-proof-admission.mjs";

const operationId = "abcdefghijklmnopqrst";
const expected = {
  operationId,
  sourceVersion: 4,
  texts: ["Fast publish proof <test>"],
};
const url = "https://dev-public.example.org/posts/fast-publish-proof-test/";

describe("dev Editor browser safety", () => {
  it.each(["old-version", "sandbox-disabled"])("refuses unsafe Chrome (%s) before credential intake or dev requests", async (kind) => {
    const browser = {
      version: () => kind === "old-version" ? "156.0.8078.72" : "156.0.8078.73",
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["/opt/google/chrome/chrome", "--no-sandbox"] }),
        detach: async () => {},
      }),
      newContext: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const credentialStream = Readable.from(["synthetic-password\n"]);
    await expect(openDevEditor({
      chromium: { launch: async () => browser }, credentialStream, dryRun: true,
    })).rejects.toThrow(kind === "old-version"
      ? "browser_version_below_156.0.8078.73" : "browser_sandbox_required");
    expect(credentialStream.readableDidRead).toBe(false);
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    credentialStream.destroy();
  });
});

function publicResponse(body = "<h1>Fast publish proof &lt;test&gt;</h1>") {
  return {
    status: 200,
    body,
    renderedVisible: true,
    headers: new Headers({
      "x-njpbs-content-source": "cms-no-build",
      "x-njpbs-publication-operation": operationId,
      "x-njpbs-source-version": "4",
      "x-njpbs-renderer-sha": "a".repeat(40),
      "x-njpbs-context-sha256": "b".repeat(64),
      "x-njpbs-input-sha256": "c".repeat(64),
      "x-njpbs-html-sha256": createHash("sha256").update(body).digest("hex"),
    }),
  };
}

describe("dev fast publication proof boundary", () => {
  it("never passes an Admin confirmation beyond 20 seconds", () => {
    expect(proofPass({ pass: true }, 19, true)).toBe(true);
    expect(proofPass({ pass: true }, 25, true)).toBe(false);
    expect(proofPass({ pass: true }, null, true)).toBe(false);
    expect(proofPass({ pass: true }, 12, false)).toBe(false);
  });

  it("refuses a static or metadata-only render observation", () => {
    const response = publicResponse();
    response.renderedVisible = false;
    expect(publicReceiptEvidence(response, expected)).toBe(true);
    expect(publicEvidence(response, expected)).toBe(false);
  });

  it("rejects broader roles, inactive accounts and the wrong editorial scope", () => {
    const profile = {
      active: true,
      role: null,
      email: "editor-4@example.org",
      grants: [{ role: "editor", sections: ["news"] }],
    };
    expect(assertOrdinaryEditor("fixture-uid", profile)).toEqual({
      role: "editor",
      section: "news",
    });
    for (const value of [
      { ...profile, role: "admin" },
      { ...profile, active: false },
      { ...profile, grants: [{ role: "contributor" }] },
      { ...profile, grants: [{ role: "editor", sections: ["politics"] }] },
    ]) {
      expect(() => assertOrdinaryEditor("fixture-uid", value)).toThrow(
        "ordinary_editor_required",
      );
    }
  });

  it("recovers a create ID from the outgoing wire request without its response", () => {
    const request = {
      collection: "cmsPosts",
      idempotencyKey: "fixture-create-nonce",
      section: "news",
      document: {
        type: "post",
        title: "Fast publish proof fixture",
        blocks: [],
      },
    };
    // Independent SHA-256 oracle from the server wire contract (Python hashlib).
    expect(createAttemptId(request, request.document.title)).toBe(
      "ec974751ee538b91a91decdc06520a2c",
    );
    expect(createAttemptId(request, request.document.title)).toBe(
      createAttemptId(
        {
          ...request,
          document: { blocks: [], title: request.document.title, type: "post" },
        },
        request.document.title,
      ),
    );
    expect(() =>
      createAttemptId({ ...request, id: "existing" }, request.document.title),
    ).toThrow("create_request_required");
  });

  it("detects a rerun of the same workflow run", () => {
    const before = {
      buildBatchId: "cms-static",
      generation: 7,
      runAttempts: ["10:1"],
    };
    expect(() =>
      assertNoBuild(before, { ...before, runAttempts: ["10:2"] }),
    ).toThrow("full_build_observed");
  });
  it("requires CMS metadata for the expected source and editorial version, including withdrawal", () => {
    const expected = { sourceVersion: 4, editorialVersion: 2 };
    const metadata = {
      publishedSourceVersion: 4,
      publishedContentVersion: 2,
      publicSourceVersion: 4,
      publiclyVisible: true,
    };
    expect(cmsPublicationEvidence(metadata, expected)).toBe(true);
    expect(cmsPublicationEvidence(null, expected)).toBe(false);
    expect(
      cmsPublicationEvidence({ ...metadata, publicSourceVersion: 3 }, expected),
    ).toBe(false);
    expect(
      cmsPublicationEvidence(
        { ...metadata, publishedContentVersion: 1 },
        expected,
      ),
    ).toBe(false);
    expect(
      cmsPublicationEvidence(metadata, { ...expected, withdrawn: true }),
    ).toBe(false);
    expect(
      cmsPublicationEvidence(
        { ...metadata, publicSourceVersion: null, publiclyVisible: false },
        { ...expected, withdrawn: true },
      ),
    ).toBe(true);
  });
  it("rejects a missing inherited credential pipe without closing libuv descriptors", () => {
    const moduleUrl = new URL(
      "../../scripts/lib/dev-editor-browser.mjs",
      import.meta.url,
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { openCredentialPipe } from ${JSON.stringify(moduleUrl)}; try { openCredentialPipe(4); process.exitCode=1; } catch (error) { process.stdout.write(error.message); }`,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("credential_pipe_required");
    expect(child.stderr).toBe("");
  });
  it.each(["fifo", "socket"])("keeps inherited %s credentials through the launcher", async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "dev-proof-pipes-"));
    const launcher = join(directory, "fastpub-dev-proof.py");
    const moduleUrl = new URL("../../scripts/lib/dev-editor-browser.mjs", import.meta.url).href;
    copyFileSync(new URL("../../scripts/fastpub-dev-proof.py", import.meta.url), launcher);
    // A fixed sibling fixture replaces the browser/network boundary only.
    writeFileSync(join(directory, "fastpub-dev-proof.mjs"), `
      import { openCredentialPipe } from ${JSON.stringify(moduleUrl)};
      for (const fd of [3, 4]) {
        for await (const chunk of openCredentialPipe(fd)) process.stdout.write(chunk);
      }
    `);
    const env = { ...process.env, NJPBS_DEV_PROOF_PIPE_IDENTITIES: "stale-invalid-value" };
    try {
      let result;
      if (kind === "fifo") {
        result = spawnSync("bash", ["-c", 'exec python3 "$1" --publish 3< <(printf fixture-three) 4< <(printf fixture-four)', "_", launcher], { encoding: "utf8", timeout: 5_000, env });
      } else {
        const child = spawn("python3", [launcher, "--publish"], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], timeout: 5_000, env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.stdio[3].end("fixture-three");
        child.stdio[4].end("fixture-four");
        result = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (status) => resolve({ status, stdout, stderr }));
        });
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("fixture-threefixture-four");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([
    ['--dry-run', '3</dev/null'],
    ['--publish', '3< <(printf fixture-three) 4<&-'],
  ])("launcher refuses unavailable required pipes for %s", (mode, redirection) => {
    const launcher = new URL("../../scripts/fastpub-dev-proof.py", import.meta.url).pathname;
    const result = spawnSync("bash", ["-c", `exec python3 "$1" "$2" ${redirection}`, "_", launcher, mode], { encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Dev proof requires inherited credential pipes.");
  });
  it.each(["not-json", "null", '{}', '{"3":{"type":"fifo","dev":"wrong","ino":"wrong"}}'])("refuses invalid provenance without consuming or closing the inherited pipe: %s", (identities) => {
    const moduleUrl = new URL("../../scripts/lib/dev-editor-browser.mjs", import.meta.url).href;
    const code = `
      import { openCredentialPipe } from ${JSON.stringify(moduleUrl)};
      import { readFileSync } from "node:fs";
      try { openCredentialPipe(3); process.exitCode = 1; }
      catch (error) { process.stdout.write(error.message + ":" + readFileSync(3, "utf8")); }
    `;
    const result = spawnSync("bash", ["-c", 'exec "$1" --input-type=module -e "$2" 3< <(printf untouched)', "_", process.execPath, code], { encoding: "utf8", timeout: 5_000, env: { ...process.env, NJPBS_DEV_PROOF_PIPE_IDENTITIES: identities } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("credential_pipe_required:untouched");
    expect(result.stderr).toBe("");
  });
  it("refuses service accounts outside the fixed dev project before authentication", () => {
    const account = {
      type: "service_account",
      project_id: "njpbs-site-dev",
      client_email: "proof-reader@njpbs-site-dev.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN PRIVATE KEY-----\nexample-fixture\n-----END PRIVATE KEY-----\n",
    };
    expect(parseDevOperatorCredential(JSON.stringify(account)).project_id).toBe(
      "njpbs-site-dev",
    );
    for (const value of [
      "invalid JSON",
      JSON.stringify({ ...account, project_id: "njpbs-site" }),
      JSON.stringify({
        ...account,
        client_email: "reader@njpbs-site.iam.gserviceaccount.com",
      }),
      JSON.stringify({ ...account, type: "authorized_user" }),
    ]) {
      expect(() => parseDevOperatorCredential(value)).toThrow(
        "dev_operator_credential_required",
      );
    }
  });
  it("refuses missing, pilot, paused, malformed or limited admission before a fresh fixture can publish", () => {
    const value = {
      schemaVersion: 2,
      revision: 3,
      enabled: true,
      families: { posts: { mode: "all" } },
      backgroundBucket: "approved-private-bucket",
    };
    expect(assertFamilyAdmission(value)).toBe(3);
    for (const admission of [
      undefined,
      { ...value, schemaVersion: 1 },
      { ...value, enabled: false },
      {
        ...value,
        families: { posts: { mode: "ids", ids: ["existing-post"] } },
      },
      { ...value, families: { pages: { mode: "all" } } },
      { ...value, unexpected: true },
    ]) {
      expect(() => assertFamilyAdmission(admission)).toThrow(
        "dev_family_admission_required",
      );
    }
  });
  it("accepts combined Page/Post admission only for the fixed dev target", () => {
    const value = {
      schemaVersion: 2,
      revision: 8,
      enabled: true,
      families: { posts: { mode: "all" }, pages: { mode: "ids", ids: ["home"] } },
      backgroundBucket: "njpbs-dev-public-artifacts",
    };
    expect(assertFamilyAdmission(value)).toBe(8);
    for (const admission of [
      { ...value, backgroundBucket: "njpbs-public-artifacts" },
      { ...value, enabled: false },
      { ...value, families: { ...value.families, pages: { mode: "ids", ids: ["unknown-page"] } } },
    ]) {
      expect(() => assertFamilyAdmission(admission)).toThrow("dev_family_admission_required");
    }
  });
  it("accepts server create-nonce IDs and records cleanup before validating the version", () => {
    // functions/save.js recordIdForCreateAttempt derives 32 hex characters.
    const result = {
      collection: "cmsPosts",
      id: "a".repeat(32),
      created: true,
      document: { title: "Fast publish proof fixture", version: 1 },
    };
    expect(savedPost(result, result.document.title)).toMatchObject({
      id: result.id,
      version: 1,
    });
    const receipt = {};
    expect(() =>
      savedPost(
        { ...result, document: { ...result.document, version: null } },
        result.document.title,
        undefined,
        receipt,
      ),
    ).toThrow("owned_post_receipt_required");
    expect(receipt).toEqual({ postId: result.id, cleanup: "pending" });
    expect(() => savedPost(result, "Different title")).toThrow(
      "owned_post_receipt_required",
    );
    expect(() =>
      savedPost(result, result.document.title, "b".repeat(32)),
    ).toThrow("owned_post_receipt_required");
  });

  it("accepts the different save and withdrawal acceptance schemas", () => {
    const document = {
      version: 4,
      published: { sourceVersion: 4, contentVersion: 2 },
    };
    const save = {
      document,
      publication: {
        queueId: operationId,
        transport: "post-no-build-v1",
        dispatched: false,
        status: "pending",
      },
    };
    // functions/lifecycle-transition.js omits dispatched and returns status queued.
    const withdrawal = {
      document,
      publication: {
        queueId: operationId,
        transport: "post-no-build-v1",
        status: "queued",
      },
    };
    expect(publicationOperation(save)).toEqual({
      operationId,
      sourceVersion: 4,
      editorialVersion: 2,
      workingVersion: 4,
    });
    expect(publicationOperation(withdrawal, true)).toEqual({
      operationId,
      sourceVersion: 4,
      editorialVersion: 2,
      workingVersion: 4,
    });
    expect(() =>
      publicationOperation({
        ...save,
        publication: { ...save.publication, transport: "serializer" },
      }),
    ).toThrow("no_build_transport_required");
    expect(() =>
      publicationOperation({ ...withdrawal, document: {} }, true),
    ).toThrow("publication_version_required");
  });
  it("defaults to read-only and refuses conflicting modes and target overrides", () => {
    expect(parseOptions([]).publish).toBe(false);
    expect(parseOptions(["--publish"]).publish).toBe(true);
    for (const args of [
      ["--publish", "--dry-run"],
      ["--origin", "https://njpbs.org"],
      ["--output"],
    ]) {
      expect(() => parseOptions(args)).toThrow("invalid_arguments");
    }
    expect(assertDevUrl(url)).toBe(url);
    for (const value of [
      "https://njpbs.org/posts/test/",
      "http://dev-public.example.org/posts/test/",
      `${url}?token=test`,
      "https://user:password@dev-public.example.org/posts/test/",
      "https://dev-public.example.org/",
      `${url}#test`,
    ]) {
      expect(() => assertDevUrl(value)).toThrow("dev_target_required");
    }
  });

  it("requires exact operation/version, changed content and matching HTML digest", () => {
    expect(publicEvidence(publicResponse(), expected)).toBe(true);
    expect(
      publicEvidence(publicResponse("<h1>Earlier content</h1>"), expected),
    ).toBe(false);
    for (const [name, value] of [
      ["x-njpbs-content-source", "cms-static-return"],
      ["x-njpbs-publication-operation", "xxxxxxxxxxxxxxxxxxxx"],
      ["x-njpbs-source-version", "3"],
      ["x-njpbs-html-sha256", "d".repeat(64)],
    ]) {
      const response = publicResponse();
      response.headers.set(name, value);
      expect(publicEvidence(response, expected)).toBe(false);
    }
  });

  it("withdrawal requires an operation-bound 410; Access refusals and missing pages do not pass", () => {
    const response = publicResponse();
    const withdrawn = { ...expected, withdrawn: true };
    for (const status of [200, 302, 401, 403, 404, 503]) {
      response.status = status;
      expect(publicEvidence(response, withdrawn)).toBe(false);
    }
    response.status = 410;
    expect(publicEvidence(response, withdrawn)).toBe(true);
  });

  it("polls each second, keeps the save-click clock and stops at 60 seconds", async () => {
    let clock = 0;
    const wait = async (ms) => {
      clock += ms;
    };
    const fetchResponse = async () =>
      clock < 19_000 ? { ...publicResponse(), status: 503 } : publicResponse();
    const result = await pollPublic({
      url,
      expected,
      startedAt: 0,
      now: () => clock,
      wait,
      fetchResponse,
    });
    expect(result).toMatchObject({
      pass: true,
      seconds: 19,
      publicStatus: 200,
    });
    clock = 21_000;
    expect(
      await pollPublic({
        url,
        expected,
        startedAt: 0,
        now: () => clock,
        wait,
        fetchResponse,
      }),
    ).toMatchObject({ pass: false, seconds: 21 });
    clock = 0;
    const timeout = await pollPublic({
      url,
      expected,
      startedAt: 0,
      now: () => clock,
      wait,
      fetchResponse: async () => {
        throw new Error("network unavailable");
      },
    });
    expect(clock).toBe(60_000);
    expect(timeout).toMatchObject({ pass: false, seconds: null });
  });

  it("refuses a full-build run or changed static baseline", () => {
    const before = {
      buildBatchId: "cms-static",
      generation: 7,
      runAttempts: ["10:1", "9:1"],
    };
    expect(() =>
      assertNoBuild(before, { ...before, runAttempts: ["10:1"] }),
    ).not.toThrow();
    for (const after of [
      { ...before, runAttempts: ["11:1", "10:1"] },
      { ...before, generation: 8 },
      { ...before, buildBatchId: "cms-next" },
    ]) {
      expect(() => assertNoBuild(before, after)).toThrow("full_build_observed");
    }
  });

  it("takes only the fd-stream password line and does not trust pass metadata", async () => {
    const credential = await readDevEditorCredential(
      Readable.from([
        "example-fixture-passphrase\nemail: other@example.test\nurl: https://unused.invalid\n",
      ]),
    );
    expect(credential).toEqual({
      email: "editor-4@example.org",
      password: "example-fixture-passphrase",
    });
    await expect(
      readDevEditorCredential(Readable.from(["x".repeat(16385)])),
    ).rejects.toThrow("invalid_credential");
  });

  it("writes a short receipt table without arbitrary response or error fields", () => {
    const markdown = markdownReceipt({
      mode: "publish",
      result: "pass",
      token: "discard",
      steps: [
        {
          step: "publish",
          seconds: 9,
          receiptId: operationId,
          pass: true,
          cookies: "discard",
        },
      ],
    });
    expect(markdown).toContain(`| publish | 9 | ${operationId} | Pass |`);
    expect(markdown).not.toContain("discard");
  });
});
