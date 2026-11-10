import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { openPublicReleasePairSearchNamespaceSelection, openPublicReleasePairContentFeedNamespaceSelection } from "./public-release-pair-namespace-storage";
import { openStagedPublicReleasePairCatalogImages } from "./public-release-pair-catalog-image-storage";
import { openStagedPublicReleasePairComposite } from "./public-release-pair-composite-storage";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { PAIR_READER_PATH, PAIR_READER_REQUEST_LIMIT, PAIR_READER_BYTES_LIMIT, PAIR_READER_REPLY_LIMIT,
  exact, readerRefused, bytesDigest, same, compareReaderPaths, parseReaderRequest, parseReaderSeals, readBoundedBody,
  withinReaderDeadline, PAIR_READER_DEADLINE_MS, type ReaderRequest, type ReaderSeals, type ReaderOutput, type ReaderNamespaceAbsenceReply } from "./public-release-pair-reader-contract";

// A private batch has its own bounded budget. This does not change the public
// decision deadline, public route handler or the active-source CMS reader.
export const readerSealPath = (pair: PublicReleasePair) => `${work.publicReleasePairPath(pair.pairId)}/seals/privateReader`;
export async function assertPrivateReaderAuthority({ firestore, transaction, pair, request, installed }: {
  firestore: Firestore; transaction: Transaction; pair: PublicReleasePair; request: ReaderRequest; installed: ReaderSeals;
}) {
  const taskId = protocol.publicReleaseDigest(request.identity);
  const receipt = await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
    taskId, claimDigest: request.claimDigest, manifestDigest: request.manifestDigest });
  const base = work.publicReleasePairPath(pair.pairId);
  const [stagedRow, sealRow] = await transaction.getAll(firestore.doc(`${base}/views/${request.manifestDigest}`),
    firestore.doc(readerSealPath(pair)));
  const staged = exact(stagedRow.data(), ["schemaVersion", "status", "pairDigest", "taskId", "identity", "claimDigest",
    "manifestDigest", "manifestKey", "manifestBytes", "outputCount", "outputBytes", "cursor", "readbackDigest"]);
  const seals = parseReaderSeals(sealRow.data(), pair);
  const manifestKey = `${view.publicReleasePairViewPrefix(pair, request.identity, request.claimDigest)}views/${request.manifestDigest}.json`;
  if (!same(seals, installed) || !same(receipt.identity, request.identity) || staged.schemaVersion !== 2 || staged.status !== "staged" ||
      staged.pairDigest !== request.pairDigest || staged.taskId !== taskId || !same(staged.identity, request.identity) ||
      staged.claimDigest !== request.claimDigest || staged.manifestDigest !== request.manifestDigest ||
      staged.manifestKey !== manifestKey || staged.manifestBytes !== request.manifestBytes ||
      typeof staged.readbackDigest !== "string" || !/^[a-f0-9]{64}$/.test(staged.readbackDigest) ||
      !Number.isSafeInteger(staged.outputCount) || (staged.outputCount as number) < 1 ||
      (staged.outputCount as number) > view.VIEW_OUTPUT_LIMIT || !Number.isSafeInteger(staged.outputBytes) ||
      (staged.outputBytes as number) < 0 || (staged.outputBytes as number) > view.VIEW_TOTAL_BYTES_LIMIT) readerRefused();
  view.parsePublicReleasePairViewCursor(staged.cursor, request.identity);
  return Object.freeze({ ...staged });
}

async function storedBytes(store: PairViewStore, key: string, expectedDigest: string, expectedBytes: number | undefined,
  limit: number, request: ReaderRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  const object = await store.get(key);
  if (!object) readerRefused();
  const expected = { schemaversion: "2", pairdigest: request.pairDigest, taskid: protocol.publicReleaseDigest(request.identity),
    claimdigest: request.claimDigest, bodydigest: expectedDigest };
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > limit ||
      expectedBytes !== undefined && object.size !== expectedBytes ||
      Object.entries(expected).some(([key, value]) => object.customMetadata?.[key] !== value)) {
    void object.body.cancel().catch(() => {}); readerRefused();
  }
  const bytes = await readBoundedBody(object.body, object.size, signal);
  if (bytes.byteLength !== object.size || bytesDigest(bytes) !== expectedDigest) readerRefused();
  return bytes;
}
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

/** Inert, binding-private reader implementation. Installation must supply the
 * actual embedded deployment/capability readbacks and an authenticated private
 * transport. This module creates no listener, public route or seal writer.
 * Partial batches prove returned bytes only; full qualification is separate. */
