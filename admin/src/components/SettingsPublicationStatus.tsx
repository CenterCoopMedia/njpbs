import type { SettingsPublicationReceipt } from "../lib/functions";
import { AsyncActionButton, InlineMessage } from "./ui/Primitives";

const PUBLIC_CHECK_LABELS = {
  pages: "pages", posts: "posts", home: "the homepage", listings: "listings", authors: "author pages",
  feed: "the news feed", contentApi: "the content API", sitemap: "the sitemap", search: "search",
};
const checkList = new Intl.ListFormat("en", { type: "conjunction" });

export function SettingsPublicationStatus({ publication, retry, retrying, disabled, refresh, needsRefresh }: {
  publication: SettingsPublicationReceipt | null; retry: () => Promise<void>; retrying: boolean; disabled: boolean;
  refresh: () => Promise<void>; needsRefresh: boolean;
}) {
  if (!publication) return null;
  const missing = Object.entries(PUBLIC_CHECK_LABELS).filter(([name]) => publication.missingConsumers.includes(name)).map(([, label]) => label);
  const remaining = !needsRefresh && missing.length > 0 ? `Public checks remain for ${checkList.format(missing)}.` : null;
  if (publication.warning || publication.status === "failed") return <InlineMessage tone="warning" className="settings-publication-warning">
    <p><span>{publication.warning ?? "The site update did not complete. Retry publication."}</span>
      {remaining && <><br />{remaining}</>}
    </p>
    <AsyncActionButton label={needsRefresh ? "Refresh site update" : "Retry site update"} type="button" variant="secondary"
      onClick={() => void (needsRefresh ? refresh() : retry())} pending={retrying} disabled={retrying || disabled}
      pendingLabel={needsRefresh ? "Checking…" : "Retrying…"}
      pendingAnnouncement={needsRefresh ? "Checking the site update. Your draft will stay as it is." : "Retrying the accepted site update."} />
  </InlineMessage>;
  if (publication.status === "success") return <InlineMessage tone="success">The site update is complete.</InlineMessage>;
  return <InlineMessage tone="info" role="status">Updating the site. {remaining}</InlineMessage>;
}
