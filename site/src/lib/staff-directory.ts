import { authorPublicPath } from "../../../packages/content-core/src/author-profiles";

export type StaffSocialPlatform = "x" | "bluesky" | "linkedin";

export interface StaffDirectorySource {
  profilePageReady?: boolean;
  authorId: string;
  slug: string;
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  photo: {
    url: string;
    displayUrl: string;
    width: number;
    height: number;
    focalX: number;
    focalY: number;
    credit: string | null;
  } | null;
  links: readonly { platform: StaffSocialPlatform; url: string }[];
}

export interface StaffDirectoryEntry extends StaffDirectorySource {
  path: string;
  initials: string;
}

export function staffProfileHref(person: StaffDirectoryEntry): string | undefined {
  return person.profilePageReady === false ? undefined : person.path;
}

/**
 * The initials shown when a public profile has no approved photograph.
 *
 * The author loader already requires a non-empty display name, but the fallback
 * remains total so a component preview or test fixture cannot render a blank
 * portrait. Two words are enough to distinguish most names without turning a
 * long name into an unreadable monogram.
 */
export function staffInitials(displayName: string): string {
  const initials = displayName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("en-US") ?? "")
    .join("");

  return initials || "NJ";
}

const staffNameCollator = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base",
});

/** Alphabetical by public name, with a stable identity tie-break. */
export function compareStaffDirectoryEntries(
  left: Pick<StaffDirectoryEntry, "displayName" | "authorId">,
  right: Pick<StaffDirectoryEntry, "displayName" | "authorId">,
): number {
  const byName = staffNameCollator.compare(left.displayName, right.displayName);
  if (byName !== 0) return byName;
  if (left.authorId === right.authorId) return 0;
  return left.authorId < right.authorId ? -1 : 1;
}

/**
 * Project detached public author snapshots into the fixed `/staff/` directory.
 *
 * No private staff or account collection is read here. That boundary matters:
 * the directory can only show a profile that has already passed the public
 * snapshot projection and therefore cannot leak an email, CMS role, uid, grant,
 * or private status.
 */
export function staffDirectoryEntries(
  authors: readonly StaffDirectorySource[],
): StaffDirectoryEntry[] {
  return authors
    .map((author) => ({
      ...author,
      path: authorPublicPath(author.slug),
      initials: staffInitials(author.displayName),
      links: [...author.links],
    }))
    .sort(compareStaffDirectoryEntries);
}
