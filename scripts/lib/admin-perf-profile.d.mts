export interface AdminPerfNetworkProfile {
  name: string;
  latencyMs: number;
  downloadKbps: number;
  uploadKbps: number;
}

export interface AdminPerfCpuProfile {
  name: string;
  rate: number;
}

export interface AdminPerfViewport {
  name: string;
  width: number;
  height: number;
}

export interface AdminPerfScenario {
  id: string;
  label: string;
  heading: string | null;
  path: string;
  /** Where the surface settles when the path redirects (Media opens its Images tab). */
  landingPath?: string;
  route: string;
  kind: "read" | "save";
  action?: "edit-and-save" | "inspect-restore-confirm";
  defaults?: Record<string, string>;
  requires?: string[];
}

export interface AdminPerfProfile {
  id: string;
  network: AdminPerfNetworkProfile;
  cpu: AdminPerfCpuProfile;
  viewports: readonly AdminPerfViewport[];
  samples: { cold: number; warm: number };
  readVisits: readonly string[];
  scenarios: readonly AdminPerfScenario[];
}

export const ADMIN_PERF_PROFILE: AdminPerfProfile;

export function networkConditions(profile?: AdminPerfProfile): {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
};

export function cpuThrottling(profile?: AdminPerfProfile): { rate: number };

export function scenarioIds(profile?: AdminPerfProfile): string[];

export function scenario(
  id: string,
  profile?: AdminPerfProfile,
): AdminPerfScenario;

export function scenarioPath(
  entry: AdminPerfScenario,
  values?: Record<string, string>,
): { path: string; missing: string[] };

export function surfaceLandingPath(entry: AdminPerfScenario, path?: string): string;

export function journeySource(path: string): {
  path: string;
  landingPath: string;
  heading: string | null;
};
