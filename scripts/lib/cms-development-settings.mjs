import inputManifest from "../../config/development-inputs.json" with { type: "json" };
import { CmsTargetError, devName, devOrigin } from "./cms-target.mjs";

// The signed-in smoke opens this path on the target's own Admin.
export const editorPath = /^\/content\/(?:pages|post)\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/edit$/;

// One check before a development deploy: every value that a production value
// could replace. It names the failing settings and never prints a value.
export function assertDevelopmentSettings(env, variables) {
  const faults = [];
  const expect = (holds, text) => { if (!holds) faults.push(text); };
  const admit = check => { try { check(); } catch (error) { faults.push(error.message); } };
  for (const [key, { kind }] of Object.entries(inputManifest.inputs)) {
    if (key.includes("_DEV_")) admit(() => (kind === "origin" ? devOrigin : devName)(env, key));
  }
  if (env.CMS_DEV_STUDIO_BUCKET) admit(() => devName(env, "CMS_DEV_STUDIO_BUCKET"));
  // The dev project's own web app, recorded under names that production does not use.
  for (const [key, dev] of [["VITE_FIREBASE_API_KEY", "FIREBASE_DEV_WEB_API_KEY"], ["VITE_FIREBASE_APP_ID", "CMS_DEV_FIREBASE_WEB_APP_ID"],
    ["VITE_FIREBASE_APPCHECK_SITE_KEY", "FIREBASE_DEV_APPCHECK_SITE_KEY"]]) {
    // config-input: VITE_FIREBASE_API_KEY, VITE_FIREBASE_APP_ID, VITE_FIREBASE_APPCHECK_SITE_KEY
    // config-input: FIREBASE_DEV_WEB_API_KEY, FIREBASE_DEV_APPCHECK_SITE_KEY, CMS_DEV_FIREBASE_WEB_APP_ID
    expect(env[dev]?.trim() && env[key]?.trim() === env[dev].trim(), `${key} must equal ${dev}`);
  }
  if (env.CMS_PREVIEW_SMOKE_TARGET) {
    let editor;
    try { ({ editor } = JSON.parse(env.CMS_PREVIEW_SMOKE_TARGET)); } catch { /* reported below */ }
    expect(typeof editor === "string" && editorPath.test(editor), "CMS_PREVIEW_SMOKE_TARGET must hold an editor path only");
  }
  for (const key of ["AUTHOR_PAGES_LIVE", "VITE_VIDEO_REPLACEMENT_ENABLED"]) {
    // config-input: AUTHOR_PAGES_LIVE, VITE_VIDEO_REPLACEMENT_ENABLED
    expect([undefined, "false", variables[key]].includes(env[key]), `${key} must come from the development environment`);
  }
  if (faults.length) throw new CmsTargetError(`The development deploy was refused:\n- ${faults.join("\n- ")}`);
}
