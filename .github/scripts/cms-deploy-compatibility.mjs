// Dependency-free compatibility gate for selected full-stack CMS deploy trees.
//
// The workflow loads this file from its current trusted revision. The selected
// deploy tree supplies only data: a versioned marker, Firestore rules and content catalogs. This
// keeps a historical deploy_ref from restoring rules that cannot read or release
// editor-lock documents written by the current Admin client.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const previewPair = () => createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");

// Schema-two boundary adapter: callers must explicitly supply the provider-backed
// bridge/readback transport and its retained reader requirements. This module
// does not select or activate a transport.
export async function verifyVersionedCmsReaders({ cmsSourceSha, readLiveState, replayDeployedReader }) {
  if (!/^[a-f0-9]{40}$/.test(cmsSourceSha) || typeof readLiveState !== "function" ||
      typeof replayDeployedReader !== "function") throw new Error("Versioned CMS reader transport is required");
  const state = await readLiveState();
  if (state?.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(state.publicSelectorDigest) ||
      !Array.isArray(state.publicPairs) || state.publicPairs.length !== 2 ||
      !Array.isArray(state.previewPairs) || state.previewPairs.length !== 2) throw new Error("Live retained contracts are required");
  const requirements = state.previewPairs.map(pair => previewPair().parsePair(pair).requirements);
  for (const pair of state.publicPairs) {
    if (!/^[a-f0-9]{64}$/.test(pair?.pairDigest) || !pair.requirements ||
        Object.keys(pair.requirements).length !== previewPair().CONTRACT_KEYS.length ||
        previewPair().CONTRACT_KEYS.some(key => !Number.isSafeInteger(pair.requirements[key]) || pair.requirements[key] < 1)) {
      throw new Error("Public retained reader requirements are invalid");
    }
    requirements.push(pair.requirements);
  }
  const replays = {};
  for (const component of ["functions", "cmsApi"]) {
    const reader = previewPair().currentReader(state.readers?.[component], component);
    for (const required of requirements) {
      if (previewPair().CONTRACT_KEYS.some(key => !reader.supported[key].includes(required[key]))) {
        throw new Error("Deployed CMS reader cannot retain the public and preview contracts");
      }
    }
    // The deployed endpoint runs Post decisions with frozen settings/chrome and
    // capability markers. Catalog equality or ancestry cannot satisfy this.
    const result = await replayDeployedReader({ component, reader, state });
    if (!/^[a-f0-9]{64}$/.test(result?.digest) || result.readerDigest !== previewPair().digest(reader) ||
        result.stateDigest !== previewPair().digest(state)) throw new Error("Deployed reader replay did not bind the live receipts");
    replays[component] = result.digest;
  }
  if (previewPair().digest(await readLiveState()) !== previewPair().digest(state)) throw new Error("Live CMS contracts changed during replay");
  return { schemaVersion: 2, candidateSourceSha: cmsSourceSha, stateDigest: previewPair().digest(state), replays,
    readerDigests: Object.fromEntries(["functions", "cmsApi"].map(component => [component,
      previewPair().digest(previewPair().currentReader(state.readers[component], component))])) };
}

export const CMS_DEPLOY_COMPATIBILITY_MANIFEST =
  ".github/cms-deploy-compatibility.json";
export const CMS_DEPLOY_COMPATIBILITY_SCHEMA_VERSION = 1;
// Tier accounts have no legacy editorial grants. Rules before version 6 cannot
// grant or release their leases, so a rollback must preserve tier authority.
export const CMS_EDITOR_LOCK_CONTRACT_FLOOR = 6;

const TRUSTED_EDITOR_LOCK_RULE_DIGESTS = new Map([
  [2, "4f4958ba2314e34be62048a90abe4440d51e6672828f30b77245242a8228201e"],
  [3, "2dc1101f11f4ab977007b30102935c4fd79d934cb3e45e678833b561dc3b7b9b"],
  [4, "fc1d2fc9776171daa5a760825cbbf467b52d9d4ca4d4442368af62b9bd410bdd"],
  [5, "d3ca404be4b0137cf0ac3671c78752c8fcafcddef1aa07dc10c18ba232c77178"],
  [6, "02783f03332eb5ddf7cfb5824d1fa1b98a74c0c2489d4a2d3ffc229bc322edbf"],
  [7, "3048dfea0df167e47f7c96f2926a6aca539f78f6e7b3bba2fa788400cc9bad11"],
  [8, "3f61d2c305a0ede8f9af79df3efe764484b9e5b7d073619c839de3116f8113ed"],
  [9, "2f1df1d48c2d1837f7ba22028c508450f2a162d3c24174c66c1e8ab3e11c2df7"],
]);

