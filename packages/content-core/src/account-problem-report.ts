const CONTACT_URL = "https://njpbs.org/contact/";
const REPORT_HASH = "#report-a-problem";
const CODE_PARAM = "account-error";

// These codes describe service failures, independent of the account or input.
const REPORT_CODES = [
  "account-service-unavailable",
  "auth/internal-error",
  "auth/network-request-failed",
  "auth/operation-not-allowed",
  "auth/too-many-requests",
  "auth/unauthorized-domain",
] as const;

export function accountProblemReportUrl(code?: unknown): string {
  const url = new URL(CONTACT_URL);
  if (typeof code === "string" && (REPORT_CODES as readonly string[]).includes(code)) {
    url.searchParams.set(CODE_PARAM, code);
  }
  url.hash = REPORT_HASH;
  return url.href;
}

export function normalizeAccountProblemReportUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (`${url.origin}${url.pathname}` !== CONTACT_URL || !url.searchParams.has(CODE_PARAM)) {
    return value;
  }
  const codes = url.searchParams.getAll(CODE_PARAM);
  return accountProblemReportUrl(codes.length === 1 ? codes[0] : undefined);
}
