// How an author is shown: their photograph when there is one, their initials when
// there is not.
//
// This is the one place that decides between the two, so every avatar in the admin
// changes together. A stored asset id alone is never enough -- without a resolved
// address there is nothing to draw -- so the decision is made on the URL, and a
// profile whose photograph has been removed falls back to initials rather than to
// a broken frame.

export interface AvatarPhoto {
  kind: "photo";
  url: string;
  initials: string;
  /** CSS `object-position` for the 1:1 crop, from the stored focal point. */
  objectPosition: string;
}

export interface AvatarInitials {
  kind: "initials";
  initials: string;
}

export type AvatarPresentation = AvatarPhoto | AvatarInitials;

/**
 * Up to two initials for a name. Falls back to the station's letters so an avatar is
 * never blank, which would read as a broken image rather than a person without a photo.
 */
export function authorInitials(name: string): string {
  return (
    String(name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "NP"
  );
}

/**
 * Turn a stored focal point into a CSS `object-position`. A focal point is how the
 * 1:1 crop is applied: the image is never re-encoded, so the same original serves
 * every avatar size and the person stays in frame at each of them. An unstated or
 * out-of-range coordinate centers rather than throwing -- a photograph with an odd
 * crop is still better than no photograph.
 */
export function focalObjectPosition(
  focalX: number | null | undefined,
  focalY: number | null | undefined,
): string {
  const axis = (value: number | null | undefined): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : 0.5;
  return `${Math.round(axis(focalX) * 100)}% ${Math.round(axis(focalY) * 100)}%`;
}

/**
 * Decide what an avatar shows. A stored photo asset id alone is not enough: without a
 * resolved URL there is no image to draw, so initials stand in.
 */
export function avatarPresentation({
  displayName,
  photoUrl = null,
  focalX = null,
  focalY = null,
}: {
  displayName: string;
  photoUrl?: string | null;
  focalX?: number | null;
  focalY?: number | null;
}): AvatarPresentation {
  const initials = authorInitials(displayName);
  const url = typeof photoUrl === "string" ? photoUrl.trim() : "";
  return url === ""
    ? { kind: "initials", initials }
    : {
        kind: "photo",
        url,
        initials,
        objectPosition: focalObjectPosition(focalX, focalY),
      };
}