const EDITOR_LOCK_RULE_BLOCKS = [
  ["staff session", "function hasValidStaffSession("],
  ["field protection", "function touchesPrivilegeKeys("],
  ["administrative authority", "function effectiveAdminRole("],
  ["tier activation", "function accessTierReadsActive("],
  ["tier selection", "function usesAccessTier("],
  ["activation evidence", "match /system/staffAccessActivation"],
  ["edit-any authority", "function hasEditorLockEditAny("],
  ["site-wide contributor authority", "function isSiteWideContributor("],
  ["address", "function validEditorLockAddress("],
  ["absent address", "function absentEditorLockAddress("],
  ["absent lease read", "function canObserveAbsentEditorLock("],
  ["request keys", "function editorLockRequestKeys("],
  ["request shape", "function validEditorLockRequest("],
  ["request-only diff", "function editorLockUnchangedExceptRequest("],
  ["request change", "function isEditorLockRequestChange("],
  ["lease shape", "function validEditorLockShape("],
  ["legacy address", "function validLegacyEditorLockAddress("],
  ["legacy lease", "function validLegacyEditorLockData("],
  ["legacy release", "function validLegacyEditorLockReleaseData("],
  ["create-eligible page", "function isCreateEligibleEditorLockPage("],
  ["contributor authority", "function contributorCanUseEditorLock("],
  ["lease authority", "function canUseEditorLock("],
  ["takeover authority", "function canForceEditorLockTakeover("],
  ["addressed lease", "function validEditorLockData("],
  ["addressed release", "function validEditorLockReleaseData("],
  ["stored release", "function storedEditorLockIsReleased("],
  ["editor-lock match", "match /cmsEditorLocks/{lockId}"],
];

function plainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function stripComments(source) {
  let out = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function canonicalRuleBlock(source, label, token) {
  const start = source.indexOf(token);
  if (start === -1) {
    throw new Error(`firestore.rules is missing the ${label} contract block`);
  }
  if (source.indexOf(token, start + token.length) !== -1) {
    throw new Error(`firestore.rules repeats the ${label} contract block`);
  }
  const opening = source.indexOf("{", start + token.length);
  if (opening === -1) {
    throw new Error(`firestore.rules has an incomplete ${label} contract block`);
  }

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      return source.slice(start, index + 1).replace(/\s+/g, "");
    }
  }
  throw new Error(`firestore.rules has an incomplete ${label} contract block`);
}

export function cmsEditorLockRulesDigest(source, version = 9) {
  const uncommented = stripComments(source);
  // Historical contracts retain their original block set and trusted digests.
  const blocks = version >= 9
    ? [["session age", "function maxSessionAgeSeconds("], ...EDITOR_LOCK_RULE_BLOCKS]
    : EDITOR_LOCK_RULE_BLOCKS;
  const contract = blocks.map(([label, token]) =>
    canonicalRuleBlock(uncommented, label, token),
  ).join("\n");
  return createHash("sha256").update(contract).digest("hex");
}

