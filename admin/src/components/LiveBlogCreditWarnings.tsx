import type { StoryCredit } from "../../../packages/content-core/src/story-credits";
import type { BylineAuthorOption } from "../lib/functions";
import { ROUTE_PATHS } from "../lib/routes";
import { AUTHOR_PAGES_LIVE } from "../lib/author-profile-release";
import { InlineMessage } from "./ui/Primitives";

function words(items: string[]): string {
  return items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Advisory only: profile completeness never changes live-blog save or publish admission. */
export function LiveBlogCreditWarnings({ credits, authors = [], authorsLoading = false, selfAuthorId, canManageAuthorProfiles = false, label }: {
  credits: readonly StoryCredit[];
  authors?: readonly BylineAuthorOption[];
  authorsLoading?: boolean;
  selfAuthorId?: string | null;
  canManageAuthorProfiles?: boolean;
  label: string;
}) {
  const seen = new Set<string>();
  let hasProfileNotice = false;
  const notices = credits.flatMap(credit => {
    const key = credit.kind === "registered" ? credit.authorId : `custom:${credit.name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    if (credit.kind === "custom") return [<p key={key} className="editor-field-help">
      {credit.name}: Readers see the PBS logo instead of a reporter photo.
    </p>];
    if (authorsLoading) return [];
    const author = authors.find(item => item.authorId === credit.authorId);
    const name = author?.displayName ?? credit.displayName ?? "This reporter";
    const readiness = author?.profileReadiness;
    const missing = readiness ? [
      ...(!readiness.hasPhoto ? ["a photo"] : []),
      ...(!readiness.hasJobTitle ? ["a job title"] : []),
      ...(!readiness.hasBio ? ["a bio"] : []),
    ] : [];
    if (readiness?.published && missing.length === 0) return [];
    hasProfileNotice = true;
    const description = readiness
      ? `${missing.length ? `${name}’s author profile is missing ${words(missing)}. ` : ""}${!readiness.published ? `${name}’s author profile is not published. ` : ""}${!readiness.published || !readiness.hasPhoto ? "Readers will see a placeholder." : "The reporter card will be incomplete."}`
      : `${name}’s author profile could not be checked. Readers may see a placeholder.`;
    const href = credit.authorId === selfAuthorId ? ROUTE_PATHS.accountProfile
      : `${ROUTE_PATHS.authorProfiles}?authorId=${encodeURIComponent(credit.authorId)}`;
    return [<InlineMessage key={key} tone="warning"><p>{description}{" "}
      {canManageAuthorProfiles || credit.authorId === selfAuthorId ? <><a href={href} target="_blank" rel="noopener noreferrer">Edit {name}’s author profile</a>{" "}(opens in a new tab).</>
        : "Ask a profile manager to update this profile."}{" "}
      {!AUTHOR_PAGES_LIVE && !canManageAuthorProfiles && credit.authorId === selfAuthorId && readiness?.published === false
        ? "Ask a profile manager to publish this profile. " : null}These notices do not prevent publication.
    </p></InlineMessage>];
  });
  return notices.length ? <div role="group" aria-label={label}>{notices}
    {hasProfileNotice ? <p className="editor-field-help">Profile details update when you reload Boardwalk. Save this draft before reloading after a profile edit.</p> : null}
  </div> : null;
}
