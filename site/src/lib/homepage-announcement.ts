// Published announcement copy shared by page layouts. Keep its wording aligned
// with the linked public source.

export interface HomepageAnnouncementLink {
  href: string;
  label: string;
}

export interface HomepageAnnouncementCopy {
  ariaLabel: string;
  eyebrow: string;
  heading: string;
  aboutDescription: string;
  link: HomepageAnnouncementLink;
  surfaceColor: string;
  copyColor: string;
  linkColor: string;
  foregrounds: { color: string; large: boolean }[];
}

export const HOMEPAGE_ANNOUNCEMENT: HomepageAnnouncementCopy = {
  ariaLabel: "NJ Spotlight acquisition announcement",
  eyebrow: "Announcement",
  heading: "Montclair State University will acquire NJ Spotlight.",
  aboutDescription:
    "Montclair State University will acquire NJ Spotlight and has committed to continuing its watchdog journalism through NJ PBS.",
  link: {
    label: "Read the announcement",
    href:
      "https://inside.montclair.edu/news/montclair-state-university-acquire-nj-spotlight-commits-continuing-its-watchdog-journalism-through",
  },
  surfaceColor: "var(--color-announcement-surface)",
  copyColor: "var(--color-announcement-copy)",
  linkColor: "var(--color-announcement-link)",
  foregrounds: [
    { color: "var(--text)", large: false },
    { color: "var(--color-announcement-copy)", large: false },
    { color: "var(--color-announcement-link)", large: false },
  ],
};

export function announcementTextStrings(
  announcement: HomepageAnnouncementCopy = HOMEPAGE_ANNOUNCEMENT,
): string[] {
  return [
    announcement.eyebrow,
    announcement.heading,
    announcement.aboutDescription,
    announcement.link.label,
  ];
}
