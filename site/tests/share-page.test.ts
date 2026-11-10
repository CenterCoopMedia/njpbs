import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildShareStartRequest, MIN_DWELL_MS, parseShareConfig, photoDimensionsAllowed, shareErrorMessage, validateShareFields } from "../src/lib/share-form";
import { SHARE_UPLOAD_ORIGIN } from "../../packages/content-core/src/share-upload-origin";

const root = process.cwd();
const page = readFileSync(join(root, "src/pages/share/[...share].astro"), "utf8");
const island = readFileSync(join(root, "src/islands/ShareSubmission.astro"), "utf8");

function mountPage() {
  document.body.innerHTML = `<section data-share data-endpoint="https://intake.njpbs.org" data-sitekey="test">
    <div data-share-closed><p data-share-closed-text>This form is not open yet.</p><button disabled>Send submission</button></div>
    <form data-share-form hidden>
      <input data-share-name id="share-name"><p id="share-name-error"></p>
      <input data-share-email id="share-email"><p id="share-email-error"></p>
      <textarea data-share-message id="share-message"></textarea><span data-share-count></span><p id="share-message-error"></p>
      <input data-share-file id="share-file" type="file"><p id="share-file-error"></p>
      <div data-share-release></div><input data-share-consent id="share-consent" type="checkbox"><span data-share-checkbox></span><p id="share-consent-error"></p>
      <input data-share-age id="share-age" type="checkbox"><span data-share-age-text></span><span data-share-age-help></span><p id="share-age-error"></p>
      <input data-share-hp><div data-share-turnstile></div><p id="share-turnstile-error"></p>
      <p data-share-status></p><div data-share-progress-wrap hidden><progress data-share-progress></progress><span data-share-progress-text></span><button data-share-cancel></button></div>
      <button data-share-submit type="submit">Send submission</button><p data-share-privacy></p>
    </form><h2 data-share-thanks hidden tabindex="-1"></h2>
  </section>`;
  const script = island.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*/g, "");
  const dependencies = { buildShareStartRequest, MIN_DWELL_MS, parseShareConfig, photoDimensionsAllowed, shareErrorMessage, validateShareFields, SHARE_UPLOAD_ORIGIN };
  new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); delete window.turnstile; });

const openConfig = { open: true, consentVersion: "v1", consentTextHash: "a".repeat(64), texts: { release: "Approved release", checkbox: "I agree", age: "I am 18", ageHelp: "Ask a parent", privacy: "Privacy", closed: "Closed", thanks: "Thank you" } };
const uploadUrl = `${SHARE_UPLOAD_ORIGIN}/bucket/object`;

