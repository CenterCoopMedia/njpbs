import { env, pipeline } from '@huggingface/transformers';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import wasmModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { MODEL_ID, MODEL_REVISION, type MeaningRequest } from './contracts';
import { createMeaningRuntime } from './runtime';

// Only immutable, public model files use persistent browser caching. The model
// runs here; neither passage text nor query text is sent to a provider.
env.allowLocalModels = false;
// Pin the URL template so metadata probes and weights use the same immutable tree.
env.remotePathTemplate = `{model}/resolve/${MODEL_REVISION}/`;
env.useBrowserCache = true;
env.useWasmCache = false;
const wasm = env.backends.onnx.wasm;
if (wasm) {
  wasm.numThreads = 1;
  wasm.proxy = false;
  wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
}

const receive = createMeaningRuntime(async progress => {
  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    revision: MODEL_REVISION,
    dtype: 'q8',
    device: 'wasm',
    progress_callback: event => {
      if (event.status === 'progress') progress({ phase: 'download', loaded: event.loaded, total: event.total });
    },
  });
  return async text => {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Float32Array.from(output.data as Float32Array);
  };
}, message => globalThis.postMessage(message));

globalThis.addEventListener('message', event => receive((event as MessageEvent<MeaningRequest>).data));
