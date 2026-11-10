declare const __CANONICAL_GITHUB_REPOSITORY__: string;

export interface AdminBuildStatus {
  revision: string;
  builtAt: string;
}

export interface AdminMilestoneStatus {
  number: number;
  title: string;
  state: "open" | "closed";
  openIssues: number;
  closedIssues: number;
  updatedAt: string;
  url: string;
}

interface AdminStatusBase {
  schemaVersion: 2;
  environment: string;
  generatedAt: string;
  refreshAfter: string;
}

export interface CurrentAdminStatusManifest extends AdminStatusBase {
  status: "current";
  build: AdminBuildStatus;
  milestone: AdminMilestoneStatus;
  milestones: AdminMilestoneStatus[];
}

export interface UnavailableAdminStatusManifest extends AdminStatusBase {
  status: "unavailable";
  build: null;
  milestone: null;
  milestones: null;
}

export type AdminStatusManifest =
  | CurrentAdminStatusManifest
  | UnavailableAdminStatusManifest;

export type AdminStatusDisplayState = "current" | "stale" | "unavailable";

function invalid(): never {
  throw new Error("The Admin status manifest is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function requiredString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    invalid();
  }
  return value;
}

function isoTimestamp(value: unknown): string {
  const timestamp = requiredString(value, 40);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    invalid();
  }
  return timestamp;
}

function issueCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function parseBuild(value: unknown): AdminBuildStatus {
  if (!isRecord(value) || !hasOnlyKeys(value, ["revision", "builtAt"])) invalid();
  const revision = requiredString(value.revision, 40);
  if (!/^[0-9a-f]{40}$/.test(revision)) invalid();
  return { revision, builtAt: isoTimestamp(value.builtAt) };
}

function parseMilestone(value: unknown, repository: string): AdminMilestoneStatus {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "number",
      "title",
      "state",
      "openIssues",
      "closedIssues",
      "updatedAt",
      "url",
    ])
  ) {
    invalid();
  }

  if (!Number.isSafeInteger(value.number) || (value.number as number) < 1) invalid();
  const number = value.number as number;
  const title = requiredString(value.title, 160);
  if (value.state !== "open" && value.state !== "closed") invalid();
  const url = requiredString(value.url, 240);
  let destination: URL;
  try {
    destination = new URL(url);
  } catch {
    invalid();
  }
  if (
    destination.protocol !== "https:" ||
    destination.hostname !== "github.com" ||
    destination.port !== "" ||
    destination.username !== "" ||
    destination.password !== "" ||
    destination.search !== "" ||
    destination.hash !== "" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    destination.pathname !== `/${repository}/milestone/${number}`
  ) {
    invalid();
  }

  return {
    number,
    title,
    state: value.state,
    openIssues: issueCount(value.openIssues),
    closedIssues: issueCount(value.closedIssues),
    updatedAt: isoTimestamp(value.updatedAt),
    url,
  };
}

export function parseAdminStatusManifest(value: unknown, repository =
  typeof __CANONICAL_GITHUB_REPOSITORY__ === "string" ? __CANONICAL_GITHUB_REPOSITORY__ : "",
): AdminStatusManifest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "status",
      "environment",
      "generatedAt",
      "refreshAfter",
      "build",
      "milestone",
      "milestones",
    ]) ||
    value.schemaVersion !== 2
  ) {
    invalid();
  }

  const environment = requiredString(value.environment, 40);
  const generatedAt = isoTimestamp(value.generatedAt);
  const refreshAfter = isoTimestamp(value.refreshAfter);
  if (Date.parse(refreshAfter) < Date.parse(generatedAt)) invalid();

  if (value.status === "unavailable") {
    if (
      value.build !== null ||
      value.milestone !== null ||
      value.milestones !== null
    ) invalid();
    return {
      schemaVersion: 2,
      status: "unavailable",
      environment,
      generatedAt,
      refreshAfter,
      build: null,
      milestone: null,
      milestones: null,
    };
  }
  if (value.status !== "current") invalid();

  if (
    !Array.isArray(value.milestones) ||
    value.milestones.length === 0 ||
    value.milestones.length > 100
  ) invalid();
  const milestones = value.milestones.map(value => parseMilestone(value, repository));
  if (new Set(milestones.map(({ number }) => number)).size !== milestones.length) {
    invalid();
  }
  const milestone = parseMilestone(value.milestone, repository);
  if (
    !milestones.some(
      (candidate) =>
        candidate.number === milestone.number &&
        JSON.stringify(candidate) === JSON.stringify(milestone),
    )
  ) invalid();

  return {
    schemaVersion: 2,
    status: "current",
    environment,
    generatedAt,
    refreshAfter,
    build: parseBuild(value.build),
    milestone,
    milestones,
  };
}

export function milestoneForNumber(
  manifest: CurrentAdminStatusManifest,
  milestoneNumber: number | null | undefined,
): AdminMilestoneStatus {
  return manifest.milestones.find(({ number }) => number === milestoneNumber) ??
    manifest.milestone;
}

export function classifyAdminStatus(
  manifest: AdminStatusManifest,
  now = Date.now(),
): AdminStatusDisplayState {
  if (manifest.status === "unavailable") return "unavailable";
  return now >= Date.parse(manifest.refreshAfter) ? "stale" : "current";
}

export async function fetchAdminStatus(
  idToken = "",
  fetcher: typeof fetch = fetch,
): Promise<AdminStatusManifest> {
  if (!idToken) throw new Error("The signed-in session is unavailable.");
  const response = await fetcher("/guide-content/admin-status.json", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json", Authorization: `Bearer ${idToken}` },
  });
  if (!response.ok) throw new Error("Admin status could not be loaded.");
  return parseAdminStatusManifest(await response.json());
}

// The public asset omits private milestones but carries the same reviewed build identity.
export async function fetchAdminBuildRevision(signal: AbortSignal): Promise<string | null> {
  const response = await fetch("/admin-status.json", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("Admin build could not be loaded.");
  const value: unknown = await response.json();
  if (!isRecord(value) || value.schemaVersion !== 2) invalid();
  if (value.status === "unavailable" && value.build === null) return null;
  if (value.status !== "current") invalid();
  return parseBuild(value.build).revision;
}
