export interface ReportScreenDiagnostics {
  width: number;
  height: number;
  colorDepth: number;
  pixelRatio: number;
}

export interface ReportNavigationDiagnostics {
  type: string;
  ttfbMs: number;
  domContentLoadedMs: number;
  loadMs: number;
}

export interface ReportMemoryDiagnostics {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface ReportRequestDiagnostics {
  path: string;
  status: number;
  durationMs: number;
  initiatorType: string;
}

export interface BrowserDiagnostics {
  userAgent: string;
  language: string;
  screen: ReportScreenDiagnostics;
  sessionAgeMs: number;
  visibilityState: "visible" | "hidden";
  reducedMotion: boolean;
  hardwareConcurrency?: number;
  deviceMemoryGB?: number;
  navigation?: ReportNavigationDiagnostics;
  memory?: ReportMemoryDiagnostics;
  recentRequests: ReportRequestDiagnostics[];
}

const MAX_SESSION_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_MEMORY_BYTES = 2 ** 40;
const MAX_DEVICE_MEMORY_GB = 1_024;
const MAX_REQUESTS = 20;

let recordedRequests: ReportRequestDiagnostics[] = [];

function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") return "";
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (encoder.encode(`${result}${character}`).byteLength > maxBytes) break;
    result += character;
  }
  return result;
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback = minimum,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  return Math.trunc(boundedNumber(value, minimum, maximum));
}

export function recordReportRequest(
  endpoint: string,
  status: number,
  durationMs: number,
): void {
  try {
    const path = new URL(endpoint, "https://cms.internal").pathname;
    const entry: ReportRequestDiagnostics = {
      path: boundedText(path, 512),
      status: status === 0 ? 0 : boundedInteger(status, 100, 599),
      durationMs: boundedNumber(durationMs, 0, MAX_SESSION_MS, 0),
      initiatorType: "fetch",
    };
    recordedRequests = [...recordedRequests, entry].slice(-MAX_REQUESTS);
  } catch {
    // Diagnostics must not change the request that they observe.
  }
}

function performanceEntries(
  performanceApi: Performance | undefined,
  type: "navigation" | "resource",
): PerformanceEntry[] {
  if (!performanceApi || typeof performanceApi.getEntriesByType !== "function") return [];
  try {
    return performanceApi.getEntriesByType(type);
  } catch {
    return [];
  }
}

function navigationDiagnostics(
  performanceApi: Performance | undefined,
): ReportNavigationDiagnostics | undefined {
  const entry = performanceEntries(performanceApi, "navigation")[0] as
    | (PerformanceEntry & {
        type?: unknown;
        responseStart?: unknown;
        domContentLoadedEventEnd?: unknown;
        loadEventEnd?: unknown;
      })
    | undefined;
  if (!entry || typeof entry.type !== "string") return undefined;
  const startTime = boundedNumber(entry.startTime, 0, MAX_SESSION_MS, 0);
  const elapsed = (value: unknown) =>
    boundedNumber(
      typeof value === "number" ? value - startTime : value,
      0,
      MAX_SESSION_MS,
      0,
    );
  return {
    type: boundedText(entry.type, 32),
    ttfbMs: elapsed(entry.responseStart),
    domContentLoadedMs: elapsed(entry.domContentLoadedEventEnd),
    loadMs: elapsed(entry.loadEventEnd),
  };
}

function memoryDiagnostics(
  performanceApi: Performance | undefined,
): ReportMemoryDiagnostics | undefined {
  const memory = (performanceApi as (Performance & {
    memory?: {
      usedJSHeapSize?: unknown;
      totalJSHeapSize?: unknown;
      jsHeapSizeLimit?: unknown;
    };
  }) | undefined)?.memory;
  if (
    !memory ||
    typeof memory.usedJSHeapSize !== "number" ||
    typeof memory.totalJSHeapSize !== "number" ||
    typeof memory.jsHeapSizeLimit !== "number"
  ) {
    return undefined;
  }
  return {
    usedJSHeapSize: boundedNumber(memory.usedJSHeapSize, 0, MAX_MEMORY_BYTES),
    totalJSHeapSize: boundedNumber(memory.totalJSHeapSize, 0, MAX_MEMORY_BYTES),
    jsHeapSizeLimit: boundedNumber(memory.jsHeapSizeLimit, 0, MAX_MEMORY_BYTES),
  };
}