export function validateCmsDeployCompatibility(repoRoot) {
  const root = resolve(repoRoot);
  const manifestPath = join(root, CMS_DEPLOY_COMPATIBILITY_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${CMS_DEPLOY_COMPATIBILITY_MANIFEST} is missing or invalid: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  if (!plainObject(manifest)) {
    throw new Error(`${CMS_DEPLOY_COMPATIBILITY_MANIFEST} must be an object`);
  }
  if (manifest.schemaVersion !== CMS_DEPLOY_COMPATIBILITY_SCHEMA_VERSION) {
    throw new Error(
      `${CMS_DEPLOY_COMPATIBILITY_MANIFEST} must use schemaVersion ${CMS_DEPLOY_COMPATIBILITY_SCHEMA_VERSION}`,
    );
  }
  if (!plainObject(manifest.contracts)) {
    throw new Error(
      `${CMS_DEPLOY_COMPATIBILITY_MANIFEST} must define contracts`,
    );
  }
  const editorLocks = manifest.contracts.cmsEditorLocks;
  if (!plainObject(editorLocks) || !Number.isSafeInteger(editorLocks.version)) {
    throw new Error(
      `${CMS_DEPLOY_COMPATIBILITY_MANIFEST} must define an integer cmsEditorLocks version`,
    );
  }
  if (editorLocks.version < CMS_EDITOR_LOCK_CONTRACT_FLOOR) {
    throw new Error(
      `cmsEditorLocks contract version ${editorLocks.version} predates required floor ${CMS_EDITOR_LOCK_CONTRACT_FLOOR}`,
    );
  }
  const trustedDigest = TRUSTED_EDITOR_LOCK_RULE_DIGESTS.get(editorLocks.version);
  if (!trustedDigest) {
    throw new Error(
      `cmsEditorLocks contract version ${editorLocks.version} is not supported by this trusted workflow revision`,
    );
  }
  if (editorLocks.firestoreRulesSha256 !== trustedDigest) {
    throw new Error(
      `${CMS_DEPLOY_COMPATIBILITY_MANIFEST} does not declare the trusted cmsEditorLocks rules digest`,
    );
  }

  const rulesDigest = cmsEditorLockRulesDigest(
    readFileSync(join(root, "firestore.rules"), "utf8"),
    editorLocks.version,
  );
  if (rulesDigest !== trustedDigest) {
    throw new Error(
      "firestore.rules does not satisfy the declared cmsEditorLocks lease and release contract",
    );
  }
  return {
    manifestSchemaVersion: manifest.schemaVersion,
    editorLockContractVersion: editorLocks.version,
    firestoreRulesSha256: rulesDigest,
  };
}

function readLiteralCatalog(source, name) {
  const declarations = [...stripComments(source).matchAll(new RegExp(
    `^export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]\\s+as\\s+const\\s*;`, "gm",
  ))];
  if (declarations.length !== 1) {
    throw new Error(`Cannot verify the ${name} literal catalog`);
  }
  const entries = declarations[0][1].trim().replace(/,$/, "").split(",");
  const values = entries.map((entry) => {
    const literal = /^(["'])([a-z][a-z0-9_]*)\1$/.exec(entry.trim());
    if (!literal) throw new Error(`Cannot verify the ${name} literal catalog`);
    return literal[2];
  });
  if (new Set(values).size !== values.length) {
    throw new Error(`The ${name} catalog repeats a type`);
  }
  return values;
}

function readContentCatalogs(repoRoot, revision) {
  const readSource = (path) => {
    try {
      return execFileSync("git", ["show", `${revision}:${path}`], {
        cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error(`Cannot read ${path} at ${revision} from Git history`);
    }
  };
  // Read committed declarations as data; never execute the selected or historical code.
  const model = readSource("packages/content-core/src/content-model.ts");
  const routes = readSource("packages/content-core/src/public-record-kinds.ts");
  return {
    "block types": readLiteralCatalog(model, "BLOCK_TYPES"),
    "record kinds": readLiteralCatalog(model, "EDITORIAL_TYPES"),
    "public record kinds": readLiteralCatalog(routes, "PUBLICLY_ROUTED_RECORD_KINDS"),
  };
}

// A CMS-ahead diff must stay entirely within this small verified allow list.
// Neither publisher Dockerfile's npm ci/RUN/Site build steps nor any public
// Worker/publisher import or dynamic file-read chain consumes these inputs.
// COPY source/ /app/ includes them opaquely; copying alone is not a read/build
// dependency. Package manifests, shared Admin helpers, Site, publisher, Post
// chrome/settings and page-reader/protocol inputs are deliberately not allowed.
// Unknown paths refuse by default; audit build/import/read consumers before
// extending this list. Each entry below identifies its CMS-only consumer.
const CMS_ONLY_DEPLOY_PATHS = [
  "admin/src/components/", // Staff React components; no publisher/public imports or globs.
  "admin/src/routes/", // Staff React screens/routes; no publisher/public imports or globs.
  "admin/src/styles/", // Staff-only styles; Site owns its separate styles.
  "admin/src/data/whats-new.ts", // Staff What's new registry, read only by Admin.
  "admin/src/data/whats-new/", // Staff What's new note data, read only by Admin.
  "docs/cms/staging-deploy-runbook.md", // Operator prose, never a renderer/build input.
  "docs/cms/cloud-publisher.md", // Operator prose, never a renderer/build input.
  "docs/cms/boardwalk-usage.md", // Staff analytics documentation, never a renderer/build input.
  "functions/boardwalk-usage.js", // Standalone CMS usage exports loaded by functions/index.js, not the publisher.
  "functions/lib/boardwalk-usage-config.json", // Used only by the standalone usage module and Admin usage client.
  "tests/functions/boardwalk-usage.test.js", // Usage tests are not run/imported by publisher image builds or runtime.
  "tests/rules/boardwalk-usage.test.js", // Usage rule tests are not run/imported by publisher image builds or runtime.
];

export async function verifyLivePublisher(repoRoot, receiptUrl) {
  const response = await fetch(receiptUrl, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Public publication receipt returned HTTP ${response.status}`);
  const receipt = await response.json();
  if (typeof receipt?.commitSha !== "string" || !/^[a-f0-9]{40}$/i.test(receipt.commitSha)) {
    throw new Error("Public publication receipt must supply a full commitSha");
  }
  const publisherSha = receipt.commitSha.toLowerCase();
  // Assets receipts omit this header during authority outages or before the
  // first Post owner. Their body still identifies the deployed renderer source.
  const rendererHeader = response.headers.get("x-njpbs-renderer-sha");
  if (rendererHeader !== null &&
      (!/^[a-f0-9]{40}$/i.test(rendererHeader) || rendererHeader.toLowerCase() !== publisherSha)) {
    throw new Error("Public publication receipt renderer header must match its full commitSha");
  }
  const rendererSha = rendererHeader?.toLowerCase() ?? publisherSha;
  try {
    const deploy = readContentCatalogs(repoRoot, "HEAD");
    const publisher = readContentCatalogs(repoRoot, publisherSha);
    const unsupported = Object.entries(deploy).flatMap(([label, types]) => {
      const missing = types.filter((type) => !publisher[label].includes(type));
      return missing.length ? [`Unsupported ${label}: ${missing.join(", ")}.`] : [];
    });
    if (unsupported.length) throw new Error(unsupported.join(" "));
  } catch (error) {
    throw new Error(
      `Publisher commit ${publisherSha} cannot verify support for this deploy. ` +
      `${error instanceof Error ? error.message : error} ` +
      "Promote the publisher first using the deployment configuration " +
      "(For an authorized publisher source change) and " +
      "the deployment configuration, then retry the CMS deploy.",
    );
  }
  // Catalog equality alone cannot prove chrome/settings or Page reader support.
  // Preserve older/equal deploys; only a descendant confined to verified
  // CMS-only paths may deploy ahead. Unknown paths/history still refuse.
  if (!isAncestor(repoRoot, "HEAD", rendererSha)) {
    if (!isAncestor(repoRoot, rendererSha, "HEAD")) {
      throw new Error(
        `CMS deploy_ref must be an ancestor of live public renderer ${rendererSha} or descend from it with only verified CMS-only paths. ` +
        "Diverged source or missing renderer Git history refuses the deploy.",
      );
    }
    let changed;
    try {
      // NUL delimiters preserve unusual filenames; --no-renames checks both
      // sides of moves, including a protected file moved outside its directory.
      changed = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${rendererSha}..HEAD`, "--"], {
        cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).split("\0").filter(Boolean);
    } catch {
      throw new Error("Cannot verify renderer input changes from Git history; CMS deploy refused.");
    }
    const disallowedChanges = changed.filter(path => !CMS_ONLY_DEPLOY_PATHS.some(input =>
      path === input || input.endsWith("/") && path.startsWith(input),
    ));
    if (disallowedChanges.length) {
      throw new Error(
        `CMS deploy_ref changes paths outside the CMS-only allow list for live public renderer ${rendererSha}: ${disallowedChanges.join(", ")}. ` +
        "Promote the public renderer first using the deployment configuration, then retry the CMS deploy.",
      );
    }
  }
  return publisherSha;
}

function isAncestor(repoRoot, ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && thisFile === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (
    (args.length === 2 || (args.length === 4 && args[2] === "--publisher-receipt-url" && args[3].trim() !== "")) &&
    args[0] === "--target-root" &&
    args[1].trim() !== ""
  ) {
    try {
      const result = validateCmsDeployCompatibility(args[1]);
      console.log(
        `cms deploy compatibility: editor-lock contract v${result.editorLockContractVersion} verified.`,
      );
      if (args.length === 4) {
        const publisherSha = await verifyLivePublisher(resolve(args[1]), args[3]);
        console.log(`cms deploy compatibility: publisher ${publisherSha} supports the deploy catalog.`);
      }
    } catch (error) {
      console.error(
        `cms deploy compatibility: ${error instanceof Error ? error.message : error}`,
      );
      process.exitCode = 1;
    }
  } else {
    console.error(
      "cms deploy compatibility: usage: node .github/scripts/cms-deploy-compatibility.mjs --target-root PATH [--publisher-receipt-url URL]",
    );
    process.exitCode = 2;
  }
}
