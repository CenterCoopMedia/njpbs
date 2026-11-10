import { readCmsDeployWorkflow } from "../helpers/cms-deploy-workflow.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Enforces the invariant functions/.env.local states in its own header: every
// non-secret param is represented there, so emulator runs stay non-interactive.
//
// It lives in tests/preflight rather than tests/functions, and that placement is
// the point. tests/functions runs inside `firebase emulators:exec`, which means
// it only executes after the emulator has already resolved params -- the exact
// step this guards. A missing param would hang discovery and Vitest would never
// start, so a guard in there could never fire in the case it exists for. The
// `pretest:functions` script runs this first, before any emulator boots.
//
// firebase-tools resolves params during discovery, and the functions emulator
// asks for that resolution with nonInteractive: false. A param counts as
// resolved only when it has a value in the loaded dotenv files -- resolveParams
// partitions on `hasOwnProperty.call(userEnvs, param.name)`. A declared
// `default` does NOT satisfy it; the default is only the pre-filled answer to
// the prompt that still gets raised. So a promptable param missing from
// .env.local becomes an interactive prompt that `emulators:exec` has nobody to
// answer, and the run hangs with no error immediately after the functions.yaml
// discovery line -- the stall in #428.
//
// Secret params are exempt: params.js skips them entirely when isEmulator is
// true, which is why CMS_PUBLISH_GITHUB_TOKEN and
// BILLING_ALERT_TOKEN are unset locally without breaking anything.
//
// The check covers every .js file under functions/ rather than only the modules
// index.js currently exports. Discovery loads the exported set, so an unexported
// module's params cannot hang a run today, but wiring one up is a one-line
// export, and a coverage rule that silently stops applying at that moment is
// worse than one that is slightly early. Same reason the walk recurses into
// lib/: no param lives there yet, and a rule with an invisible edge is the thing
// this is trying to avoid.
//
// It scans source text rather than reading firebase-functions' own
// declaredParams registry, which tests/functions/billing.test.js does use.
// Populating that registry requires the modules, and functions/lib/firebase.js
// calls admin.initializeApp() and admin.firestore() at module load, so every
// route into it drags firebase-admin up with it. A preflight whose whole job is
// to run offline in under a second, before any emulator exists, must not be
// initializing an SDK. Scanning text keeps it inert; do not "simplify" this back
// into a require.

const FUNCTIONS_DIR = fileURLToPath(new URL("../../functions/", import.meta.url));

// Secrets are exempt; these are the kinds that reach the prompt.
const PROMPTABLE = ["String", "Int", "Float", "Boolean", "List"];

// Walks forward from the opening paren of a define*() call and returns its
// argument text, so a nested options object cannot end the match early. Cheaper
// and more honest than a regex that pretends JS is regular.
function callArgs(source, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses after index ${openParenIndex}`);
}

// index.js documents its deferred exports in prose that names the very calls
// this scan looks for, so a commented-out declaration must not count as real.
// Detected by inspecting the match's own line rather than by stripping comments
// globally: a default value like "https://notify.example.org/alert" contains a
// "//" that naive stripping would corrupt.
function isCommentedOut(source, matchIndex) {
  const lineStart = source.lastIndexOf("\n", matchIndex) + 1;
  const linePrefix = source.slice(lineStart, matchIndex).trimStart();
  return linePrefix.startsWith("//") || linePrefix.startsWith("*");
}

function declaredParams(source) {
  const pattern = new RegExp(`\\bdefine(${PROMPTABLE.join("|")})\\s*\\(`, "g");
  return [...source.matchAll(pattern)]
    .filter((match) => !isCommentedOut(source, match.index))
    .map((match) => {
      const args = callArgs(source, match.index + match[0].length - 1);
      const name = args.match(/^\s*"([^"]+)"/);
      return { kind: match[1], name: name ? name[1] : "<unparsed>" };
    });
}

function dotenvKeys(text) {
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split("=")[0].trim()),
  );
}

// Hand-rolled rather than readdirSync({ recursive: true }) so node_modules is
// skipped: functions/ has no install today, but one appears the moment someone
// runs npm install there, and walking it would be slow and meaningless.
function jsFilesUnder(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") return [];
      return jsFilesUnder(join(dir, entry.name), `${prefix}${entry.name}/`);
    }
    return entry.name.endsWith(".js") ? [`${prefix}${entry.name}`] : [];
  });
}

describe("function params stay non-interactive", () => {
  const sources = jsFilesUnder(FUNCTIONS_DIR).map((file) => ({
    file,
    source: readFileSync(join(FUNCTIONS_DIR, file), "utf8"),
  }));
  const localEnv = dotenvKeys(
    readFileSync(new URL("../../scripts/fixtures/functions-emulator.env.example", import.meta.url), "utf8"),
  );

  it("declares every promptable param in .env.local before emulators start", () => {
    const all = sources.flatMap(({ file, source }) => declaredParams(source).map(param => ({ file, ...param })));
    expect(all.length).toBeGreaterThan(0);
    expect(all.every(param => param.name !== "<unparsed>"), "Every promptable declaration must parse").toBe(true);
    for (const { file, source } of sources) {
      const params = declaredParams(source);
      const uncovered = params
        .filter(param => !localEnv.has(param.name))
        .map(param => `define${param.kind}("${param.name}")`);
      expect(
        uncovered,
        `${file}: add these to scripts/fixtures/functions-emulator.env.example. A declared default does not prevent ` +
          "the prompt, so without an entry there the functions emulator stalls " +
          "after discovery instead of failing (#428)",
      ).toEqual([]);
      for (const param of params) expect(param.name, `${file}: define${param.kind} name must parse`).not.toBe("<unparsed>");
    }
  });
});


it("binds every S3 runtime parameter through the native configuration table", async () => {
  const { CONFIGURATION_INPUTS, RUNTIME_PARAMETERS } = await import("../../scripts/lib/functions-configuration.mjs");
  const names = Object.keys(RUNTIME_PARAMETERS).filter(name => name.startsWith("CMS_MEDIA_AWS_"));
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(CONFIGURATION_INPUTS[RUNTIME_PARAMETERS[name].input].variable).toBe(name);
});
