import "./ReportProblemDialog.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  cmsSubmitBugReport,
  type BugReportArea,
  type BugReportCategory,
  type BugReportSeverity,
  type BugReportSubmission,
} from "../lib/functions";
import { parseContentPath, reportsPath } from "../lib/routes";
import { getConsoleLogs } from "../lib/console-capture";
import { collectReportDiagnostics } from "../lib/report-diagnostics";
import { adminPerf, reportCorrelationIds } from "../lib/perf-receipts";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Select,
  Textarea,
} from "./ui/Primitives";
import { Icon } from "./ui/Icon";

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function browserName(): string {
  const agent = navigator.userAgent;
  const match = agent.match(/(Edg|Chrome|Firefox|Version)\/(\d+(?:\.\d+)?)/);
  if (!match) return "Unknown browser";
  const name = match[1] === "Version" ? "Safari" : match[1] === "Edg" ? "Edge" : match[1];
  return `${name} ${match[2]}`;
}

function operatingSystem(): string {
  const platform = navigator.userAgentData?.platform || navigator.platform;
  return platform?.slice(0, 160) || "Unknown operating system";
}

function affectedRecord(pathname: string): BugReportSubmission["affectedRecord"] {
  const route = parseContentPath(pathname);
  if (route.kind === "edit-page") return { kind: "page", id: route.pageId };
  if (route.kind === "edit-record" && route.type === "post") {
    return { kind: "post", id: route.id };
  }
  return undefined;
}

function openModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

