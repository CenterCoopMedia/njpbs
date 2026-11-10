import { useId, useState } from "react";
import { Button } from "./ui/Primitives";
import type { LiveBlogDraft } from "../../../packages/content-core/src/live-blog-draft";
import type { BylineAuthorOption } from "../lib/functions";
import { LiveBlogCreditWarnings } from "./LiveBlogCreditWarnings";

/**
 * The direct live-update action. The host renders it only for staff with Editor
 * access on a published live blog; the save boundary enforces the same rule.
 */
export function LiveBlogDirectPublish({ disabledReason, onPublish, liveBlog, authors, authorsLoading, selfAuthorId, canManageAuthorProfiles }: {
  disabledReason?: string;
  onPublish: () => Promise<void>;
  liveBlog?: LiveBlogDraft;
  authors?: readonly BylineAuthorOption[];
  authorsLoading?: boolean;
  selfAuthorId?: string | null;
  canManageAuthorProfiles?: boolean;
}) {
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function publish() {
    if (pending || disabledReason) return;
    setPending(true);
    setError("");
    try {
      await onPublish();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "The live updates were not published.");
    } finally {
      setPending(false);
    }
  }
  return <section className="live-blog-direct-publish" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Publish live updates now</h3>
    <p id={`${id}-help`}>Your access lets you publish new updates, follow-ups, corrections, withdrawals, coverage status and live blog appearance without another approval. The Post’s publication status shows when the public site confirms them. Changes to the Post title, summary, body, lead media, URL or coverage branding still need review and approval.</p>
    {disabledReason ? <p id={`${id}-reason`}>{disabledReason}</p> : null}
    {error ? <p className="error-text" role="alert">{error}</p> : null}
    <LiveBlogCreditWarnings credits={liveBlog?.updates.filter(entry => entry.withdrawal === undefined).flatMap(entry => [...entry.credits, ...(entry.followUps ?? []).filter(item => item.withdrawal === undefined).flatMap(item => item.credits)]) ?? []}
      authors={authors} authorsLoading={authorsLoading} selfAuthorId={selfAuthorId} canManageAuthorProfiles={canManageAuthorProfiles} label="Reporter profiles before publishing" />
    <div className="button-row">
      <Button variant="primary" disabled={pending || Boolean(disabledReason)} aria-describedby={disabledReason ? `${id}-help ${id}-reason` : `${id}-help`}
        onClick={() => { void publish(); }}>{pending ? "Requesting publication…" : "Publish live updates now"}</Button>
    </div>
  </section>;
}
