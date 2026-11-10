# Browser meaning search

Import `createMeaningSearch` from `index.ts`. Call `start()` when the search surface mounts, then `prepare([{ id, text, vector? }])` and `search(query, { limit, minScore })`. There is no opt-in control. Await both startup and preparation before reporting ready. Keyword search stays available while the model loads or if it fails.

`prepare` replaces the corpus and reuses unchanged document vectors. It retains the completed index while new passages encode, answers the latest question between encodes, and immediately removes IDs absent from the replacement corpus. New questions supersede older questions with `AbortError`. New preparations supersede older preparations. A timeout or worker error clears the worker; retry startup and preparation explicitly.

Each worker also keeps at most 32 normalized query vectors. Repeating a query
reuses its vector, then ranks the current rows again; search results are never
cached. Disposing the worker clears this query cache with the private document
vectors. It does not persist across reloads.

Call `dispose()` on unmount, sign-out, or permission changes. This terminates the worker and rejects pending calls. Search state keeps private text, queries and document vectors in memory only; the library writes none of these to browser storage or a provider. The only persistent cache belongs to public Hugging Face model artifacts. Consumers must not serialize private documents into public assets.

The encoder is BGE small English v1.5 q8 at the immutable revision in `contracts.ts`, with 384 dimensions and normalized mean pooling. Queries use the retrieval instruction prefix; passages do not. The worker uses bundled Transformers.js 4.3.0 and locally emitted ONNX Runtime assets with one WASM thread. Both consuming builds must resolve these dependencies from this shared directory.

Inputs are bounded to 10,000 documents, 6,000 characters and four overlapping chunks per document, and 500 characters per query. Transcript callers must supply timestamped passages as separate documents; do not pass one full-length transcript and expect its middle to be indexed. Public precomputed vectors must use the same model revision and pooling. The default similarity floor is 0.5; callers can supply a corpus-tested floor. Public and guide checks currently use 0.55.

Focused tests: `npx vitest run packages/browser-search/meaning-search.test.ts`.