async function readyForm(start: (body: Record<string, unknown>) => Response | Promise<Response>, complete: () => Response | Promise<Response>, putStatuses: number[]) {
  const requests: Record<string, unknown>[] = [];
  const statuses: string[] = [];
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/config")) return Response.json(openConfig);
    if (url.endsWith("/start")) {
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      return start(body);
    }
    if (url.endsWith("/complete")) return complete();
    throw new Error(`Unexpected URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  let turnstileCallback: (value: string) => void = () => {};
  let turnstileError: () => void = () => {};
  const refreshFocus: Element[] = [];
  window.turnstile = {
    render: vi.fn((_mount, options) => { turnstileCallback = options.callback; turnstileError = options["error-callback"]; queueMicrotask(() => turnstileCallback("token")); return "widget"; }),
    reset: vi.fn(() => queueMicrotask(() => { refreshFocus.push(document.activeElement!); turnstileCallback("fresh-token"); })),
  };
  class UploadRequest {
    status = 0;
    listeners = new Map<string, () => void>();
    upload = { addEventListener: (_name: string, callback: (event: { lengthComputable: boolean; loaded: number; total: number }) => void) => {
      this.progress = callback;
    } };
    progress: (event: { lengthComputable: boolean; loaded: number; total: number }) => void = () => {};
    open() {}
    setRequestHeader() {}
    addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
    send() {
      this.status = putStatuses.shift() ?? 200;
      statuses.push(document.querySelector("[data-share-status]")?.textContent || "");
      for (const loaded of [25, 50, 75, 100]) {
        this.progress({ lengthComputable: true, loaded, total: 100 });
        statuses.push(document.querySelector("[data-share-status]")?.textContent || "");
      }
      this.listeners.get(this.status === 0 ? "error" : "load")?.();
    }
    abort() { this.listeners.get("abort")?.(); }
  }
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  mountPage();
  await vi.waitFor(() => expect(document.querySelector<HTMLFormElement>("[data-share-form]")?.hidden).toBe(false));
  document.querySelector<HTMLInputElement>("[data-share-name]")!.value = "Viewer";
  document.querySelector<HTMLInputElement>("[data-share-email]")!.value = "viewer@example.org";
  document.querySelector<HTMLTextAreaElement>("[data-share-message]")!.value = "A message with enough detail";
  Object.defineProperty(document.querySelector("[data-share-file]")!, "files", { configurable: true, value: [new File(["video"], "video.mp4", { type: "video/mp4" })] });
  document.querySelector<HTMLInputElement>("[data-share-consent]")!.checked = true;
  document.querySelector<HTMLInputElement>("[data-share-age]")!.checked = true;
  clock = 4_000;
  await vi.waitFor(() => expect(turnstileCallback).toBeTypeOf("function"));
  return { fetch, requests, statuses, refreshFocus, failTurnstile: () => turnstileError(), submit: () => document.querySelector<HTMLFormElement>("[data-share-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) };
}

describe("share page", () => {
  it("uses the public shell and stays out of shared layout navigation", () => {
    expect(page).toContain("<PublicSiteLayout");
    expect(page).toContain('canonicalPath="/share/"');
    expect(page).toContain("preview={false}");
    expect(page).toContain("<ShareSubmission />");
  });

  it("starts closed and uses the config text before opening", () => {
    expect(island).toContain("data-share-closed");
    expect(island).toContain("data-share-form novalidate hidden");
    expect(island).toContain("closedText.textContent = config.texts.closed");
    expect(island).toContain("if (!config.open) return");
    expect(island).toContain("config.texts.release");
    expect(island).toContain("config!.texts.thanks");
    expect(island).toContain('fetch(`${endpoint}/config`');
  });

  it("wires error focus, upload progress, cancel, and both worker calls", () => {
    expect(island).toContain("aria-describedby");
    expect(island).toContain("controls[Object.keys(errors)[0] as ShareField].focus()");
    expect(island).toContain("thanks.focus()");
    expect(island).toContain("xhr.upload.addEventListener(\"progress\"");
    expect(island).toContain('cancel.addEventListener("click", () => upload?.abort())');
    expect(island).toContain('post("/start", startRequest())');
    expect(island).toContain('post("/complete", { submissionId, requestId })');
  });

  it("stays closed on a failed config fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    mountPage();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(document.querySelector<HTMLFormElement>("[data-share-form]")?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("[data-share-closed] button")?.disabled).toBe(true);
  });

  it("opens from config and focuses the first invalid field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(openConfig), { status: 200 })));
    window.turnstile = { render: vi.fn(() => "widget"), reset: vi.fn() };
    mountPage();
    await vi.waitFor(() => expect(document.querySelector<HTMLFormElement>("[data-share-form]")?.hidden).toBe(false));
    expect(document.querySelector("[data-share-release]")?.textContent).toBe("Approved release");
    document.querySelector<HTMLFormElement>("[data-share-form]")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(document.activeElement?.id).toBe("share-name");
    expect(document.querySelector("#share-name-error")?.textContent).toMatch(/name/);
    expect(document.querySelector("#share-name")?.getAttribute("aria-describedby")).toContain("share-name-error");
  });

  it("locks the form while checking image dimensions", async () => {
    const form = await readyForm(
      () => Response.json({ submissionId: "submission", uploadUrl, uploadHeaders: {}, expiresAt: new Date(1_900_000).toISOString() }),
      () => Response.json({ ok: true }),
      [200],
    );
    const file = document.querySelector<HTMLInputElement>("[data-share-file]")!;
    Object.defineProperty(file, "files", { configurable: true, value: [new File(["photo"], "photo.jpg", { type: "image/jpeg" })] });
    let finishDecode!: (value: { width: number; height: number; close: () => void }) => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<{ width: number; height: number; close: () => void }>((resolve) => { finishDecode = resolve; })));
    form.submit();
    expect(file.disabled).toBe(true);
    form.submit();
    expect(form.requests).toHaveLength(0);
    finishDecode({ width: 100, height: 100, close: () => {} });
    await vi.waitFor(() => expect(document.querySelector("[data-share-thanks]")?.hasAttribute("hidden")).toBe(false));
    expect(form.requests).toHaveLength(1);
  });

  it("announces upload milestones and retries completion without another PUT", async () => {
    let completes = 0;
    const form = await readyForm(
      () => Response.json({ submissionId: "submission", uploadUrl, uploadHeaders: {}, expiresAt: new Date(1_900_000).toISOString() }),
      () => {
        expect(document.querySelector("[data-share-status]")?.textContent).toBe("Checking your file");
        return Response.json(++completes === 1 ? { error: "upstream" } : { ok: true }, { status: completes === 1 ? 502 : 200 });
      },
      [200],
    );
    form.submit();
    await vi.waitFor(() => expect(completes).toBe(1));
    expect(form.statuses).toEqual(["Uploading", "Uploading 25 percent", "Uploading 50 percent", "Uploading 75 percent", "Uploading 75 percent"]);
    form.submit();
    await vi.waitFor(() => expect(document.querySelector("[data-share-thanks]")?.hasAttribute("hidden")).toBe(false));
    expect(form.requests).toHaveLength(1);
    expect(form.requests[0].timeElapsed).toBe(4_000);
    expect(completes).toBe(2);
  });

  it("completes an upload when R2 says the object already exists", async () => {
    let completes = 0;
    const form = await readyForm(
      () => Response.json({ submissionId: "submission", uploadUrl, uploadHeaders: {}, expiresAt: new Date(1_900_000).toISOString() }),
      () => { completes++; return Response.json({ ok: true }); },
      [412],
    );
    form.submit();
    await vi.waitFor(() => expect(completes).toBe(1));
    expect(document.querySelector("[data-share-thanks]")?.hasAttribute("hidden")).toBe(false);
  });

  it("uploads again under the same request ID when completion reports a missing object", async () => {
    let completes = 0;
    const putStatuses = [200, 200];
    const form = await readyForm(
      () => Response.json({ submissionId: "submission", uploadUrl, uploadHeaders: {}, expiresAt: new Date(1_900_000).toISOString() }),
      () => Response.json(++completes === 1 ? { error: "missing_upload" } : { ok: true }, { status: completes === 1 ? 404 : 200 }),
      putStatuses,
    );
    form.submit();
    await vi.waitFor(() => expect(completes).toBe(1));
    form.submit();
    await vi.waitFor(() => expect(document.querySelector("[data-share-thanks]")?.hasAttribute("hidden")).toBe(false));
    expect(form.requests).toHaveLength(2);
    expect(form.requests[1].requestId).toBe(form.requests[0].requestId);
    expect(putStatuses).toHaveLength(0);
  });

  it("uses a new request ID after a kept ID is invalid", async () => {
    const form = await readyForm(
      (_body) => form.requests.length === 2
        ? Response.json({ error: "invalid" }, { status: 400 })
        : Response.json({ submissionId: "submission", uploadUrl, uploadHeaders: {}, expiresAt: new Date(1_900_000).toISOString() }),
      () => Response.json({ ok: true }),
      [0, 200],
    );
    form.submit();
    await vi.waitFor(() => expect(document.querySelector("[data-share-status]")?.textContent).toMatch(/try again/i));
    form.submit();
    await vi.waitFor(() => expect(document.querySelector("[data-share-thanks]")?.hasAttribute("hidden")).toBe(false));
    expect(form.requests).toHaveLength(3);
    expect(form.requests[0].requestId).toBe(form.requests[1].requestId);
    expect(form.requests[2].requestId).not.toBe(form.requests[1].requestId);
    expect(form.refreshFocus).toContain(document.querySelector("[data-share-turnstile]"));
  });

  it("stops waiting when the refreshed spam check fails", async () => {
    const form = await readyForm(
      () => form.requests.length === 2
        ? Response.json({ error: "invalid" }, { status: 400 })
        : Response.json({ submissionId: "submission", uploadUrl, uploadHeaders: {}, expiresAt: new Date(1_900_000).toISOString() }),
      () => Response.json({ ok: true }),
      [0],
    );
    form.submit();
    await vi.waitFor(() => expect(document.querySelector("[data-share-status]")?.textContent).toMatch(/try again/i));
    window.turnstile!.reset = vi.fn(() => queueMicrotask(() => form.failTurnstile()));
    form.submit();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-share-submit]")?.disabled).toBe(false));
    expect(document.querySelector("[data-share-status]")?.textContent).toMatch(/spam check/i);
    expect(form.requests).toHaveLength(2);
  });

  it("uses a new request ID after the upload link expires", async () => {
    const form = await readyForm(
      () => Response.json({ submissionId: "submission", uploadUrl, uploadHeaders: {}, expiresAt: new Date(1_900_000).toISOString() }),
      () => Response.json({ ok: true }),
      [0, 200],
    );
    form.submit();
    await vi.waitFor(() => expect(document.querySelector("[data-share-status]")?.textContent).toMatch(/try again/i));
    vi.mocked(Date.now).mockReturnValue(2_000_000);
    form.submit();
    await vi.waitFor(() => expect(document.querySelector("[data-share-thanks]")?.hasAttribute("hidden")).toBe(false));
    expect(form.requests).toHaveLength(2);
    expect(form.requests[1].requestId).not.toBe(form.requests[0].requestId);
  });
});
