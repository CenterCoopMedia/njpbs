import { PUBLIC_PAGES } from "./public-pages.ts";

export interface LaunchLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface LaunchCard {
  title: string;
  description: string;
  href: string;
  image?: string;
  source: "manual" | "media-manager";
}

export interface LaunchFallbackPage {
  slug: string;
  title: string;
  description: string;
  body: string[];
  primaryAction: LaunchLink;
  secondaryAction?: LaunchLink;
  /** Show the saved destination-card region after the page copy. */
  destinationCards?: boolean;
}

// A static transition notice surfaced near the top of the giving-family pages
// (/give/, /support/, /passport/, /donate/). The wording is taken from the FAQ so
// the callout repeats existing donation and Passport guidance rather than
// introducing a new claim. It carries no dismissal behavior and must be updated
// when the underlying transition facts change.
export interface TransitionNotice {
  heading: string;
  paragraphs: string[];
  links: LaunchLink[];
}

export const passportLookupUrl = "https://www.pbs.org/passport/lookup/";

export const givingTransitionNotice: TransitionNotice = {
  heading: "Giving and Passport during the transition",
  paragraphs: [
    "Existing gifts, including one-time and recurring gifts, ended June 30, 2026. If you would like to continue supporting NJ PBS, you will need to set up a new monthly recurring gift or make a one-time donation through the new donation portal. You can also donate by mail. Make checks payable to NJ PBS and mail them to NJ PBS, 1 Normal Ave., Montclair, NJ 07043. A mailed check supports NJ PBS but does not activate PBS Passport; to start or renew Passport streaming, donate through the new donation portal.",
    "PBS manages Passport account status. Use the PBS Passport lookup tool to check an existing account. If access does not appear or a renewal is due, contact NJ PBS for help with the current account or donation path.",
  ],
  links: [
    { label: "See the full transition FAQ", href: "/faq/" },
    { label: "Look up Passport access", href: passportLookupUrl, external: true },
  ],
};

// The giving-family slugs that carry the transition notice above.
export const transitionNoticeSlugs = ["give", "support", "passport", "donate"] as const;

export const donateUrl =
  "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport";
export const passportLearnMoreUrl = "https://watch.njpbs.org/passport/learn-more/";
export const newsletterSignupUrl =
  "https://njpbs.bluelena.io/f/1";
export const pbsAppUrl = "https://www.pbs.org/pbs-app/";
export const pbsKidsUrl = "https://pbskids.org/";
export const pbsLivestreamEmbedUrl =
  "https://player.pbs.org/ga-livestream-partnerplayer/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&feed_cid=4211290e-ce30-49e5-9be1-2c412c5b3278";
// Standalone NJ PBS livestream page on the watch.njpbs.org portal -- the same live
// feed as pbsLivestreamEmbedUrl but served by a different host and player. When the
// player.pbs.org partnerplayer embed is down, 403'd, or blocked, this gives a live
// escape hatch that does not just re-request the failing URL (#189).
export const pbsLivestreamWatchUrl = "https://watch.njpbs.org/livestream/";
export const pbsVideoUrl = "https://watch.njpbs.org/";

export const launchPrimaryNav: LaunchLink[] = [
  { label: "Live", href: "/live/" },
  { label: "Watch on demand", href: pbsVideoUrl, external: true },
  { label: "Schedule", href: "/schedule/" },
  {
    label: "NJ Spotlight News",
    href: "https://www.njspotlightnews.org/",
    external: true,
  },
  { label: "Kids", href: "/kids/" },
  { label: "Support", href: "/support/" },
];

export const launchUtilityLinks: LaunchLink[] = [
  { label: "Donate", href: donateUrl, external: true },
];

export const launchComplianceLinks: LaunchLink[] = [
  { label: "Accessibility", href: "/accessibility/" },
  { label: "Closed captioning", href: "/closed-captioning/" },
  { label: "Privacy policy", href: "/privacy/" },
  { label: "Public file", href: "/public-file/" },
  { label: "EEO report", href: "/eeo/" },
  { label: "Meeting notices", href: "/meeting-notices/" },
];

