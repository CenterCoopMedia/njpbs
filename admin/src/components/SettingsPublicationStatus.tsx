import type { SettingsPublicationReceipt } from "../lib/functions";
import { AsyncActionButton, InlineMessage } from "./ui/Primitives";

export function SettingsPublicationStatus({ publication, retry, retrying, disabled, refresh, needsRefresh }: {
  publication: SettingsPublicationReceipt | null; retry: () => Promise<void>; retrying: boolean; disabled: boolean;
  refresh: () => Promise<void>; needsRefresh: boolean;
}) {
  if (!publication) return null;
  if (publication.warning || publication.status === "failed") return <InlineMessage tone="warning" className="settings-publication-warning">
    <p>{publication.warning ?? "The site update did not complete. Retry publication."}</p>
    <AsyncActionButton label={needsRefresh ? "Refresh site update" : "Retry site update"} type="button" variant="secondary"
      onClick={() => void (needsRefresh ? refresh() : retry())} pending={retrying} disabled={retrying || disabled}
      pendingLabel={needsRefresh ? "Checking…" : "Retrying…"}
      pendingAnnouncement={needsRefresh ? "Checking the site update. Your draft will stay as it is." : "Retrying the accepted site update."} />
  </InlineMessage>;
  if (publication.status === "success") return <InlineMessage tone="success">The site update is complete.</InlineMessage>;
  return <InlineMessage tone="info" role="status">Updating the site. The saved settings will be complete after all public pages update.</InlineMessage>;
}