export function createPrivatePairReader({ firestore, store, pair: rawPair, installed: rawInstalled }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; installed: ReaderSeals;
}) {
  const pair = protocol.parsePublicReleasePair(rawPair);
  work.assertPrivatePairResources(pair);
  const installed = parseReaderSeals(rawInstalled, pair);
  return async (httpRequest: Request): Promise<Response> => {
    if (httpRequest.method !== "POST" || new URL(httpRequest.url).pathname !== PAIR_READER_PATH ||
        new URL(httpRequest.url).search || httpRequest.headers.get("content-type") !== "application/json") return new Response(null, { status: 404 });
    const signal = AbortSignal.any([httpRequest.signal, AbortSignal.timeout(PAIR_READER_DEADLINE_MS)]);
    const run = async () => {
      const request = parseReaderRequest(decode(await readBoundedBody(httpRequest.body, PAIR_READER_REQUEST_LIMIT, signal)), pair);

      const authority = () => firestore.runTransaction(transaction => assertPrivateReaderAuthority({
        firestore, transaction, pair, request, installed }), { readOnly: true });
      const staged = await authority();
      signal.throwIfAborted();
      const prefix = view.publicReleasePairViewPrefix(pair, request.identity, request.claimDigest);
      const rootBytes = await storedBytes(store, `${prefix}views/${request.manifestDigest}.json`, request.manifestDigest,
        request.manifestBytes, view.VIEW_ROOT_BYTES_LIMIT, request, signal);
      const root = view.parsePublicReleasePairViewRoot(decode(rootBytes), pair);
      if (!same(root.identity, request.identity) || root.claimDigest !== request.claimDigest || !same(root.cursor, staged.cursor) ||
          root.outputCount !== staged.outputCount || root.outputBytes !== staged.outputBytes) readerRefused();
      type OpenedNamespace = Awaited<ReturnType<typeof openPublicReleasePairSearchNamespaceSelection>> |
        Awaited<ReturnType<typeof openPublicReleasePairContentFeedNamespaceSelection>>;
      const opened = new Map<string, Promise<OpenedNamespace>>();
      const openNamespace = (namespace: "/pagefind/" | "/api/v1/content/") => {
        const existing = opened.get(namespace);
        if (existing) return existing;
        const owner = { firestore, store, pair, identity: request.identity, claimDigest: request.claimDigest,
          viewManifestDigest: request.manifestDigest, signal };
        const created: Promise<OpenedNamespace> = namespace === "/pagefind/" ? openPublicReleasePairSearchNamespaceSelection(owner)
          : openPublicReleasePairContentFeedNamespaceSelection(owner);
        opened.set(namespace, created);
        return created;
      };
      let catalog: ReturnType<typeof openStagedPublicReleasePairCatalogImages> | undefined;
      const openCatalog = () => catalog ??= openStagedPublicReleasePairCatalogImages({ firestore, store, pair,
        identity: request.identity, claimDigest: request.claimDigest, viewManifestDigest: request.manifestDigest, signal });
      let composite: ReturnType<typeof openStagedPublicReleasePairComposite> | undefined;
      const openComposite = () => composite ??= openStagedPublicReleasePairComposite({ firestore, store, pair,
        identity: request.identity, claimDigest: request.claimDigest, viewManifestDigest: request.manifestDigest, signal });
      let namespaceAbsence: ReaderNamespaceAbsenceReply | null = null;
      if (request.absence) {
        const wanted = request.absence, namespace = await openNamespace(wanted.namespace);
        if (namespace.namespaceRootDigest !== wanted.namespaceRootDigest || namespace.namespaceManifestDigest !== wanted.namespaceManifestDigest ||
            !same(namespace.manifest.cursor, wanted.cursor)) readerRefused();
        const outputs = [];
        for (const path of wanted.paths) {
          // The owner distinguishes omission from a failed/corrupt member read.
          const result = await namespace.readMember(path);
          if (result.kind !== "absent" || result.path !== path || result.namespace !== wanted.namespace) readerRefused();
          outputs.push(Object.freeze({ path, status: 404 as const, kind: "namespace-absent" as const }));
        }
        namespaceAbsence = Object.freeze({ namespace: wanted.namespace, namespaceRootDigest: namespace.namespaceRootDigest,
          namespaceManifestDigest: namespace.namespaceManifestDigest, cursor: namespace.manifest.cursor, outputs: Object.freeze(outputs) });
      }
      // Find pages by their sealed route bounds. Fetch each needed page once;
      // do not scan or read the bodies of the entire view for every batch.
      const needed = new Map<number, typeof root.pages[number]>();
      for (const path of request.paths) {
        const descriptor = root.pages.find(page => compareReaderPaths(page.firstPath, path) <= 0 && compareReaderPaths(path, page.lastPath) <= 0);
        if (!descriptor) readerRefused();
        needed.set(descriptor.index, descriptor);
      }
      const pages = await Promise.all([...needed.values()].map(async descriptor => {
        const bytes = await storedBytes(store, `${prefix}pages/${descriptor.digest}.json`, descriptor.digest,
          undefined, view.VIEW_PAGE_BYTES_LIMIT, request, signal);
        const page = view.parsePublicReleasePairViewPage(decode(bytes), pair, request.identity, request.claimDigest);
        if (page.index !== descriptor.index || page.outputs.length !== descriptor.count ||
            page.outputs.reduce((total, output) => total + output.bytes, 0) !== descriptor.bytes ||
            page.outputs[0].path !== descriptor.firstPath || page.outputs.at(-1)!.path !== descriptor.lastPath) readerRefused();
        return page;
      }));
      const descriptors = new Map(pages.flatMap(page => page.outputs.map(output => [output.path, output] as const)));
      const selected = request.paths.map(path => { const output = descriptors.get(path); if (!output) readerRefused(); return output; });
      if (selected.reduce((total, output) => total + output.bytes, 0) > PAIR_READER_BYTES_LIMIT) readerRefused();
      const outputs: ReaderOutput[] = [];
      // Four concurrent object reads bound memory and storage fan-out. The
      // client also partitions by logical bytes, independently of route count.
      for (let offset = 0; offset < selected.length; offset += 4) {
        signal.throwIfAborted();
        outputs.push(...await Promise.all(selected.slice(offset, offset + 4).map(async output => {
          const namespace = output.path.startsWith("/pagefind/") ? "/pagefind/" as const
            : output.path.startsWith("/api/v1/content/") ? "/api/v1/content/" as const : null;
          let bytes: Uint8Array;
          if (namespace) {
            const result = await (await openNamespace(namespace)).readMember(output.path);
            if (result.kind !== "member" || result.member.path !== output.path || result.member.mime !== output.headers["content-type"] ||
                result.member.size !== output.bytes || result.member.sha256 !== output.bodyDigest ||
                output.status !== 200 || result.body.byteLength !== output.bytes || bytesDigest(result.body) !== output.bodyDigest) readerRefused();
            bytes = result.body;
          } else if (root.catalogImages && output.path.startsWith("/_astro/")) {
            const result = await (await openCatalog()).readMember(output.path);
            if (result.member.path !== output.path || result.member.mime !== output.headers["content-type"] || result.member.size !== output.bytes ||
                result.member.sha256 !== output.bodyDigest || output.status !== 200 || result.body.byteLength !== output.bytes || bytesDigest(result.body) !== output.bodyDigest) readerRefused();
            bytes = result.body;
          } else if (output.path.startsWith("/authors/") && output.path.endsWith("/")) {
            if (!root.composite) readerRefused();
            const result = await (await openComposite()).readMember(output.path);
            if (result.member.kind !== "author" || result.member.role !== "auxiliary" || result.member.sha256 !== output.bodyDigest ||
                result.member.size !== output.bytes || result.member.status !== output.status || result.member.mime !== output.headers["content-type"] ||
                (output.headers.location ?? null) !== (result.member.status === 308 ? result.member.owner!.canonicalPath : null)) readerRefused();
            bytes = result.body;
          } else bytes = await storedBytes(store, output.objectKey, output.bodyDigest, output.bytes,
            view.BODY_BYTES_LIMIT, request, signal);
          return { path: output.path, status: output.status, headers: output.headers,
            bodyDigest: bytesDigest(bytes), bytes: bytes.byteLength, bodyBase64: Buffer.from(bytes).toString("base64") };
        })));
      }
      // Revocation, retirement, disabled billing or a changed completed owner
      // during I/O must not leave a successful private receipt.
      if (!same(await authority(), staged)) readerRefused();
      signal.throwIfAborted();
      const body = JSON.stringify({ schemaVersion: 2, kind: "private-pair-read", requestDigest: protocol.publicReleaseDigest(request),
        seals: installed, stagedReadbackDigest: staged.readbackDigest, outputs, namespaceAbsence });
      if (Buffer.byteLength(body) > PAIR_READER_REPLY_LIMIT) readerRefused();
      return new Response(body, { headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
    };
    try {
      return await withinReaderDeadline(signal, run);
    } catch { return new Response('{"error":"private-pair-read-unavailable"}', { status: 503,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" } }); }
  };
}