export const launchCompliancePageSlugs = PUBLIC_PAGES.filter(
  (page) => page.area === "compliance",
).map((page) => page.path.slice(1, -1));

export const launchArticlePageSlugs = [
  ...launchCompliancePageSlugs,
  ...PUBLIC_PAGES.filter(
    (page) => page.family === "article" && page.area !== "compliance",
  ).map((page) => page.path.slice(1, -1)),
];

export const manualLaunchCards: LaunchCard[] = [
  {
    title: "Watch NJ PBS",
    description: "Browse on-demand episodes, specials, and Passport video.",
    href: pbsVideoUrl,
    source: "manual",
  },
  {
    title: "PBS app",
    description: "Use the PBS app and sign in with your New Jersey account.",
    href: pbsAppUrl,
    source: "manual",
  },
  {
    title: "NJ Spotlight News",
    description: "Statewide news continues at the NJ Spotlight News website.",
    href: "https://www.njspotlightnews.org/",
    source: "manual",
  },
  {
    title: "PBS Kids",
    description: "Find PBS Kids videos, games, and family resources.",
    href: "/kids/",
    source: "manual",
  },
];

// Pick the source for the homepage launch-card rails: the synced launch cards
// when the data file holds any, otherwise the in-repo manual cards. This is the
// VOD / launch-card last-resort fallback. The sync script retries a transient
// PBS feed outage and then keeps usable cards from the repository-committed
// snapshot. The manual cards render whenever the resulting data file has no
// selectable cards: a no-credential build, an outage with no usable committed
// snapshot, or a successful sync whose catalog is empty after filtering. They
// make no PBS call. It is a pure function so the homepage and the
// outage-coverage test exercise the same selection, rather than the test
// matching the selection expression in the component source.
export function selectLaunchCards(
  mediaCards: readonly LaunchCard[],
  manual: readonly LaunchCard[],
): readonly LaunchCard[] {
  return mediaCards.length > 0 ? mediaCards : manual;
}

