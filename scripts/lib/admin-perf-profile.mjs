// A fixed Admin benchmark profile makes receipts comparable across changes.
// Network conditions are 150 ms latency, 1.6 Mbps down and 750 Kbps up. A fixed
// 4x CPU throttle gives each receipt an explicit device class.

const KILOBIT = 1000;
const BITS_PER_BYTE = 8;

function bytesPerSecond(kbps) {
  return (kbps * KILOBIT) / BITS_PER_BYTE;
}

export const ADMIN_PERF_PROFILE = Object.freeze({
  id: "njpbs-admin-baseline-2026-08",
  network: Object.freeze({
    name: "njpbs-constrained-1017",
    latencyMs: 150,
    downloadKbps: 1600,
    uploadKbps: 750,
  }),
  // Chrome DevTools' own "4x slowdown" preset, named so a receipt states the device class
  // it passed on instead of implying every machine.
  cpu: Object.freeze({ name: "modest-desktop-4x", rate: 4 }),
  viewports: Object.freeze([
    Object.freeze({ name: "desktop-1440", width: 1440, height: 900 }),
    Object.freeze({ name: "mobile-390", width: 390, height: 844 }),
  ]),
  // Save scenarios retain cold/warm mutation samples. Read scenarios use the journey names
  // below so refresh, a new-page return, in-app navigation, and browser history restoration
  // are separate facts rather than one ambiguous "warm" number.
  samples: Object.freeze({ cold: 1, warm: 1 }),
  readVisits: Object.freeze([
    "first-signed-in-load",
    "refresh",
    "return-visit",
    "in-app-navigation",
    "history-back",
    "history-forward",
  ]),
  scenarios: Object.freeze([
    Object.freeze({
      id: "dashboard",
      label: "Newsroom home",
      heading: "Newsroom home",
      path: "/",
      route: "dashboard",
      kind: "read",
    }),
    Object.freeze({
      id: "content-library",
      label: "Content library",
      heading: null,
      path: "/content/library",
      route: "content",
      kind: "read",
    }),
    Object.freeze({
      id: "page-editor",
      label: "Representative page editor",
      heading: null,
      path: "/content/pages/{pageId}/edit",
      route: "content",
      kind: "read",
      defaults: { pageId: "home" },
    }),
    Object.freeze({
      id: "post-editor",
      label: "Representative Post editor",
      heading: null,
      path: "/content/post/{postId}/edit",
      route: "content",
      kind: "read",
      requires: ["postId"],
    }),
    Object.freeze({
      id: "media-library",
      label: "Media library",
      heading: "Media library",
      // The rail link is /media, which redirects to the Images tab. The harness clicks the
      // link and waits on the landing path, so refresh and history visits can capture.
      path: "/media",
      landingPath: "/media/images",
      route: "media",
      kind: "read",
    }),
    Object.freeze({
      id: "activity",
      label: "Activity",
      heading: "Activity",
      path: "/activity",
      route: "activity",
      kind: "read",
    }),
    Object.freeze({
      id: "publish-queue",
      label: "Editorial queue",
      heading: "Editorial queue",
      path: "/publish-queue",
      route: "queue",
      kind: "read",
    }),
    Object.freeze({
      id: "reports",
      label: "Reports",
      heading: "Reports",
      path: "/reports",
      route: "reports",
      kind: "read",
    }),
    Object.freeze({
      id: "admin-settings",
      label: "Admin settings",
      heading: "Admin settings",
      path: "/admin/settings",
      route: "admin-settings",
      kind: "read",
    }),
    Object.freeze({
      id: "account-settings",
      label: "Account settings",
      heading: "Account settings",
      path: "/account/settings",
      route: "account-settings",
      kind: "read",
    }),
    Object.freeze({
      id: "account-profile",
      label: "Your profile",
      heading: "Your profile",
      path: "/account/profile",
      route: "account-profile",
      kind: "read",
    }),
    Object.freeze({
      id: "author-profiles",
      label: "Staff profiles",
      heading: "Staff profiles",
      path: "/staff-profiles",
      route: "author-profiles",
      kind: "read",
    }),
    Object.freeze({
      id: "staff-access",
      label: "Staff access",
      heading: "Staff access",
      path: "/staff-access",
      route: "staff-access",
      kind: "read",
    }),
    // A save scenario has to perform the mutation it claims to time. Clicking a save control
    // on a page nobody edited measures a disabled button, so `edit-and-save` makes a real
    // dirty edit first; and a restore is a three-step sequence in the revision panel, not one
    // button, so `inspect-restore-confirm` walks all of it. The harness implements each named
    // action and reports `not-captured` with a reason when the sequence cannot be completed.
    Object.freeze({
      id: "save-normal",
      label: "Normal save",
      heading: null,
      path: "/content/post/{postId}/edit",
      route: "content",
      kind: "save",
      action: "edit-and-save",
      requires: ["postId"],
    }),
    Object.freeze({
      id: "save-restore",
      label: "Restore save",
      heading: null,
      path: "/content/post/{postId}/edit",
      route: "content",
      kind: "save",
      action: "inspect-restore-confirm",
      requires: ["postId"],
    }),
  ]),
});

// Chrome DevTools Protocol units: latency in milliseconds, throughput in bytes per second.
export function networkConditions(profile = ADMIN_PERF_PROFILE) {
  return {
    offline: false,
    latency: profile.network.latencyMs,
    downloadThroughput: bytesPerSecond(profile.network.downloadKbps),
    uploadThroughput: bytesPerSecond(profile.network.uploadKbps),
  };
}

export function cpuThrottling(profile = ADMIN_PERF_PROFILE) {
  return { rate: profile.cpu.rate };
}

export function scenarioIds(profile = ADMIN_PERF_PROFILE) {
  return profile.scenarios.map((entry) => entry.id);
}

export function scenario(id, profile = ADMIN_PERF_PROFILE) {
  const found = profile.scenarios.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown Admin benchmark scenario: ${id}`);
  return found;
}

// Fill a scenario's path from the operator-supplied ids. A scenario that needs an id the
// run did not supply says so rather than benchmarking a not-found route and reporting the
// number as an editor path.
export function scenarioPath(entry, values = {}) {
  const supplied = {
    ...(entry.defaults ?? {}),
    ...Object.fromEntries(
      Object.entries(values).filter(
        ([, value]) => typeof value === "string" && value !== "",
      ),
    ),
  };
  const missing = [];
  const path = entry.path.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = supplied[key];
    if (typeof value !== "string" || value === "") {
      missing.push(key);
      return `{${key}}`;
    }
    return encodeURIComponent(value);
  });
  return { path, missing };
}

// Where a scenario's surface settles. Most land on their own path; Media redirects to its
// Images tab.
export function surfaceLandingPath(entry, path = entry.path) {
  return entry.landingPath ?? path;
}

// The stable page an in-app journey starts from before it clicks the scenario's link. A
// document boot at `/` can restore the tab's remembered destination after admission, so
// sources are non-root routes. Reports itself needs a different source to create a history
// entry; that source is Media, which lands on its Images tab.
export function journeySource(path) {
  const source = (linkPath, heading, landingPath = linkPath) => ({ path: linkPath, landingPath, heading });
  if (path === "/") return source("/content/library", null);
  if (path.startsWith("/content/pages/")) return source("/content", null);
  if (path.startsWith("/content/post/")) return source("/content/post", null);
  return path === "/reports"
    ? source("/media", "Media library", surfaceLandingPath(scenario("media-library")))
    : source("/reports", "Reports");
}
