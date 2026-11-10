import liveBlog from "../../functions/lib/live-blog-compatibility.js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import pairs from "../../functions/lib/public-release-pair.js";
import targets from "../../functions/lib/publication-target.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { assertCmsPreviewSourceCheckout } from "./cms-publication-runtime-guard";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";
import { createPublicReleasePairExecutor } from "./public-release-pair-executor";
import { publicReleasePairRpcStore } from "./public-release-pair-storage-rpc";
import { verifyPublicReleasePairRenderer } from "./public-release-pair-renderer-release.mjs";
import { assertPreviewSandboxAvailable } from "./cms-preview-operator-checks";
import { startPublicReleasePairServer } from "./public-release-pair-server";
import { createPrivatePairReader, readerSealPath } from "./public-release-pair-private-reader";
import { privatePairReaderCapabilities } from "../../workers/src/private-pair-reader-installation";
import { PAIR_READER_CONTRACT } from "../../packages/content-core/src/private-pair-http.mjs";
import { parseReaderSeals } from "./public-release-pair-reader-contract";
import { createOriginalPublicReleaseContinuation, bindOriginalPublicReleaseContinuation } from "./public-release-original-continuation";
import { createPublicReleaseSwitchCodeContinuation } from "./public-release-switch-code-continuation";
import { bindPublicReleaseSwitchCodeContinuation } from "./public-release-switch-code-binding";
import { publicReleaseSwitchCodeWriteStore } from "./public-release-switch-code-write-transport";
import { publicReleaseTerminalTransport } from "./public-release-terminal-transport";

const executeFile = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
export function pairSourceGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: environment.PATH, HOME: environment.HOME, LANG: "C", LC_ALL: "C" };
}
async function sourceGit(args: string[]) {
  const result = await executeFile("/usr/bin/git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", sourceRoot, ...args], {
    env: pairSourceGitEnvironment(process.env), encoding: "utf8", maxBuffer: 64 * 1024, timeout: 120_000,
  });
  return result.stdout;
}

