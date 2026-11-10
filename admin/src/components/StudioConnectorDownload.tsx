import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useShell } from "../routes/ShellContext";
import { canUseLiveProduction } from "../lib/live-production-access";
import { postFunction } from "../lib/functions";
import { Button, InlineMessage } from "./ui/Primitives";
import "./StudioConnectorDownload.css";

declare const __ADMIN_SOURCE_REVISION__: string | null | undefined;

type PackageDetails = { available: true; sourceSha: string; sha256: string; bundleSha256: string;
  filename: string; sizeBytes: number; nodeVersion: string };
type PackageResult = PackageDetails | { available: false; sourceSha: string };
type DownloadResult = PackageDetails & { url: string; expiresAtMs: number };
export type ConnectorTransport = (action: "get_connector_package" | "create_connector_download", sourceSha: string, signal?: AbortSignal) => Promise<PackageResult | DownloadResult>;

function startDownload(result: DownloadResult) {
  const url = new URL(result.url);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".r2.cloudflarestorage.com") || url.username || url.password) {
    throw new Error("The download address is unavailable.");
  }
  const link = document.createElement("a");
  link.href = url.href;
  link.download = result.filename;
  link.referrerPolicy = "no-referrer";
  link.rel = "noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
}

export function StudioConnectorDownload({ send, sourceSha, save = startDownload }: {
  send: ConnectorTransport; sourceSha: string | null; save?: (result: DownloadResult) => void;
}) {
  const heading = useId();
  const [details, setDetails] = useState<PackageResult | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [requested, setRequested] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const downloadController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDetails(null); setError(false); setLoading(true); setRequested(false);
    if (!sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha)) { setLoading(false); return () => controller.abort(); }
    send("get_connector_package", sourceSha, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.sourceSha !== sourceSha) throw new Error("Connector version differs.");
      setDetails(result);
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); downloadController.current?.abort(); };
  }, [send, sourceSha, refresh]);
  async function download() {
    if (!details?.available || !sourceSha || downloading) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(true); setError(false); setRequested(false);
    try {
      const result = await send("create_connector_download", sourceSha, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.available || !("url" in result) || result.sourceSha !== sourceSha || result.sha256 !== details.sha256) {
        throw new Error("Connector download differs.");
      }
      save(result);
      setRequested(true);
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setDownloading(false); }
  }
  return <section className="studio-connector-download live-connection" aria-labelledby={heading}>
    <h3 id={heading}>Studio connector for Windows</h3>
    <p>Install this small program on the studio vMix PC. It needs no administrator rights and connects out to Boardwalk.</p>
    {loading && <p role="status">Checking the Studio connector download…</p>}
    {!loading && !error && !details?.available && <InlineMessage tone="info" role="status">The download for this Boardwalk version is not available yet. Contact the setup operator.</InlineMessage>}
    {error && <InlineMessage tone="error">The Studio connector download could not be prepared. Try again or contact the setup operator.</InlineMessage>}
    <div className="live-actions">
      <Button variant="primary" disabled={loading || downloading || !details?.available} onClick={() => void download()}>
        {downloading ? "Preparing download…" : "Download for Windows"}
      </Button>
      {error && <Button disabled={loading || downloading} onClick={() => setRefresh(value => value + 1)}>Try again</Button>}
    </div>
    {requested && <p role="status">Your download should start. Open READ ME FIRST.txt in the extracted folder.</p>}
    <ol>
      <li>Extract the ZIP on the studio PC, then double-click <strong>Set up Studio connector</strong>.</li>
      <li>Choose or create the program’s session below, then follow the hidden pairing prompt and Studio setup steps. Verify the connection before making the session active.</li>
      <li>Open <strong>Start Studio connector</strong> for each show. To stop, press Ctrl+C and wait for it to finish.</li>
    </ol>
    <p>Run the first test off air. Keep the same Windows account. Setup includes a self-test and the full test guide.</p>
    {details?.available && <dl className="studio-connector-package-details">
      <div><dt>Source version</dt><dd><code>{details.sourceSha}</code></dd></div>
      <div><dt>ZIP SHA-256</dt><dd><code>{details.sha256}</code></dd></div>
      <div><dt>Download size</dt><dd>{(details.sizeBytes / 1024 / 1024).toFixed(1)} MiB · Includes Node {details.nodeVersion}</dd></div>
    </dl>}
  </section>;
}

export function ConnectedStudioConnectorDownload() {
  const { getIdToken, principal } = useShell();
  const send = useCallback<ConnectorTransport>(async (action, sourceSha, signal) => {
    if (!getIdToken) throw new Error("Sign in again to download the Studio connector.");
    return postFunction<PackageResult | DownloadResult>("cmsLiveProduction", await getIdToken(), { action, sourceSha }, {},
      { signal, operation: "settings-read" });
  }, [getIdToken]);
  if (!canUseLiveProduction(principal)) return null;
  const sourceSha = typeof __ADMIN_SOURCE_REVISION__ === "string" ? __ADMIN_SOURCE_REVISION__ : null;
  return <StudioConnectorDownload send={send} sourceSha={sourceSha} />;
}