export const launchFallbackPages: Record<string, LaunchFallbackPage> = {
  watch: {
    slug: "watch",
    destinationCards: true,
    title: "Watch NJ PBS",
    description: "Browse NJ PBS programs and PBS series on demand.",
    body: [
      "Use Watch for NJ PBS video you can play on demand: full episodes, specials, documentaries, PBS series, and member video benefits.",
      "Playback, episode availability, Passport access, and sign-in are handled through the PBS video portal so the same account works on the web, the PBS app, and supported devices.",
    ],
    primaryAction: {
      label: "Open PBS video portal",
      href: pbsVideoUrl,
      external: true,
    },
    secondaryAction: {
      label: "Watch live",
      href: "/live/",
    },
  },
  live: {
    slug: "live",
    destinationCards: true,
    title: "PBS Livestream",
    description: "Watch the NJ PBS broadcast stream through PBS live video.",
    body: [
      "The livestream uses PBS playback, location rules, and account services so it works consistently with the PBS app and watch.njpbs.org.",
    ],
    primaryAction: {
      label: "Open PBS livestream",
      href: pbsLivestreamEmbedUrl,
      external: true,
    },
    secondaryAction: {
      label: "See the schedule",
      href: "/schedule/",
    },
  },
  schedule: {
    slug: "schedule",
    destinationCards: true,
    title: "Schedule",
    description: "See what is airing on NJ PBS today and this week.",
    body: [
      "Browse the NJ PBS broadcast schedule below. Listings come from PBS and update through the day, so check back before tuning in, setting a recording, or looking for a program on demand.",
      "Programs air across NJ PBS and its companion channels. After something airs, look for it on demand through the PBS video portal.",
    ],
    primaryAction: {
      label: "Watch live",
      href: "/live/",
    },
    secondaryAction: {
      label: "Watch on demand",
      href: pbsVideoUrl,
      external: true,
    },
  },
  kids: {
    slug: "kids",
    destinationCards: true,
    title: "Kids",
    description: "PBS Kids videos, games, and learning resources for families.",
    body: [
      "PBS Kids offers videos, games, and activities for young viewers, families, caregivers, and teachers.",
      "Use PBS Kids for favorite characters, family-friendly programming, and learning resources built around curiosity and play.",
    ],
    primaryAction: {
      label: "Open PBS Kids",
      href: pbsKidsUrl,
      external: true,
    },
  },
  support: {
    slug: "support",
    destinationCards: true,
    title: "Support NJ PBS",
    description: "Donate, become a member, and support public television in New Jersey.",
    body: [
      "Gifts to NJ PBS support public television programming, statewide storytelling, education, arts, culture, and public affairs.",
      "Online donation processing is handled through PBS, and this site does not collect payment information.",
      "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
    ],
    primaryAction: {
      label: "Donate",
      href: donateUrl,
      external: true,
    },
    secondaryAction: {
      label: "Contact NJ PBS",
      href: "/contact/",
    },
  },
  give: {
    slug: "give",
    destinationCards: true,
    title: "Give to NJ PBS",
    description: "Support public television in New Jersey through NJ PBS membership and donations.",
    body: [
      "Your gift supports trusted PBS programming, statewide reporting, educational media, arts and culture, and public-service broadcasting for New Jersey.",
      "This page is the local NJ PBS giving destination. When you donate online, the payment form opens through PBS so transaction handling and member records stay secure.",
      "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
    ],
    primaryAction: {
      label: "Donate through PBS",
      href: donateUrl,
      external: true,
    },
    secondaryAction: {
      label: "Learn about Passport",
      href: "/passport/",
    },
  },
  donate: {
    slug: "donate",
    destinationCards: true,
    title: "Donate to NJ PBS",
    description: "Make a gift to support public media for New Jersey.",
    body: [
      "Gifts support NJ PBS programming, reporting, education, arts, culture, and public-service broadcasting.",
      "Online donation processing is handled through PBS, and this site does not collect payment information.",
      "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
    ],
    primaryAction: {
      label: "Donate",
      href: donateUrl,
      external: true,
    },
    secondaryAction: {
      label: "Contact NJ PBS",
      href: "/contact/",
    },
  },
  passport: {
    slug: "passport",
    destinationCards: true,
    title: "NJ PBS Passport",
    description: "Learn how the PBS Passport member benefit works for NJ PBS supporters.",
    body: [
      "PBS Passport is a member benefit that gives eligible donors extended access to a library of PBS programs, films, and specials.",
      "Support NJ PBS to start or renew access, or use the PBS lookup tool if you already donate and need help finding your Passport account.",
    ],
    primaryAction: {
      label: "Donate through PBS",
      href: donateUrl,
      external: true,
    },
    secondaryAction: {
      label: "Find Passport access",
      href: passportLookupUrl,
      external: true,
    },
  },
  about: {
    slug: "about",
    title: "About NJ PBS",
    description:
      "New Jersey's public television service: the member stations, how to watch and support, and Montclair State University's new role.",
    body: [
      "NJ PBS is New Jersey's public television service. It carries PBS programs, local stories, arts and culture, education, and statewide public affairs to viewers across the state and the surrounding region.",
      "Use this site to watch live and on demand, check the broadcast schedule, follow statewide reporting from NJ Spotlight News, explore PBS Kids, and support public media in New Jersey.",
    ],
    primaryAction: {
      label: "Support NJ PBS",
      href: "/give/",
    },
    secondaryAction: {
      label: "NJ Spotlight News",
      href: "https://www.njspotlightnews.org/",
      external: true,
    },
  },
};

export const launchFallbackRoutePages: readonly LaunchFallbackPage[] = Object.values(
  launchFallbackPages,
).filter((page) => page.slug !== "schedule");