function recentRequestDiagnostics(
  performanceApi: Performance | undefined,
  locationApi: Location | undefined,
): ReportRequestDiagnostics[] {
  const recorded = recordedRequests.map((request) => ({ ...request }));
  if (!locationApi || recorded.length === MAX_REQUESTS) return recorded;
  const recordedPaths = new Set(recorded.map(({ path }) => path));
  const resources = performanceEntries(performanceApi, "resource")
    .flatMap((entry) => {
      const resource = entry as PerformanceEntry & {
        responseStatus?: unknown;
        initiatorType?: unknown;
      };
      if (
        !Number.isInteger(resource.responseStatus) ||
        (resource.responseStatus as number) < 100 ||
        (resource.responseStatus as number) > 599
      ) {
        return [];
      }
      try {
        const url = new URL(resource.name, locationApi.href);
        if (url.origin !== locationApi.origin || url.pathname.startsWith("//")) return [];
        return [{
          path: boundedText(url.pathname, 512),
          status: resource.responseStatus as number,
          durationMs: boundedNumber(resource.duration, 0, MAX_SESSION_MS, 0),
          initiatorType: boundedText(resource.initiatorType, 32),
        }];
      } catch {
        return [];
      }
    })
    .filter(({ path }) => !recordedPaths.has(path))
    .slice(-(MAX_REQUESTS - recorded.length));
  return [...resources, ...recorded];
}

export function collectReportDiagnostics(): BrowserDiagnostics {
  const browserWindow = typeof window === "undefined" ? undefined : window;
  const browserNavigator = typeof navigator === "undefined"
    ? undefined
    : navigator as Navigator & { deviceMemory?: unknown };
  const browserDocument = typeof document === "undefined" ? undefined : document;
  const performanceApi = typeof performance === "undefined" ? undefined : performance;
  const screenApi = browserWindow?.screen;

  let sessionAgeMs = 0;
  try {
    sessionAgeMs = boundedNumber(performanceApi?.now(), 0, MAX_SESSION_MS, 0);
  } catch {
    // Keep the required field deterministic when a partial browser API throws.
  }

  let reducedMotion = false;
  try {
    reducedMotion = browserWindow?.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ?? false;
  } catch {
    // An unavailable media-query API is equivalent to no reported preference.
  }

  const diagnostics: BrowserDiagnostics = {
    userAgent: boundedText(browserNavigator?.userAgent, 512),
    language: boundedText(browserNavigator?.language, 64),
    screen: {
      width: boundedInteger(screenApi?.width, 1, 10_000),
      height: boundedInteger(screenApi?.height, 1, 10_000),
      colorDepth: boundedInteger(screenApi?.colorDepth, 1, 64),
      pixelRatio: boundedNumber(browserWindow?.devicePixelRatio, 0.1, 10),
    },
    sessionAgeMs,
    visibilityState: browserDocument?.visibilityState === "hidden" ? "hidden" : "visible",
    reducedMotion,
    recentRequests: recentRequestDiagnostics(performanceApi, browserWindow?.location),
  };

  if (
    typeof browserNavigator?.hardwareConcurrency === "number" &&
    Number.isFinite(browserNavigator.hardwareConcurrency)
  ) {
    diagnostics.hardwareConcurrency = Math.min(
      1_024,
      Math.max(1, Math.trunc(browserNavigator.hardwareConcurrency)),
    );
  }
  if (
    typeof browserNavigator?.deviceMemory === "number" &&
    Number.isFinite(browserNavigator.deviceMemory)
  ) {
    diagnostics.deviceMemoryGB = boundedNumber(
      browserNavigator.deviceMemory,
      0,
      MAX_DEVICE_MEMORY_GB,
    );
  }

  const navigation = navigationDiagnostics(performanceApi);
  if (navigation) diagnostics.navigation = navigation;
  const memory = memoryDiagnostics(performanceApi);
  if (memory) diagnostics.memory = memory;
  return diagnostics;
}
