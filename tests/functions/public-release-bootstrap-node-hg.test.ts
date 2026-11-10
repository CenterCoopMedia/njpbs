import { expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { qualifiedPairFixture } from "../helpers/qualified-public-release-pair";
import { qualifyPublicReleasePair } from "../../site/scripts/public-release-pair-qualification";

it("opens actual sealed H/G qualification bytes through an unbundled Node22+tsx process", async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the loopback demo emulator");
  const app = initializeApp({ projectId: "njpbs-site-dev" }, "bootstrap-node-hg"), firestore = getFirestore(app);
  await firestore.recursiveDelete(firestore.collection("system"));
  const directory = await mkdtemp(path.join(tmpdir(), "bootstrap-node-hg-")), r2 = await publicReleaseR2Fixture("bootstrap-node-hg");
  let fixture: Awaited<ReturnType<typeof qualifiedPairFixture>> | undefined, reads = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET") { response.writeHead(405).end(); return; }
      const key = new URL(request.url!, "http://fixture.invalid").searchParams.get("key");
      if (!key) throw new Error("Missing fixture key");
      reads++; const object = await r2.store.get(key);
      if (!object) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-length": object.size, "x-fixture-metadata": JSON.stringify(object.customMetadata) });
      Readable.fromWeb(object.body as any).pipe(response);
    } catch { response.writeHead(503).end(); }
  });
  try {
    fixture = await qualifiedPairFixture(firestore, r2.store);
    const qualification = await qualifyPublicReleasePair({ firestore, ...fixture, qualificationId: "node-hg" });
    const file = path.join(directory, "qualification.json");
    await writeFile(file, JSON.stringify({ pair: fixture.pair, receipt: qualification.receipt,
      witness: fixture.witness, namespaces: fixture.namespaces }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const child = spawn(process.execPath, ["--import", path.resolve("site/node_modules/tsx/dist/loader.mjs"), "--eval", `
      const { initializeApp, deleteApp } = require('firebase-admin/app');
      const { getFirestore } = require('firebase-admin/firestore');
      const { verifyStoredQualificationEvidence } = require('./site/scripts/public-release-pair-qualification.ts');
      const input = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
      const app = initializeApp({ projectId: 'njpbs-site-dev' });
      const store = { put() { throw new Error('Read only'); }, async get(key) {
        const response = await fetch(process.argv[2] + '/?key=' + encodeURIComponent(key));
        if (response.status === 404) return null;
        if (response.status !== 200) throw new Error('Fixture object refusal');
        return { body: response.body, size: Number(response.headers.get('content-length')),
          customMetadata: JSON.parse(response.headers.get('x-fixture-metadata')) };
      } };
      verifyStoredQualificationEvidence({ ...input, firestore: getFirestore(app), store, signal: AbortSignal.timeout(30000) })
        .then(result => process.stdout.write(JSON.stringify({ selectedViews: result.selectedViews.length })))
        .catch(error => { process.stderr.write(error.name + ': ' + error.message); process.exitCode = 1; })
        .finally(() => deleteApp(app));
    `, file, origin], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(output).selectedViews).toBeGreaterThan(1); expect(reads).toBeGreaterThan(0);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await fixture?.close(); await r2.runtime.dispose(); await rm(directory, { recursive: true, force: true }); await deleteApp(app);
  }
}, 60_000);
