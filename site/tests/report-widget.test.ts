import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { Window as DOMWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConsoleLogs } from "../src/lib/console-capture";
import { createModalDialog } from "../src/lib/dialog";
import {
  buildReportPayload,
  canSubmit,
  isDescriptionLongEnough,
  isValidEmail,
  MAX_DESCRIPTION_LENGTH,
  MIN_DWELL_MS,
  passesDwell,
} from "../src/lib/report-form";

// These source-level assertions pin the island-to-controller wiring and the
// load-bearing invariants that are easy to break in a refactor. The controller's
// DOM behavior runs in dialog.test.ts; form and capture logic run in
// report-form.test.ts and console-capture.test.ts. ReportProblem.astro owns only
// the route boundary, covered in report-problem-route-boundary.test.ts.
const source = readFileSync(
  join(process.cwd(), "src", "islands", "ReportProblemDialog.astro"),
  "utf8",
);

const reportScripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (match) => match[1],
);

function runReportScript() {
  const compiled = ts
    .transpileModule(reportScripts[0], {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replace(
      /import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*/g,
      "",
    );
  const dependencies = {
    buildReportPayload,
    canSubmit,
    isDescriptionLongEnough,
    isValidEmail,
    MAX_DESCRIPTION_LENGTH,
    MIN_DWELL_MS,
    passesDwell,
    getConsoleLogs,
    initConsoleCapture: vi.fn(),
    createModalDialog,
  };
  new Function(...Object.keys(dependencies), compiled)(
    ...Object.values(dependencies),
  );
}

function mountReportDialog() {
  document.body.innerHTML = `
    <a href="mailto:njpbs@montclair.edu" data-report-open>Report a problem</a>
    <dialog data-report-dialog data-endpoint="https://reports.example.test" data-sitekey="test-key" aria-label="Report a problem">
      <form method="dialog" data-report-form novalidate>
        <input type="radio" name="category" value="bug" checked>
        <textarea
          name="description"
          aria-invalid="false"
          aria-describedby="report-description-hint report-description-count"
          data-report-description
        ></textarea>
        <span id="report-description-hint"></span>
        <span id="report-description-count" data-report-count></span>
        <p id="report-description-error" data-report-description-error hidden></p>
        <input type="email" name="email" aria-invalid="false" data-report-email>
        <p data-report-email-error hidden></p>
        <input name="website" data-report-hp>
        <p data-report-status></p>
        <button type="button" data-report-retry hidden>Retry spam check</button>
        <p data-report-note hidden></p>
        <div data-report-turnstile></div>
        <button type="button" data-dialog-close>Cancel</button>
        <button type="submit" data-report-submit disabled>Send report</button>
      </form>
    </dialog>
  `;
  const trigger = document.querySelector<HTMLElement>("[data-report-open]")!;
  const dialog = document.querySelector<HTMLDialogElement>(
    "[data-report-dialog]",
  )!;
  const form = document.querySelector<HTMLFormElement>("[data-report-form]")!;
  const description = document.querySelector<HTMLTextAreaElement>(
    "[data-report-description]",
  )!;
  const descriptionError = document.querySelector<HTMLElement>(
    "[data-report-description-error]",
  )!;
  const status = document.querySelector<HTMLElement>("[data-report-status]")!;
  const submit = document.querySelector<HTMLButtonElement>(
    "[data-report-submit]",
  )!;
  const retry = document.querySelector<HTMLButtonElement>("[data-report-retry]")!;
  const cancel = document.querySelector<HTMLButtonElement>(
    "[data-dialog-close]",
  )!;

  const order: string[] = [];
  Object.defineProperties(dialog, {
    showModal: {
      configurable: true,
      value: vi.fn(() => {
        dialog.setAttribute("open", "");
        order.push("visible");
      }),
    },
    close: {
      configurable: true,
      value: vi.fn(() => {
        dialog.removeAttribute("open");
        dialog.dispatchEvent(new Event("close"));
      }),
    },
  });

  let turnstileCallback: ((token: string) => void) | undefined;
  let turnstileErrorCallback: ((code: string) => void) | undefined;
  window.turnstile = {
    render: vi.fn((_mount, options) => {
      order.push(
        `turnstile:${dialog.open}:${document.activeElement === description}`,
      );
      turnstileCallback = options.callback as (token: string) => void;
      turnstileErrorCallback = options["error-callback"] as (code: string) => void;
      turnstileCallback("first-token");
      return "report-widget";
    }),
    reset: vi.fn(() => turnstileCallback?.("fresh-token")),
  };

  return {
    trigger,
    dialog,
    form,
    description,
    descriptionError,
    status,
    submit,
    retry,
    cancel,
    order,
    failChallenge: (code = "200500") => turnstileErrorCallback?.(code),
    solveChallenge: () => turnstileCallback?.("recovered-token"),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.turnstile;
  document.body.replaceChildren();
});

describe("report dialog accessibility primitive", () => {
  it("routes the native dialog through the shared modal controller", () => {
    // The shared controller owns showModal, Escape, backdrop dismissal, close
    // controls, and focus return. The island supplies only its form lifecycle.
    expect(source).toMatch(/<dialog\b/);
    expect(source).toContain(
      'import { createModalDialog } from "../lib/dialog"',
    );
    expect(source).toContain("createModalDialog(reportDialog");
    expect(source).not.toContain("reportDialog.showModal()");
    expect(source).not.toContain("reportDialog.close()");
  });

  it("labels the dialog and gives the description a real label", () => {
    expect(source).toContain('aria-labelledby="report-dialog-title"');
    expect(source).toContain('for="report-description"');
  });

  it("passes the trigger and description focus target to the controller", () => {
    expect(source).toContain("initialFocus: descEl");
    expect(source).toContain("modal.open(trigger)");
    expect(source).not.toContain("openerEl");
  });

  it("uses controller-owned close controls", () => {
    expect(source.match(/data-dialog-close/g)).toHaveLength(2);
    expect(source).not.toContain("data-report-cancel");
  });

  it("associates the optional email with its error only while invalid", () => {
    const validateEmailSource =
      source.match(
        /function validateEmail\(\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    function refreshSubmitState/,
      )?.[0] ?? "";

    expect(source).toMatch(
      /<input\b(?=[^>]*\bid="report-email")(?=[^>]*\baria-invalid="false")[^>]*>/,
    );
    expect(source).not.toMatch(
      /<input\b(?=[^>]*\bid="report-email")[^>]*\baria-describedby="report-email-error"/,
    );
    expect(source).toMatch(
      /id="report-email-error"[^>]*data-report-email-error/,
    );
    expect(validateEmailSource).not.toBe("");
    expect(validateEmailSource).toContain(
      'emailEl.setAttribute("aria-invalid", String(!valid))',
    );
    expect(validateEmailSource).toMatch(
      /if\s*\(valid\)\s*\{[\s\S]*?emailEl\.removeAttribute\(\s*"aria-describedby"\s*\)[\s\S]*?\}\s*else\s*\{[\s\S]*?emailEl\.setAttribute\(\s*"aria-describedby",\s*"report-email-error"\s*\)/,
    );
  });

  it("associates a short description with its error and resets it on reopen", async () => {
    expect(source).toMatch(
      /<textarea\b(?=[^>]*\bid="report-description")(?=[^>]*\baria-invalid="false")(?=[^>]*\baria-describedby="report-description-hint report-description-count")[^>]*>/,
    );
    expect(source).toMatch(
      /<p\b(?=[^>]*\bid="report-description-error")(?=[^>]*\bdata-report-description-error)[^>]*>/,
    );
    const { trigger, form, description, descriptionError, status, cancel } = mountReportDialog();
    vi.useFakeTimers();
    runReportScript();
    trigger.click();

    description.value = "short";
    description.dispatchEvent(new Event("input", { bubbles: true }));

    expect(description.getAttribute("aria-invalid")).toBe("true");
    expect(description.getAttribute("aria-describedby")).toBe(
      "report-description-hint report-description-count report-description-error",
    );
    expect(descriptionError.hidden).toBe(false);

    await vi.advanceTimersByTimeAsync(MIN_DWELL_MS + 50);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(status.textContent).toBe("Enter at least 10 characters.");

    cancel.click();
    trigger.click();
    expect(description.getAttribute("aria-invalid")).toBe("false");
    expect(description.getAttribute("aria-describedby")).toBe(
      "report-description-hint report-description-count",
    );
    expect(descriptionError.hidden).toBe(true);

    description.value = "The video player does not load.";
    description.dispatchEvent(new Event("input", { bubbles: true }));

    expect(description.getAttribute("aria-invalid")).toBe("false");
    expect(description.getAttribute("aria-describedby")).toBe(
      "report-description-hint report-description-count",
    );
    expect(descriptionError.hidden).toBe(true);
  });

  it("blocks a non-empty invalid email instead of silently dropping it", () => {
    expect(source).toContain("isValidEmail");
    expect(source).toMatch(
      /refreshSubmitState\(\)[\s\S]*?emailIsValid\(\)[\s\S]*?submitEl\.disabled/,
    );
    expect(source).toMatch(
      /emailEl\.addEventListener\("input"[\s\S]*?validateEmail\(\)/,
    );
  });
});

describe("report dialog shipped lifecycle", () => {
  it.each([true, false])("opens the public report deep link only with a configured endpoint (%s)", (configured) => {
    const previousHash = window.location.hash;
    const { dialog, description, trigger, submit } = mountReportDialog();
    const main = document.createElement("main");
    main.id = "main";
    main.tabIndex = -1;
    document.body.prepend(main);
    if (!configured) dialog.dataset.endpoint = "";
    window.location.hash = "#report-a-problem";
    try {
      runReportScript();
      expect(dialog.open).toBe(configured);
      if (configured) {
        expect(document.activeElement).toBe(description);
        dialog.close();
        expect(document.activeElement).toBe(main);
      }
      expect(submit.disabled).toBe(true);
      expect(trigger.getAttribute("href")).toBe("mailto:njpbs@montclair.edu");
    } finally {
      window.location.hash = previousHash;
    }
  });

  it("offers recovery after a rendered spam-check error and clears it after verification", async () => {
    vi.useFakeTimers();
    const { trigger, description, status, submit, retry, cancel, failChallenge } = mountReportDialog();
    runReportScript();
    trigger.click();
    description.value = "The video player does not load.";
    description.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(MIN_DWELL_MS + 50);
    expect(submit.disabled).toBe(false);

    failChallenge();
    expect(submit.disabled).toBe(true);
    expect(status.textContent).toMatch(/spam check/i);
    expect(retry.hidden).toBe(false);
    expect(status.querySelector("a")?.getAttribute("href")).toBe(
      "mailto:njpbs@montclair.edu?subject=Website%20problem%20report",
    );
    expect(description.value).toBe("The video player does not load.");
    retry.focus();
    retry.click();
    expect(status.textContent).toBe("");
    expect(status.querySelector("a")).toBeNull();
    expect(submit.disabled).toBe(false);
    expect(description.value).toBe("The video player does not load.");
    expect(document.activeElement).toBe(description);
    expect(retry.hidden).toBe(true);

    failChallenge();
    cancel.click();
    trigger.click();
    expect(status.textContent).toBe("");
    expect(submit.disabled).toBe(true);
  });

  it("offers one email fallback if the spam-check script cannot load", () => {
    const { trigger, status, retry, submit } = mountReportDialog();
    const settings = (window as unknown as DOMWindow).happyDOM.settings;
    const previous = settings.disableJavaScriptFileLoading;
    settings.disableJavaScriptFileLoading = true;
    delete window.turnstile;
    try {
      runReportScript();
      trigger.click();
      document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com"]')!
        .dispatchEvent(new Event("error"));
      expect(status.textContent).toBe("We couldn't load the spam check. Email njpbs@montclair.edu to report the problem.");
      expect(status.querySelectorAll("a")).toHaveLength(1);
      expect(retry.hidden).toBe(true);
      expect(submit.disabled).toBe(true);
    } finally {
      settings.disableJavaScriptFileLoading = previous;
    }
  });

  it.each(["110100", "110110", "110200", "200100", "400020", "400021", "400070", "unknown"])(
    "offers email without an ineffective retry for permanent/unknown error %s", (code) => {
      const { trigger, status, retry, submit, failChallenge } = mountReportDialog();
      runReportScript();
      trigger.click();
      failChallenge(code);
      expect(status.textContent).toContain("unavailable");
      expect(status.querySelector("a")).not.toBeNull();
      expect(retry.hidden).toBe(true);
      expect(submit.disabled).toBe(true);
    },
  );

  it.each(["110600", "110620", "200500", "300030", "600010"])(
    "offers draft-preserving retry for documented transient error %s", (code) => {
      const { trigger, retry, failChallenge } = mountReportDialog();
      runReportScript();
      trigger.click();
      failChallenge(code);
      expect(retry.hidden).toBe(false);
    },
  );

  it.each(["retry", "email"])("restores focus when automatic verification clears focused %s recovery", (control) => {
    const { trigger, description, status, retry, failChallenge, solveChallenge } = mountReportDialog();
    runReportScript();
    trigger.click();
    failChallenge();
    const focused = control === "retry" ? retry : status.querySelector<HTMLAnchorElement>("a")!;
    focused.focus();
    expect(document.activeElement).toBe(focused);
    solveChallenge();
    expect(document.activeElement).toBe(description);
    expect(status.textContent).toBe("");
    expect(retry.hidden).toBe(true);
  });

  it.each(["retry", "email"])("keeps focused %s recovery stable across repeated automatic errors", (control) => {
    const { trigger, status, retry, failChallenge } = mountReportDialog();
    runReportScript();
    trigger.click();
    failChallenge();
    const email = status.querySelector<HTMLAnchorElement>("a")!;
    const focused = control === "retry" ? retry : email;
    focused.focus();
    failChallenge();
    expect(document.activeElement).toBe(focused);
    expect(status.querySelector("a")).toBe(email);
    expect(email.textContent).toContain("njpbs@montclair.edu");
    expect(retry.hidden).toBe(false);
  });

  it("keeps a validation error when a previously failed spam check later succeeds", async () => {
    vi.useFakeTimers();
    const { trigger, form, description, status, failChallenge, solveChallenge } = mountReportDialog();
    runReportScript();
    trigger.click();
    description.value = "short";
    failChallenge();
    await vi.advanceTimersByTimeAsync(MIN_DWELL_MS + 50);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(status.textContent).toBe("Enter at least 10 characters.");
    solveChallenge();
    expect(status.textContent).toBe("Enter at least 10 characters.");
  });

  it("keeps report state safe while the real controller closes and reopens", async () => {
    expect(reportScripts).toHaveLength(1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T19:00:00-04:00"));
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const successResponse = () =>
      ({
        ok: true,
        json: vi.fn().mockResolvedValue({ success: true }),
      }) as unknown as Response;
    const firstSend = Promise.withResolvers<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstSend.promise)
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal("fetch", fetchMock);
    // The shipped script uses the browser FormData constructor. Node also has a
    // fetch FormData global, but it does not accept happy-dom's HTMLFormElement.
    vi.stubGlobal("FormData", window.FormData);

    const {
      trigger,
      dialog,
      form,
      description,
      status,
      submit,
      cancel,
      order,
    } = mountReportDialog();
    runReportScript();

    trigger.click();
    expect(order).toEqual(["visible", "turnstile:true:true"]);
    expect(document.activeElement).toBe(description);

    description.value = "The schedule page has a broken link.";
    description.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(MIN_DWELL_MS + 50);
    expect(submit.disabled).toBe(false);
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const clearsBeforeFirstClose = clearTimeoutSpy.mock.calls.length;
    cancel.click();
    expect(clearTimeoutSpy.mock.calls.length - clearsBeforeFirstClose).toBe(2);
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    expect(dialog.open).toBe(true);
    firstSend.resolve(successResponse());
    await Promise.resolve();
    await Promise.resolve();
    expect(status.textContent).toBe("");
    expect(dialog.open).toBe(true);

    description.value = "The live stream button does not respond.";
    description.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(MIN_DWELL_MS + 50);
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(status.textContent).toContain("Thanks"), {
      timeout: 100,
      interval: 1,
    });

    const clearsBeforeDelayedClose = clearTimeoutSpy.mock.calls.length;
    cancel.click();
    expect(clearTimeoutSpy.mock.calls.length - clearsBeforeDelayedClose).toBe(
      2,
    );
    trigger.click();
    await vi.advanceTimersByTimeAsync(2500);
    expect(dialog.open).toBe(true);
  });
});

describe("report dialog fail-safe defaults", () => {
  it("ships the submit button disabled so it can never be a dead POST", () => {
    expect(source).toMatch(/data-report-submit[^>]*\bdisabled\b/);
  });

  it("gates submission on a configured endpoint", () => {
    // Without PUBLIC_REPORT_ENDPOINT the form stays viewable but unsubmittable,
    // with a note, rather than posting into the void.
    expect(source).toContain("Boolean(endpoint)");
  });

  it("carries a honeypot field for silent bot rejection", () => {
    expect(source).toContain("data-report-hp");
    expect(source).toContain('name="website"');
  });

  it("loads the Turnstile script only when a sitekey is configured", () => {
    expect(source).toMatch(/if\s*\(!sitekey\b/);
  });

  it("gates the submit button on the dwell, not only at submit time", () => {
    // The enable path runs canSubmit (which includes the dwell) and a timer
    // flips the button on at the dwell mark, so a genuine fast report is never
    // silently dropped by the submit-time bot check. Regressing to a
    // description-only enable check would reopen that hole.
    expect(source).toContain("canSubmit(");
    expect(source).toContain("MIN_DWELL_MS");
  });

  it("resets Turnstile on a failed send so a retry gets a fresh token", () => {
    // Turnstile tokens are single-use. The retry path must reset the widget and
    // clear the token, or a transient intake failure strands the reporter on a
    // 403 loop resending a consumed token.
    expect(source).toMatch(
      /Reached only when the send failed[\s\S]*?window\.turnstile\.reset\(turnstileWidgetId\)[\s\S]*?refreshSubmitState\(\)/,
    );
  });
});

describe("report dialog async safety", () => {
  it("ignores a stale submit response after the dialog is closed or reopened", () => {
    // A per-open generation is captured at send time; a response from a previous
    // dialog session must not write status or close a freshly reopened dialog.
    expect(source).toContain("openGeneration");
    expect(source).toMatch(/submitGen !== openGeneration/);
  });

  it("restores the submit label on open so a stale send cannot strand it on Sending", () => {
    // The stale-response guard returns early without restoring the button label,
    // so resetForm must restore it on every open, or a dialog reopened mid-send
    // shows "Sending..." forever.
    expect(source).toContain("submitEl.textContent = submitLabel");
  });

  it("attaches only one Turnstile load handler across repeated opens", () => {
    // Opening and closing before api.js loads must not stack load handlers, or
    // Turnstile renders duplicate widgets against the same mount.
    expect(source).toContain("turnstileLoading");
  });

  it("cancels the delayed close on reopen so a new report is not closed mid-typing", () => {
    // The success/automated close is a tracked timer that open and close clear,
    // so reopening within the close delay does not fire the old timer against a
    // freshly opened dialog.
    expect(source).toContain("closeTimer = window.setTimeout(closeDialog");
    expect(source).toContain("window.clearTimeout(closeTimer)");
  });

  it("runs visible-open and close lifecycle work through controller callbacks", () => {
    expect(source).toContain("onOpen: ensureTurnstile");
    expect(source).toMatch(
      /onClose:\s*\(\)\s*=>\s*\{[\s\S]*?openGeneration\s*\+=\s*1[\s\S]*?clearTimeout\(dwellTimer\)[\s\S]*?clearTimeout\(closeTimer\)/,
    );
    expect(source).toContain("modal.close()");
  });

  it("drops a failed Turnstile script so the next open retries with a fresh one", () => {
    // A script element that already errored never re-fires load; reusing it would
    // leave submit permanently disabled, so the error handler removes it.
    expect(source).toMatch(/"error"[\s\S]*?script\?\.remove\(\)/);
  });

  it("lets the mailto fallback fire when reporting is off or the dialog is unsupported", () => {
    // The trigger only hijacks the footer mailto link when there is an endpoint
    // to post to and native <dialog> support exists; otherwise the link opens
    // the reporter's email client instead of a dialog they cannot submit.
    expect(source).toContain("modal.supportsModal");
    expect(source).toContain("if (!endpoint || !modal.supportsModal) return");
  });

  it("surfaces an email fallback when the Turnstile script fails to load", () => {
    // With a sitekey set, submit needs a token; a blocked script would otherwise
    // leave the button disabled with no path, so the error handler points the
    // reporter at the email address.
    expect(source).toMatch(
      /"error"[\s\S]*?setStatus\([\s\S]*?njpbs@montclair\.edu/,
    );
  });

  it("keeps the disabled-state note public-safe, with no staging language", () => {
    // The production Pages build ships without PUBLIC_REPORT_ENDPOINT, so the
    // disabled note is public-facing: it must carry no launch/review wording.
    expect(source).not.toMatch(/turns on at launch|here for review/i);
    expect(source).toContain("njpbs@montclair.edu");
  });
});

describe("report dialog brand and theme", () => {
  it("shows the NJ PBS wordmark at the top of the form", () => {
    // A reporter asked for the header wordmark on the form so it reads as part
    // of the NJ PBS site, not an unbranded overlay. It reuses the same asset the
    // header and footer ship (which passes the logo-image guardrail), marked
    // decorative so the dialog's own title still carries the accessible name.
    expect(source).toContain("report-dialog__brand");
    expect(source).toContain("/brand/njpbs-horizontal-white.svg");
  });

  it("themes its scrollbar to match the dark surface", () => {
    // The dialog is a dark scroll container (overflow: auto on a short viewport);
    // without scrollbar theming it inherits a generic UA scrollbar that clashes
    // with the navy panel. Theme it with the standard property plus the WebKit
    // fallback so the scrollbar blends on both engines.
    expect(source).toMatch(/scrollbar-color:/);
    expect(source).toContain("::-webkit-scrollbar");
  });
});

describe("report dialog reuses the tested rules", () => {
  it("imports payload shaping and validation from the shared module", () => {
    // The island must not re-implement the rules the Worker and tests pin, or
    // the three surfaces drift. It imports them from report-form instead.
    expect(source).toContain('from "../lib/report-form"');
    expect(source).toContain("buildReportPayload");
    expect(source).toContain("passesDwell");
  });

  it("captures console context from the shared capture module", () => {
    expect(source).toContain('from "../lib/console-capture"');
    expect(source).toContain("getConsoleLogs");
  });
});