export function ReportProblemDialog({
  currentPath,
  getIdToken,
  canOpenReport = true,
  menuItem = false,
}: {
  currentPath: string;
  getIdToken?: () => Promise<string>;
  canOpenReport?: boolean;
  menuItem?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [category, setCategory] = useState<BugReportCategory>("bug");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; storedOnly: boolean } | null>(null);
  const [screenshot, setScreenshot] = useState<File | null>(null);

  useEffect(() => {
    if (receipt) dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="Close problem report"]')?.focus();
  }, [receipt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!getIdToken) {
      setError("Your session is not ready. Close this dialog and try again.");
      return;
    }
    const form = new FormData(formElement);
    const value = (name: string) => String(form.get(name) ?? "").trim();
    setPending(true);
    setError(null);
    try {
      const requestId = requestIdRef.current ?? crypto.randomUUID();
      requestIdRef.current = requestId;
      const token = await getIdToken();
      const response = await cmsSubmitBugReport(
        token,
        {
          category,
          severity: value("severity") as BugReportSeverity,
          area: value("area") as BugReportArea,
          tryingToDo: value("tryingToDo"),
          happened: value("happened"),
          expected: value("expected"),
          ...(value("steps") ? { steps: value("steps") } : {}),
          ...(value("workaround") ? { workaround: value("workaround") } : {}),
          consoleLogs: getConsoleLogs(),
          route: currentPath,
          ...(affectedRecord(currentPath)
            ? { affectedRecord: affectedRecord(currentPath) }
            : {}),
          clientContext: {
            browser: browserName(),
            operatingSystem: operatingSystem(),
            viewport: {
              width: Math.max(1, Math.round(window.innerWidth)),
              height: Math.max(1, Math.round(window.innerHeight)),
            },
            online: navigator.onLine,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            diagnostics: collectReportDiagnostics(),
          },
          correlationIds: reportCorrelationIds(adminPerf.receipt()),
        },
        requestId,
        screenshot,
      );
      requestIdRef.current = null;
      setScreenshot(null);
      formElement.reset();
      setCategory("bug");
      setReceipt({ id: response.report.id, storedOnly: response.report.environment?.deploymentEnvironment === "development" });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The report could not be sent.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        className="report-problem-launch"
        onClick={() => {
          setCategory("bug");
          setError(null);
          setReceipt(null);
          setScreenshot(null);
          requestIdRef.current = null;
          const dialog = dialogRef.current;
          if (dialog) {
            dialog.querySelector<HTMLFormElement>("form")?.reset();
            openModal(dialog);
            queueMicrotask(() => dialog.querySelector<HTMLTextAreaElement>("textarea")?.focus());
          }
        }}
        title="Report a problem"
        variant={menuItem ? "menu" : "ghost"}
      >
        <Icon name="flag" />
        <span>Report a problem</span>
      </Button>
      <dialog
        aria-labelledby="report-problem-title"
        className="report-problem-dialog"
        ref={dialogRef}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        onClose={() => {
          setError(null);
          setReceipt(null);
          setScreenshot(null);
          requestIdRef.current = null;
          dialogRef.current?.querySelector<HTMLFormElement>("form")?.reset();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !pending) closeModal(event.currentTarget);
        }}
      >
        <div className="report-problem-dialog-panel">
          <div className="report-problem-dialog-head">
            <div>
              <h2 id="report-problem-title">Report a problem</h2>
            </div>
            <Button
              aria-label="Close problem report"
              disabled={pending}
              onClick={() => dialogRef.current && closeModal(dialogRef.current)}
              variant="ghost"
            >
              <span aria-hidden="true">×</span>
            </Button>
          </div>

          {receipt ? (
            <InlineMessage className="report-problem-receipt" title="Report received" tone="success">
              <p>Your report ID is <strong className="report-problem-receipt-id">{receipt.id}</strong>.</p>
              <p>{receipt.storedOnly
                ? "Your report is saved in this test site. No confirmation email or updates will be sent."
                : "We will email a confirmation and updates to your staff email address."}</p>
              {canOpenReport && !receipt.storedOnly ? <p>
                <Link
                  to={reportsPath(receipt.id)}
                  onClick={() => dialogRef.current && closeModal(dialogRef.current)}
                >
                  Open this report
                </Link>
              </p> : null}
            </InlineMessage>
          ) : (
            <form className="report-problem-form" onSubmit={submit}>
              <p className="report-problem-intro">Found something broken, or have a suggestion? Tell us what happened and we will look into it.</p>
              <fieldset className="report-problem-categories">
                <legend>What kind of feedback is this?</legend>
                {([['bug', 'Bug or error'], ['suggestion', 'Suggestion'], ['question', 'Question']] as const).map(([id, label]) => (
                  <label key={id}>
                    <input type="radio" name="category" value={id} checked={category === id} onChange={() => setCategory(id)} />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              <label>
                <span>Tell us what happened</span>
                <Textarea name="happened" rows={4} minLength={10} maxLength={2000} required placeholder="Describe the issue, suggestion, or question." />
              </label>
              <details className="report-problem-more">
                <summary>More details <span>(optional)</span></summary>
                <div className="report-problem-extra-fields">
              <div className="report-problem-short-fields">
                <label>
                  <span>Severity</span>
                  <Select name="severity" required defaultValue="work_impaired">
                    <option value="blocker">Blocker</option>
                    <option value="work_impaired">Work impaired</option>
                    <option value="minor">Minor</option>
                  </Select>
                </label>
                <label>
                  <span>Area</span>
                  <Select name="area" required defaultValue="content_editing">
                    <option value="sign_in_access">Sign-in or access</option>
                    <option value="content_editing">Content editing</option>
                    <option value="save_revision">Save or revision</option>
                    <option value="review_publish">Review or publish</option>
                    <option value="media">Media</option>
                    <option value="navigation_ui">Navigation or interface</option>
                    <option value="other">Other</option>
                  </Select>
                </label>
              </div>
              <label>
                <span>What were you trying to do?</span>
                <Textarea name="tryingToDo" rows={2} maxLength={1000} />
              </label>
              <label>
                <span>What did you expect?</span>
                <Textarea name="expected" rows={2} maxLength={2000} />
              </label>
              <label>
                <span>Steps to reproduce <small>(optional)</small></span>
                <Textarea name="steps" rows={3} maxLength={3000} />
              </label>
              <label>
                <span>Workaround or recovery tried <small>(optional)</small></span>
                <Textarea name="workaround" rows={2} maxLength={2000} />
              </label>
                </div>
              </details>
              <label>
                <span>Screenshot <small>(optional, JPEG, PNG, or WebP; 5 MiB maximum)</small></span>
                <input
                  className="field-control"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    if (file && (!SCREENSHOT_TYPES.has(file.type) || file.size > MAX_SCREENSHOT_BYTES)) {
                      event.target.value = "";
                      setScreenshot(null);
                      setError("Choose one JPEG, PNG, or WebP screenshot no larger than 5 MiB.");
                      return;
                    }
                    setError(null);
                    setScreenshot(file);
                  }}
                />
              </label>
              {screenshot ? <p className="report-problem-attachment">Attached: {screenshot.name}</p> : null}
              <p className="report-problem-diagnostics-note">Browser details, recent requests, and console messages are included for the staff support team. Your CMS work stays open.</p>
              {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
              <div className="button-row">
                <AsyncActionButton
                  label="Send report"
                  pending={pending}
                  pendingLabel="Sending report"
                  type="submit"
                  variant="primary"
                />
                <Button
                  disabled={pending}
                  onClick={() => dialogRef.current && closeModal(dialogRef.current)}
                  variant="secondary"
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  );
}

declare global {
  interface Navigator {
    userAgentData?: { platform?: string };
  }
}
