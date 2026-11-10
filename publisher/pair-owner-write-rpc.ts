import { ownerTerminalFactReader } from "./pair-owner-terminal-fact";
import { pairOwnerCodeAuthority, type PairCodeSnapshot } from "./pair-owner-code-authority";
import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import p from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import input from "../functions/lib/public-release-pair-input.js";
import admission from "../functions/lib/public-release-admission-contract.js";
import terminal from "../functions/lib/public-release-terminal.js";
import log from "../functions/lib/public-release-change-log.js";
import views from "../functions/lib/public-release-pair-view.js";
import { ownerReplayPageEvidencePath, parseOwnerReplayPageEvidence, type OwnerReplayPageEvidence } from "./pair-owner-page-evidence";

export const PAIR_OWNER_WRITE_HOST = "pair-owner-write.internal";
type Authority = { pair: PublicReleasePair; read(path: string): Promise<Record<string, unknown> | null>;
  readMany?(paths: string[]): Promise<(Record<string, unknown> | null)[]>;
  readTerminalEvidence?(path: string): Promise<Record<string, unknown> | null>;
  createPageEvidence?(receipt: OwnerReplayPageEvidence): Promise<void>; codeSnapshot?: PairCodeSnapshot };
// Layer-one runtime exports these internal codecs; its public declaration
// intentionally exposes only transport types. Preserve their implementation.
const codecs = p as typeof p & { exact(value: unknown, fields: string[]): void;
  digest(value: unknown): value is string; positive(value: unknown): value is number };
