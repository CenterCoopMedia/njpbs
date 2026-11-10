import { postCardImage } from "./post-card-image.ts";
import { contentLink, contentLinkMetadata } from "./content-link.ts";
import { postCoverageLabelId } from "./coverage-label-id.ts";
import { isCalendarDay } from "./editorial-dates.ts";
import { storyCreditsByline, STORY_CREDITS_MAX, STORY_CREDIT_NAME_MAX } from "./story-credits.ts";
import { curateHomeSource, homeSourceImage, homeSourceInstant, homeSourceObject, homeSourceText,
  type HomeSourceCard, type HomeCuratedSource, type HomeSourceSelection } from "./home-source-curation.ts";

type StationPostSnapshot = { status: "ready"; checkedAt: string; posts: readonly unknown[] } | { status: "error" };

/** Consume projectCmsPost's frozen public projections, never cmsPosts working documents. */
export function adaptHomeStationPosts(snapshot: StationPostSnapshot, selection: HomeSourceSelection): HomeCuratedSource {
  if (snapshot.status === "error") return curateHomeSource("home-posts", snapshot, selection);
  if (snapshot.status !== "ready" || !Array.isArray(snapshot.posts)) throw new Error("Station Post source is invalid.");
  const cutoff = homeSourceInstant(selection.cutoffAt);
  if (cutoff === null) throw new Error("Station Post cutoff is invalid.");
  const entries = snapshot.posts.flatMap(value => {
    if (!homeSourceObject(value) || value.noindex !== false || !homeSourceText(value.postId, 128) || !homeSourceText(value.title, 300) ||
      !homeSourceText(value.path, 2048) || !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(value.path) || !Number.isSafeInteger(value.sourceVersion) || Number(value.sourceVersion) < 1 ||
      !Array.isArray(value.credits) || value.credits.length > STORY_CREDITS_MAX ||
      value.credits.some(credit => !homeSourceObject(credit) || !homeSourceText(credit.name, STORY_CREDIT_NAME_MAX))) return [];
    const published = homeSourceInstant(value.publishedAt);
    const sortInstant = value.sortInstant;
    if (published === null || published > cutoff || (sortInstant !== null && !Number.isSafeInteger(sortInstant)) ||
      value.displayDate != null && !isCalendarDay(value.displayDate)) return [];
    const byline = storyCreditsByline(value.credits.map(credit => ({ kind: "custom" as const, name: credit.name as string })));
    const selectedImage = postCardImage({ ...value,
      assets: homeSourceObject(value.assets) ? value.assets : undefined });
    const leadImage = selectedImage && homeSourceObject(selectedImage.image)
      ? homeSourceImage({ ...selectedImage.image, alt: selectedImage.alt }) : undefined;
    const image = leadImage ?? (homeSourceObject(value.heroBackgroundImage)
      ? homeSourceImage({ url: value.heroBackgroundImage.url, alt: "" }) : undefined);
    const summary = homeSourceText(value.summary, 10000) ? value.summary
      : homeSourceText(value.excerpt, 10000) ? value.excerpt : undefined;
    const card: HomeSourceCard = { id: value.postId, source: "station_posts", sourceVersion: Number(value.sourceVersion),
      title: value.title, href: contentLink(value as never, value.path).href,
      ...contentLinkMetadata(value), publishedAt: value.publishedAt as string,
      ...(postCoverageLabelId(value) ? { coverageLabelId: postCoverageLabelId(value) } : {}),
      sourceLabel: value.spotlightNews === true ? "NJ Spotlight News" : "NJ PBS",
      ...(summary ? { summary } : {}),
      ...(isCalendarDay(value.displayDate) ? { displayDate: value.displayDate } : {}),
      ...(byline ? { byline } : {}), ...(image ? { image } : {}) };
    return [{ card, sortInstant: sortInstant as number | null }];
  });
  // Same ordering as the Post index: trusted editorial sort instant, unknown dates last, ID ties.
  entries.sort((a, b) => a.sortInstant === null && b.sortInstant !== null ? 1
    : b.sortInstant === null && a.sortInstant !== null ? -1
    : (b.sortInstant ?? 0) - (a.sortInstant ?? 0) || a.card.id.localeCompare(b.card.id));
  return curateHomeSource("home-posts", { status: "ready", checkedAt: snapshot.checkedAt, cards: entries.map(entry => entry.card) }, selection);
}
