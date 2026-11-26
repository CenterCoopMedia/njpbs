// A step whose failure can follow from an earlier one. On development it still runs, so one run shows every fault.
// Production skips it: a new Admin or API must not go live over handlers that failed to deploy, and a new
// renderer or Studio connector must not go live over old Functions (Nov. 25, 2026: previews answered 503 for hours).
export const after = { render: ["install"], "functions-build": ["install", "render"], seed: ["install"], firebase: ["install", "functions-build", "seed"],
  "event-grants": ["firebase"], "cms-api": ["render", "install", "firebase"], renderer: ["install", "render", "firebase"],
  studio: ["install", "firebase"], "admin-build": ["install", "render"], "admin-deploy": ["admin-build", "firebase", "cms-api"], "admin-shell": ["install", "admin-deploy"],
  smoke: ["firebase", "cms-api", "renderer", "admin-deploy", "seed"] };

/** The failed steps that stop `name` from running. The smoke always runs: it reports what it meets. */
export function blockedBy(name, failed, dev) {
  return dev || name === "smoke" ? [] : (after[name] ?? []).filter(step => failed.includes(step));
}