export async function runCmsPublicationPairCloud(mode: string, environment = process.env) {
  if (!["--serve", "--preflight"].includes(mode)) throw new Error("Invalid pair runtime mode");
  const forbidden = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS",
    "CMS_PUBLICATION_ACTIVATION_TOKEN", "CMS_PUBLICATION_SERIALIZER_ID", "CMS_PUBLICATION_R2_CREDENTIAL",
    "CMS_PUBLICATION_PREVIEW_R2_CREDENTIAL", "ACTIVATION_TOKEN", "PUBLICATION_SERIALIZER_ID",
    "R2_PUBLICATION_CREDENTIAL", "R2_PREVIEW_CREDENTIAL", "R2_MEDIA_CREDENTIAL", "PUBLICATION_WAKE_TOKEN",
    "CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL", "CMS_PUBLICATION_MEDIA_R2_CREDENTIAL", "MEDIA_MANAGER_CREDENTIAL"];
  // config-input: ACTIVATION_TOKEN, CMS_PUBLICATION_ACTIVATION_TOKEN, CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL
  // config-input: CMS_PUBLICATION_MEDIA_R2_CREDENTIAL, CMS_PUBLICATION_PREVIEW_R2_CREDENTIAL, CMS_PUBLICATION_R2_CREDENTIAL
  // config-input: CMS_PUBLICATION_SERIALIZER_ID, FIREBASE_AUTH_EMULATOR_HOST, FIRESTORE_EMULATOR_HOST
  // config-input: GOOGLE_APPLICATION_CREDENTIALS, MEDIA_MANAGER_CREDENTIAL, PUBLICATION_SERIALIZER_ID
  // config-input: PUBLICATION_WAKE_TOKEN, R2_MEDIA_CREDENTIAL, R2_PREVIEW_CREDENTIAL, R2_PUBLICATION_CREDENTIAL
  if (forbidden.some(key => environment[key] !== undefined || process.env[key] !== undefined)) throw new Error("Pair runtime refuses legacy routing");
  const pair = pairs.parsePublicReleasePair(JSON.parse(environment.CMS_PUBLICATION_PAIR_JSON ?? "null"));
  work.assertPrivatePairResources(pair);
  const target = targets.publicationTarget(pair.environment);
  await assertCmsPreviewSourceCheckout(pair.commitSha, sourceGit);
  await verifyPublicReleasePairRenderer(path.join(sourceRoot, "site/.public-post-renderer"), pair);
  await assertPreviewSandboxAvailable();
  if (mode === "--preflight") return;
  // Consume the credential only at SDK initialization; never print provider
  // output, retain a credential file or pass it to an executor process.
  let account;
  try { account = JSON.parse(environment.CMS_PUBLICATION_FIREBASE_ACCOUNT ?? "null"); }
  catch { throw new Error("Pair runtime credential is invalid"); }
  delete environment.CMS_PUBLICATION_FIREBASE_ACCOUNT;
  if (account?.type !== "service_account" || account.project_id !== target.projectId ||
      typeof account.client_email !== "string" || typeof account.private_key !== "string") throw new Error("Pair runtime credential is invalid");
  const app = firebaseAdminRuntime.initializeApp({ credential: firebaseAdminRuntime.cert(account), projectId: target.projectId }, `pair:${pair.pairId}`);
  let server: Awaited<ReturnType<typeof startPublicReleasePairServer>> | undefined;
  try {
    const firestore = firebaseAdminRuntime.getFirestore(app);
    const rendererSeal = JSON.parse(await readFile(path.join(sourceRoot, "site/.public-post-renderer/renderer-release.json"), "utf8"));
    await firestore.runTransaction(async transaction => {
      const write = await createRequire(import.meta.url)("../../functions/lib/page-reader-compatibility.js").preparePageReaderMarker({
        firestore, transaction, role: "public", rendererSha: pair.commitSha, version: rendererSeal.pageReaderVersion });
      write();
    });
    const store = publicReleasePairRpcStore();
    const terminal = environment.CMS_PUBLICATION_PAIR_ORIGINAL_RECOVERY_ENABLED === "true" ? publicReleaseTerminalTransport(pair.environment) : null;
    const capture = terminal ? { providerStore: {
        async get(key: string) {
          // Explicitly use this named SDK app; the pair runtime never falls
          // back to an ambient/default app or a second storage credential.
          const background = createRequire(import.meta.url)("../../functions/lib/post-background-storage.js")
            .createPostBackgroundStorage(target.backgroundBucket, app);
          const bytes = await background.get(key, { maxBytes: 16 * 1024 * 1024, signal: AbortSignal.timeout(10_000) });
          return bytes ? { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! } : null;
        },
        async put() { throw new Error("Historical provider store is read-only"); },
      } } : undefined;
    const continuation = terminal ? createOriginalPublicReleaseContinuation({ enabled: true, firestore, pair,
      store: terminal.store, ingress: terminal.ingress, fieldValues: firebaseAdminRuntime.FieldValue, capture }) : {};
    if (environment.CMS_PUBLICATION_PAIR_SWITCH_CODE_ENABLED === "true" && !terminal)
      throw new Error("Switch CODE continuation requires the original private transport");
    const codeContinuation = createPublicReleaseSwitchCodeContinuation({
      enabled: environment.CMS_PUBLICATION_PAIR_SWITCH_CODE_ENABLED === "true", firestore, pair, store: terminal?.store ?? store, capture,
      captureStore: (operationId, lease) => publicReleaseSwitchCodeWriteStore({ pair, operationId, lease }),
      replayStore: operationId => publicReleaseSwitchCodeWriteStore({ pair, operationId }) });
    const executor = createPublicReleasePairExecutor({ firestore, pair, store, ...(continuation.publication ? { publication: continuation.publication } : {}) });
    server = await startPublicReleasePairServer({ firestore, pair,
      ...bindPublicReleaseSwitchCodeContinuation({
        executor: bindOriginalPublicReleaseContinuation({ firestore, pair, executor, continuation }), continuation: codeContinuation }),
      readerInstallation: () => ({ pairDigest: pairs.publicReleaseDigest(pair), publisher: pair.publisher,
        readerContractDigest: pairs.publicReleaseDigest(PAIR_READER_CONTRACT), capabilities: privatePairReaderCapabilities(pair.commitSha) }),
      privateReader: async request => {
        const installed = (await firestore.doc(readerSealPath(pair)).get()).data();
        return createPrivatePairReader({ firestore, store, pair, installed: parseReaderSeals(installed, pair) })(request);
      } });
    await firestore.runTransaction(transaction => {
      liveBlog.writeLiveBlogContractMarker({ firestore, transaction, rendererSha: pair.commitSha });
      return Promise.resolve();
    });
    await new Promise<void>(resolve => {
      const stop = () => { process.off("SIGTERM", stop); process.off("SIGINT", stop); resolve(); };
      process.once("SIGTERM", stop); process.once("SIGINT", stop);
    });
  } finally {
    try { await server?.close(); }
    finally { await firebaseAdminRuntime.deleteApp(app); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCmsPublicationPairCloud(process.argv[2] ?? "").catch(() => {
    process.stderr.write("Private pair runtime stopped without a verified result\n");
    process.exitCode = 1;
  });
}