const same = (a: unknown, b: unknown) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse(): never { throw new p.PublicReleaseProtocolError(); }
const json = (bytes: Uint8Array) => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); } };
const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
async function bytes(body: ReadableStream<Uint8Array> | null, size: number) {
  if (!body) refuse();
  const reader = body.getReader(), chunks: Uint8Array[] = []; let count = 0;
  try { for (;;) { const row = await reader.read(); if (row.done) break; count += row.value.byteLength;
    if (count > size) refuse(); chunks.push(row.value); } } finally { await reader.cancel().catch(() => {}); }
  if (count !== size) refuse();
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function reference(raw: any, pair: PublicReleasePair) {
  codecs.exact(raw, ["identity", "claimDigest", "manifestDigest", "manifestBytes"]);
  const identity = views.parseViewIdentity(raw.identity, pair);
  if (![raw.claimDigest, raw.manifestDigest].every(codecs.digest) || !codecs.positive(raw.manifestBytes) || raw.manifestBytes > views.VIEW_ROOT_BYTES_LIMIT) refuse();
  return { ...raw, identity };
}
const compare = (a: string, b: string) => views.comparePrivatePairArtifactPaths(a, b);

/** Storage transport only, never a qualification or terminal-success issuer.
 * H is authorized by the original pending owner's actual live recovery lease;
 * replay writes require actual completed target SDK evidence. The original
 * claim may still be running; only terminal success requires its completion. */
export async function pairOwnerWriteRpc(request: Request, bucket: Pick<R2Bucket, "get" | "put">, authority: Authority, clock = Date.now) {
  try { return await write(); }
  catch (error: any) { return new Response(null, { status: error instanceof p.PublicReleaseProtocolError ||
    error?.name === "PublicReleaseProtocolError" && error?.status === 409 ? 403 : 503 }); }
  async function write() {
    const url = new URL(request.url), pair = p.parsePublicReleasePair(authority.pair), pairDigest = p.publicReleaseDigest(pair), now = clock();
    work.assertPrivatePairResources(pair);
    if (request.method !== "PUT" || url.protocol !== "http:" || url.hostname !== PAIR_OWNER_WRITE_HOST || url.port ||
        url.search || url.hash || url.username || url.password || request.headers.get("if-none-match") !== "*" ||
        !Number.isSafeInteger(now) || now < 1) refuse();
    const key = url.pathname.slice(1), operationId = request.headers.get("x-owner-operation") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId) || !/^[A-Za-z0-9._:/-]+$/.test(key) || key.includes("..")) refuse();
    const hPrefix = `release-pair-inputs/v2/${pair.pairId}/`, rPrefix = `release-pair-replay/v2/${pairDigest}/`;
    const h = key.startsWith(hPrefix) ? /^(objects|manifests)\/([a-f0-9]{64})\.json$/.exec(key.slice(hPrefix.length)) : null;
    const r = key.startsWith(rPrefix) ? /^(pages|selections)\/([a-f0-9]{64})\.json$/.exec(key.slice(rPrefix.length)) : null;
    if (!h && !r) refuse();
    const digest = (h ?? r)![2], limit = h ? h[1] === "manifests" ? input.INPUT_ROOT_BYTES_LIMIT : input.INPUT_FILE_BYTES_LIMIT
      : r![1] === "pages" ? 1024 * 1024 : 256 * 1024;
    const size = Number(request.headers.get("content-length"));
    if (!request.headers.has("content-length") || !Number.isSafeInteger(size) || size < 1 || size > limit) refuse();
    let metadata: any;
    try { metadata = JSON.parse(request.headers.get("x-pair-metadata") ?? "null"); } catch { refuse(); }
    codecs.exact(metadata, ["schemaversion", "pairdigest", "bodydigest"]);
    if (metadata.schemaversion !== "2" || metadata.pairdigest !== pairDigest || metadata.bodydigest !== digest) refuse();
    // Private storage validation is outside transactions. Pages batch three
    // immutable rows per view; roots read one verified receipt per page.
    // Qualification/CAS owners retain their shared 500-read budget.
    const readLimit = r?.[1] === "selections" ? 500 : 100 + 3 * 256;
    let reads = 0;
    const read = async (path: string) => { if (++reads > readLimit) refuse(); return authority.read(path); };
    const readMany = async (paths: string[]) => {
      reads += paths.length;
      if (reads > readLimit || !authority.readMany) refuse();
      const rows = await authority.readMany(paths);
      if (rows.length !== paths.length) refuse();
      return rows;
    };
    const base = work.publicReleasePairPath(pair.pairId);
    const stagedRows = new Map<string, Record<string, unknown> | null>(), pageEvidence = new Map<string, unknown>();
    const stagedEvidence = async (raw: any, sequence: number, fromBatch = false) => {
      const ref = reference(raw, pair), taskId = p.publicReleaseDigest(ref.identity);
      if (ref.identity.contextSequence > sequence) refuse();
      const paths = [`${base}/views/${ref.manifestDigest}`, `${base}/receipts/${taskId}`, `${base}/work/${taskId}`];
      const [row, receipt, task] = fromBatch ? paths.map(path => stagedRows.get(path)) : await Promise.all(paths.map(read));
      if (row?.schemaVersion !== 2 || row.status !== "staged" || row.pairDigest !== pairDigest || row.taskId !== taskId ||
          row.claimDigest !== ref.claimDigest || row.manifestDigest !== ref.manifestDigest ||
          row.manifestBytes !== ref.manifestBytes || !same(row.identity, ref.identity) || receipt?.schemaVersion !== 2 ||
          receipt.taskId !== taskId || receipt.claimDigest !== ref.claimDigest || receipt.manifestDigest !== ref.manifestDigest ||
          !same(receipt.identity, ref.identity) || task?.status !== "complete" || task.receiptDigest !== p.publicReleaseDigest(receipt) ||
          !same(task.identity, ref.identity)) refuse();
      if (fromBatch) {
        codecs.exact(receipt, ["schemaVersion", "taskId", "identity", "manifestDigest", "claimDigest"]);
        if (!codecs.digest(row.readbackDigest)) refuse();
        pageEvidence.set(p.publicReleaseDigest(ref), { reference: ref, receiptDigest: p.publicReleaseDigest(receipt), readbackDigest: row.readbackDigest });
      }
      return ref;
    };
    const terminalFact = ownerTerminalFactReader({ pair, read: authority.readTerminalEvidence ?? authority.read });
    const codeRequest = request.headers.get("x-owner-kind") === "switch-code";
    const context = async (): Promise<any> => {
      if (codeRequest) return pairOwnerCodeAuthority({ pair, operationId, capturing: !!h, now: clock(),
        leaseToken: request.headers.get("x-switch-code-lease"), snapshot: authority.codeSnapshot });
      const [saved, control, billing, root, adoption, acceptedRow, queue, marker] = await Promise.all([
        read(base), read(`${base}/controls/runtime`), read("system/billing"), read("system/publicDeployment"),
        read(`${admission.ADMISSIONS}/controls/adoption`), read(`${admission.ADMISSIONS}/operations/${operationId}`),
        read(`cmsPublishQueue/${operationId}`), read(`${admission.ADMISSIONS}/pending/${operationId}`)]);
      const accepted = admission.parseAdmission(acceptedRow), selector = p.parseStoredPublicReleaseSelector(root);
      admission.assertQueue(queue, accepted);
      if (!same(p.parsePublicReleasePair(saved), pair) || !control || billing?.disabled === true ||
          Object.keys(control).sort().join(",") !== "pairId,schemaVersion,status" || control.schemaVersion !== 2 || control.pairId !== pair.pairId ||
          !["candidate", "retained"].includes(String(control.status)) || adoption?.schemaVersion !== 2 || adoption.enabled !== true ||
          Object.keys(adoption).sort().join(",") !== "enabled,schemaVersion" || accepted.operationId !== operationId) refuse();
      let fact = null;
      if (marker) {
        codecs.exact(marker, ["schemaVersion", "operationId", "admissionDigest"]);
        if (!["pending", "publishing", "failed"].includes(String(queue?.status)) || marker.schemaVersion !== 2 ||
            marker.operationId !== operationId || marker.admissionDigest !== p.publicReleaseDigest(accepted)) refuse();
      } else {
        if (h) refuse();
        // Reuse the actual terminal FACT reader for settled originals. This
        // read-only REST adapter grants storage only, never an SDK write.
        fact = await terminalFact(operationId, p.publicReleaseDigest(accepted));
      }
      const entry = log.parsePublicReleaseChange(await read(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(accepted.changeSequence).padStart(16, "0")}`));
      if (entry.operationId !== operationId || !same(entry.pair, accepted.pair) || entry.contextRevision !== accepted.contextRevision ||
          entry.changes.length !== 1 || !same(entry.changes[0], { kind: accepted.source.kind, id: accepted.source.id,
            action: accepted.source.action, sourceVersion: accepted.source.sourceVersion, snapshotDigest: accepted.source.snapshotDigest })) refuse();
      const head = log.parsePublicReleaseChangeHead(await read(log.PUBLIC_RELEASE_CHANGES_PATH));
      if (head.sequence < accepted.changeSequence) refuse();
      if (h) {
        const pending = await read(`${base}/publicationPending/${operationId}`), lease = pending?.recoveryLease as any;
        if (accepted.pairDigest !== pairDigest || !same(accepted.pair, p.publicReleasePairReference(pair)) ||
            pending?.schemaVersion !== 2 || pending.operationId !== operationId || pending.admissionDigest !== p.publicReleaseDigest(accepted) ||
            !lease || !Number.isSafeInteger(lease.until) || lease.until <= now || !/^[a-f0-9-]{36}$/.test(lease.token ?? "") ||
            request.headers.get("x-original-recovery-lease") !== lease.token) refuse();
        return { accepted, selector, control, queueStatus: queue!.status, entry, lease, baselineDigest: head.baselineDigest };
      }
      const execution = queue?.execution === null ? null : terminal.parseCompletedPairPublicationExecution(queue?.execution);
      if (execution && (execution.pairDigest !== accepted.pairDigest || !same(execution.pair, accepted.pair) ||
          execution.identity.sourceOperationId !== operationId || execution.identity.sourceVersion !== accepted.source.sourceVersion ||
          execution.identity.snapshotDigest !== accepted.source.snapshotDigest || execution.identity.contextSequence !== accepted.changeSequence)) refuse();
      const originalBase = work.publicReleasePairPath(accepted.pair.pairId), original = p.parsePublicReleasePair(await read(originalBase));
      if (p.publicReleaseDigest(original) !== accepted.pairDigest || !same(p.publicReleasePairReference(original), accepted.pair)) refuse();
      if (execution) {
        const receipt = await read(`${originalBase}/receipts/${execution.taskId}`), task = await read(`${originalBase}/work/${execution.taskId}`);
        if (receipt?.schemaVersion !== 2 || receipt.taskId !== execution.taskId || receipt.claimDigest !== execution.claimDigest ||
            receipt.manifestDigest !== execution.manifestDigest || !same(receipt.identity, execution.identity) ||
            task?.status !== "complete" || task.receiptDigest !== p.publicReleaseDigest(receipt) || !same(task.identity, execution.identity)) refuse();
      }
      let target;
      for (const kind of ["accepted", "recovery", "qualification"] as const) {
        const binding = await read(`${base}/sourceInputs/${p.publicReleaseDigest({ kind, sourceOperationId: operationId })}`);
        if (!binding) continue;
        const scope = input.parsePublicReleasePairInputScope(binding.scope);
        if (binding.schemaVersion !== 2 || binding.pairDigest !== pairDigest || !codecs.digest(binding.inputManifestDigest) ||
            !same(scope, { kind, sourceOperationId: operationId, sourceVersion: accepted.source.sourceVersion,
              snapshotDigest: accepted.source.snapshotDigest, contextSequence: accepted.changeSequence })) refuse();
        const identity = { schemaVersion: 2, pair: p.publicReleasePairReference(pair), ...scope, inputManifestDigest: binding.inputManifestDigest };
        const completed = await read(`${base}/receipts/${p.publicReleaseDigest(identity)}`);
        if (!completed) continue;
        const row = await read(`${base}/views/${completed.manifestDigest}`);
        target = await stagedEvidence({ identity, claimDigest: completed.claimDigest, manifestDigest: completed.manifestDigest,
          manifestBytes: row?.manifestBytes }, head.sequence);
        break;
      }
      if (!target) refuse();
      return { accepted, selector, control, queueStatus: queue!.status, execution, target, fact, cursor: {
        baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest } };
    };
    const before = await context(), body = await bytes(request.body, size);
    if (await sha(body) !== digest) refuse();
    const value = json(body);
    const storedJson = async (objectKey: string, bodyDigest: string, maximum: number,
      expected: Record<string, string>, expectedSize?: number) => {
      const stored = await bucket.get(objectKey);
      if (!stored || stored.size < 1 || stored.size > maximum || expectedSize !== undefined && stored.size !== expectedSize ||
          !same(stored.customMetadata, expected)) { await stored?.body.cancel(); refuse(); }
      const data = await bytes(stored.body, stored.size);
      if (await sha(data) !== bodyDigest) refuse();
      return json(data);
    };
    if (h?.[1] === "manifests") {
      const plan = input.parsePublicReleasePairInputRoot(value, pair), a = before.accepted;
      if (codeRequest) {
        if (!same(plan.scope, before.code.scope) || !same(plan.source, { kind: before.code.source.source.kind, id: before.code.source.source.id }) ||
            !same(plan.cursor, before.code.source.cursor)) refuse();
      } else {
      if (!same(plan.scope, { kind: "accepted", sourceOperationId: operationId, sourceVersion: a.source.sourceVersion,
        snapshotDigest: a.source.snapshotDigest, contextSequence: a.changeSequence }) || plan.source.kind !== a.source.kind ||
          plan.source.id !== a.source.id || plan.cursor.lastDigest !== before.entry!.entryDigest ||
          plan.cursor.baselineDigest !== before.baselineDigest) refuse();
      }
      for (const file of plan.files) await storedJson(file.objectKey, file.digest, input.INPUT_FILE_BYTES_LIMIT,
        { schemaversion: "2", pairdigest: pairDigest, bodydigest: file.digest }, file.bytes);
    }
    const checked = new Set<string>();
    let replayCursor: { baselineDigest: string; sequence: number; lastDigest: string } | undefined;
    const cursor = async (raw: any) => {
      codecs.exact(raw, ["baselineDigest", "sequence", "lastDigest"]);
      if (raw.baselineDigest !== before.cursor!.baselineDigest || !codecs.digest(raw.lastDigest) ||
          !Number.isSafeInteger(raw.sequence) || raw.sequence < 0 || raw.sequence > before.cursor!.sequence) refuse();
      if (replayCursor) { if (!same(raw, replayCursor)) refuse(); return replayCursor; }
      if (raw.sequence === 0) { if (raw.lastDigest !== raw.baselineDigest) refuse(); }
      else {
        const entry = log.parsePublicReleaseChange(await read(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(raw.sequence).padStart(16, "0")}`));
        if (entry.sequence !== raw.sequence || entry.entryDigest !== raw.lastDigest) refuse();
      }
      replayCursor = { ...raw }; return replayCursor!;
    };
    // At most one verified immutable root and page are retained. A page can
    // reuse a view many times without repeating its R2 reads for every route.
    let recentRoot: { key: string; value: ReturnType<typeof views.parsePublicReleasePairViewRoot> } | undefined;
    let recentPage: { key: string; value: ReturnType<typeof views.parsePublicReleasePairViewPage> } | undefined;
    const staged = async (raw: any, path: string, bodyDigest: string) => {
      const ref = reference(raw, pair), id = p.publicReleaseDigest(ref);
      if (ref.identity.contextSequence > replayCursor!.sequence) refuse();
      if (!checked.has(id)) { checked.add(id); await stagedEvidence(ref, before.cursor!.sequence, true); }
      const prefix = views.publicReleasePairViewPrefix(pair, ref.identity, ref.claimDigest);
      const seal = (digest: string) => ({ schemaversion: "2", pairdigest: pairDigest,
        taskid: p.publicReleaseDigest(ref.identity), claimdigest: ref.claimDigest, bodydigest: digest });
      const rootKey = `${prefix}views/${ref.manifestDigest}.json`;
      if (recentRoot?.key !== rootKey) recentRoot = { key: rootKey, value: views.parsePublicReleasePairViewRoot(await storedJson(rootKey,
        ref.manifestDigest, views.VIEW_ROOT_BYTES_LIMIT, seal(ref.manifestDigest), ref.manifestBytes), pair) };
      const root = recentRoot.value;
      if (!same(root.identity, ref.identity) || root.claimDigest !== ref.claimDigest) refuse();
      const descriptor = root.pages.find(page => compare(page.firstPath, path) <= 0 && compare(page.lastPath, path) >= 0);
      if (!descriptor) refuse();
      const pageKey = `${prefix}pages/${descriptor.digest}.json`;
      if (recentPage?.key !== pageKey) recentPage = { key: pageKey, value: views.parsePublicReleasePairViewPage(await storedJson(pageKey,
        descriptor.digest, views.VIEW_PAGE_BYTES_LIMIT, seal(descriptor.digest)), pair, ref.identity, ref.claimDigest) };
      const page = recentPage.value;
      if (page.index !== descriptor.index || page.outputs.length !== descriptor.count || page.outputs[0].path !== descriptor.firstPath ||
          page.outputs.at(-1)!.path !== descriptor.lastPath || page.outputs.reduce((sum, output) => sum + output.bytes, 0) !== descriptor.bytes ||
          !page.outputs.some(output => output.path === path && output.bodyDigest === bodyDigest)) refuse();
    };
    const concurrently = async <T>(values: T[], run: (value: T) => Promise<unknown>) => {
      for (let index = 0; index < values.length; index += 4) await Promise.all(values.slice(index, index + 4).map(run));
    };
    const page = async (raw: any, expectedKind?: unknown, validateViews = false) => {
      codecs.exact(raw, ["schemaVersion", "pairDigest", "kind", "cursor", "index", "members"]);
      if (raw.schemaVersion !== 2 || raw.pairDigest !== pairDigest || !["content", "code-pack-overlay"].includes(raw.kind) ||
          expectedKind !== undefined && raw.kind !== expectedKind ||
          !Number.isSafeInteger(raw.index) || raw.index < 0 || raw.index >= Math.ceil(100_000 / 256) ||
          !Array.isArray(raw.members) || raw.members.length < 1 || raw.members.length > 256) refuse();
      await cursor(raw.cursor);
      let previous = "";
      for (const member of raw.members) {
        codecs.exact(member, ["path", "view", "bodyDigest"]);
        if (typeof member.path !== "string" || member.path !== "/" &&
            !views.isPrivatePairArtifactPath(member.path.endsWith("/") ? member.path.slice(0, -1) : member.path) ||
            raw.kind === "content" && !member.path.endsWith("/") || !codecs.digest(member.bodyDigest) || compare(member.path, previous) <= 0) refuse();
        const ref = reference(member.view, pair);
        if (ref.identity.contextSequence > replayCursor!.sequence) refuse();
        previous = member.path;
      }
      if (validateViews) {
        const paths = [...new Set<string>(raw.members.flatMap((member: any) => {
          const ref = reference(member.view, pair), taskId = p.publicReleaseDigest(ref.identity);
          return [`${base}/views/${ref.manifestDigest}`, `${base}/receipts/${taskId}`, `${base}/work/${taskId}`];
        }))];
        const rows = await readMany(paths);
        paths.forEach((path, index) => stagedRows.set(path, rows[index]));
        await concurrently(raw.members, async (member: any) => staged(member.view, member.path, member.bodyDigest));
      }
      return raw;
    };
    let pageReceipt: OwnerReplayPageEvidence | undefined;
    if (r?.[1] === "pages") {
      await page(value, undefined, true);
      pageReceipt = parseOwnerReplayPageEvidence({ schemaVersion: 2, kind: "owner-replay-page", pairDigest, pageDigest: digest,
        cursor: value.cursor, index: value.index, count: value.members.length, firstPath: value.members[0].path,
        lastPath: value.members.at(-1).path, evidenceDigest: p.publicReleaseDigest([...pageEvidence.entries()].sort(([a], [b]) => compare(a, b))) }, pair);
    }
    if (r?.[1] === "selections") {
      codecs.exact(value, ["schemaVersion", "pairDigest", "kind", "cursor", "pages", "count"]);
      if (value.schemaVersion !== 2 || value.pairDigest !== pairDigest || !["content", "code-pack-overlay"].includes(value.kind) ||
          !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 100_000 ||
          !Array.isArray(value.pages) || value.pages.length > Math.ceil(100_000 / 256)) refuse();
      await cursor(value.cursor);
      let count = 0, previous = "";
      const receipts = value.pages.length ? await readMany(value.pages.map((descriptor: any) => ownerReplayPageEvidencePath(pair, descriptor.digest))) : [];
      const checks: { descriptor: any; receipt: OwnerReplayPageEvidence; index: number }[] = [];
      for (const [index, descriptor] of value.pages.entries()) {
        codecs.exact(descriptor, ["digest", "count", "firstPath", "lastPath"]);
        if (!codecs.digest(descriptor.digest) || !Number.isSafeInteger(descriptor.count) || descriptor.count < 1 || descriptor.count > 256 ||
            typeof descriptor.firstPath !== "string" || typeof descriptor.lastPath !== "string" || compare(descriptor.firstPath, previous) <= 0 ||
            compare(descriptor.firstPath, descriptor.lastPath) > 0 || (descriptor.count === 1) !== (descriptor.firstPath === descriptor.lastPath)) refuse();
        const receipt = parseOwnerReplayPageEvidence(receipts[index], pair);
        if (receipt.pageDigest !== descriptor.digest || !same(receipt.cursor, value.cursor) || receipt.index !== index ||
            receipt.count !== descriptor.count || receipt.firstPath !== descriptor.firstPath || receipt.lastPath !== descriptor.lastPath) refuse();
        checks.push({ descriptor, receipt, index });
        count += descriptor.count; previous = descriptor.lastPath;
      }
      if (count !== value.count) refuse();
      await concurrently(checks, async ({ descriptor, receipt, index }) => {
        const stored = await bucket.get(`${rPrefix}pages/${descriptor.digest}.json`);
        if (!stored || stored.size < 1 || stored.size > 1024 * 1024 || stored.customMetadata?.schemaversion !== "2" ||
            stored.customMetadata?.pairdigest !== pairDigest || stored.customMetadata?.bodydigest !== descriptor.digest) { await stored?.body.cancel(); refuse(); }
        const data = await bytes(stored.body, stored.size); if (await sha(data) !== descriptor.digest) refuse();
        const parsed = await page(json(data), value.kind);
        if (parsed.index !== index || parsed.members.length !== descriptor.count || parsed.members[0].path !== descriptor.firstPath ||
            parsed.members.at(-1).path !== descriptor.lastPath) refuse();
        if (receipt.pageDigest !== descriptor.digest) refuse();
      });
    }
    if (!same(await context(), before) || h && before.lease!.until <= clock()) refuse();
    const created = await bucket.put(key, body, { onlyIf: { etagDoesNotMatch: "*" }, sha256: digest, customMetadata: metadata });
    const stored = await bucket.get(key);
    if (!stored || stored.size !== size || !same(stored.customMetadata, metadata)) { await stored?.body.cancel(); refuse(); }
    if (await sha(await bytes(stored.body, stored.size)) !== digest) refuse();
    if (pageReceipt) {
      if (!authority.createPageEvidence) refuse();
      await authority.createPageEvidence(pageReceipt);
      if (!same(await context(), before)) refuse();
    }
    return new Response(null, { status: created ? 201 : 412 });
  }
}
