import { createReaderInstallAdapter } from "./cms-reader-first-install-adapter.mjs";
import { readCmsReaderProviderIdentities } from "./cms-reader-provider-readback.mjs";
import { readerCredentialPipe, parseReaderCredentialPipeManifest } from "./cms-reader-install-credential.mjs";

// Replaced only by the offline builder. There is no runtime environment or
// request-supplied configuration, command, credential value or provider URL.
const config = READER_INSTALL_ADAPTER_CONFIG;
const pipes = new Map();
const purposes = { none: [], "reader-prove": [4, 12, 13, 14], "reader-install": [4, 12], "preview-bootstrap": [4, 12] };
function closePipes() { for (const pipe of pipes.values()) pipe.close(); pipes.clear(); }
export function prepareCredentialPipes({ purpose, signal }) {
  if (!Object.hasOwn(purposes, purpose) || pipes.size) throw new Error("CMS reader credential pipes unavailable");
  if (purposes[purpose].length) {
    const manifest = parseReaderCredentialPipeManifest(process.env.CMS_READER_CREDENTIAL_PIPES);
    try { for (const fd of purposes[purpose]) pipes.set(fd, readerCredentialPipe(fd, signal, manifest[fd])); }
    catch { closePipes(); throw new Error("CMS reader credential pipes unavailable"); }
  }
  return closePipes;
}
const readPipe = fd => async () => {
  const pipe = pipes.get(fd);
  if (!pipe) throw new Error("CMS reader credential pipes unavailable");
  return pipe.read();
};
export async function openBridgeInstallAdapter({ firestore, signal }) {
  const adapter = await createReaderInstallAdapter({ firestore, config, signal, readStaffToken: readPipe(13), readEdgeSecret: readPipe(14),
    readProviders: () => readCmsReaderProviderIdentities({ ...config, signal, readCloudflareToken: readPipe(4), readGoogleToken: readPipe(12) }) });
  return Object.freeze({ ...adapter, close: closePipes });
}

export async function prepareInstalledConsumers({ firestore, request, signal }) {
  const adapter = await openBridgeInstallAdapter({ firestore, signal });
  try { return await adapter.prepareInstalledConsumers({ request }); }
  finally { adapter.close(); }
}
