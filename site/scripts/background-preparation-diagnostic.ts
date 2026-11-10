const MAX_BYTES = 2048;
const REDACTED = "[redacted]";
const processCodes = new Set(["ENOENT", "EACCES", "EPERM", "EROFS", "ENOSPC", "ENOMEM", "EIO", "EMFILE", "ENFILE", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);
const stages = new Set(["source_checkout", "sandbox_setup", "renderer", "renderer_start", "artifact_input", "astro_build",
  "pagefind", "artifact_inventory", "artifact_receipt", "restore_prepared", "restore_input", "freeze_input",
  "checkpoint_input", "preview_projection", "collect_family_files", "checkpoint_prepared", "verify_prepared", "family_recovery"]);
const publicRuntimeFields = new Set(["PATH", "NODE_ENV", "TZ", "GITHUB_JOB", "ASTRO_TELEMETRY_DISABLED", "CMS_LOADER_STRICT",
  "CMS_CONTENT_MODE", "CMS_DEPLOYMENT_ENVIRONMENT", "PUBLIC_ARTIFACT_BATCH_MODE", "PUBLIC_POST_RENDERER_COMPILE"]);

const childStages: Record<string, string> = {
  firestore_artifact_read_complete: "artifact_input",
  astro_build_started: "astro_build", astro_build_complete: "astro_build",
  pagefind_started: "pagefind", pagefind_complete: "artifact_inventory",
  artifact_inventory_complete: "artifact_inventory",
};

export function backgroundRendererStage(stdout: string): string {
  let stage = "renderer_start";
  for (const line of stdout.split("\n")) {
    try {
      const row = JSON.parse(line);
      if (row?.event === "cms_public_build_timing" && Object.hasOwn(childStages, row.stage)) stage = childStages[row.stage];
    } catch { /* Ordinary build output is not a stage marker. */ }
  }
  return stage;
}

function sanitizedText(text: string, environment: Record<string, string | undefined>): string {
  // Redact before taking a tail, so a bound cannot split a credential and
  // leave its suffix visible. Child output is capped by execFile's maxBuffer.
  let safe = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  safe = safe
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, REDACTED)
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\n]*/gi, REDACTED)
    .replace(/\b(?:bearer|basic)\s+\S+/gi, REDACTED)
    .replace(/\b[\w.-]*(?:secret|token|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/gi, REDACTED)
    .replace(/\b[A-Z][A-Z0-9_]*=(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/g, REDACTED)
    .replace(/["'][A-Z][A-Z0-9_]*["']\s*:\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;}]+)/g, REDACTED)
    .replace(/\b(?:gh[pousr]_|github_pat_|AIza|AKIA|xox[baprs]-|sk-)[A-Za-z0-9._-]+/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/(?<![\w/.-])[A-Za-z0-9_+=-]{24,}(?![\w/.-])/g, REDACTED)
    .replace(/["'][A-Za-z0-9_+/=-]{24,}["']/g, REDACTED);
  // Environment dumps are removed above regardless of value length. Public
  // runtime literals and unlabelled short non-secret values are also ordinary error
  // text (line numbers, modes, paths), so do not erase their unrelated uses.
  const sensitiveField = /secret|token|password|passwd|credential|key/i;
  const values = new Set(Object.entries(environment).filter(([field, value]) => value &&
    (sensitiveField.test(field) || (!publicRuntimeFields.has(field) && value.length >= 4 && !/^\d+$/.test(value))))
    .map(([, value]) => value as string));
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])) {
      safe = safe.split(variant).join(REDACTED);
    }
  }
  return safe;
}

export class BackgroundPreparationError extends Error {
  constructor(readonly diagnostic: string) {
    super("Background preparation failed");
    this.name = "BackgroundPreparationError";
  }
}

export function backgroundPreparationDiagnostic(error: unknown, stage: string,
  environment: Record<string, string | undefined>, stderr?: string): string {
  if (error instanceof BackgroundPreparationError) return error.diagnostic;
  const child = error as { code?: unknown; signal?: unknown } | null;
  const exitCode = stderr !== undefined && Number.isSafeInteger(child?.code) ? child!.code : null;
  const signal = typeof child?.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(child.signal) ? child.signal : null;
  const failureCode = typeof child?.code === "string" && processCodes.has(child.code) ? child.code : null;
  const message = stderr ?? (error instanceof Error ? error.message : "Unknown preparation failure");
  let tail = sanitizedText(message, { ...process.env, ...environment }).trim().split("\n").slice(-12).join("\n");
  const record = () => JSON.stringify({ stage: stages.has(stage) ? stage : "preparation", exitCode, signal, failureCode, stderr: tail });
  // JSON escaping counts toward the same byte bound. Remove complete Unicode
  // code points from the front while preserving the most recent diagnostic.
  if (Buffer.byteLength(tail) > MAX_BYTES) tail = Array.from(tail).slice(-MAX_BYTES).join("");
  const points = Array.from(tail);
  let start = 0;
  while (Buffer.byteLength(record()) > MAX_BYTES) tail = points.slice(++start).join("");
  return record();
}
