import type {
  CardGridData,
  CtaRowData,
  FaqItemData,
  PageBlock,
  RichTextDoc,
} from "./content-model";
import { contactPageFallback } from "./contact-page-fallback";
import { publicPage, type PublicPageId } from "./public-pages";

export interface PageSeedAsset {
  id: string;
  publicPath: string;
  sourceUrl: string;
  mimeType: "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

export interface PageCompositionSeed {
  pageId: PublicPageId;
  capturedAt: string;
  sourcePath: string;
  metadata: Record<string, unknown>;
  blocks: PageBlock[];
}

export interface PageCompositionFixedRegion {
  label: string;
  detail: string;
}

function prose(...paragraphs: string[]): RichTextDoc {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

function proseWithLink(
  paragraphs: string[],
  linkLabel: string,
  href: string,
): RichTextDoc {
  return {
    type: "doc",
    content: [
      ...paragraphs.map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: linkLabel,
            marks: [{ type: "link", attrs: { href } }],
          },
        ],
      },
    ],
  };
}

function section(heading: string, ...paragraphs: string[]): RichTextDoc {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
      ...paragraphs.map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    ],
  };
}

function linkedSection(
  heading: string,
  paragraph: string,
  linkLabel: string,
  href: string,
): RichTextDoc {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
      { type: "paragraph", content: [{ type: "text", text: paragraph }] },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: linkLabel,
            marks: [{ type: "link", attrs: { href } }],
          },
        ],
      },
    ],
  };
}

function sectionWithLinks(
  heading: string,
  paragraphs: string[],
  links: Array<{ label: string; href: string }>,
): RichTextDoc {
  const linkParagraphs: RichTextDoc["content"] = links.map(({ label, href }) => ({
    type: "paragraph",
    content: [
      {
        type: "text",
        text: label,
        marks: [{ type: "link", attrs: { href } }],
      },
    ],
  }));
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
      ...paragraphs.map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
      ...linkParagraphs,
    ],
  };
}

function ctaRow(
  pageId: PublicPageId,
  region: string,
  order: number,
  ctas: CtaRowData["ctas"],
): PageBlock {
  return {
    id: `tmp-seed-${pageId}-${region}`,
    type: "cta_row",
    section: region,
    order,
    visible: true,
    data: { ctas },
  };
}

function proseRegion(
  pageId: PublicPageId,
  region: string,
  order: number,
  content: RichTextDoc,
): PageBlock {
  return {
    id: `tmp-seed-${pageId}-${region}`,
    type: "prose",
    section: region,
    order,
    visible: true,
    data: { content },
  };
}

function faqItem(
  pageId: PublicPageId,
  region: string,
  order: number,
  question: string,
  answer: FaqItemData["answer"],
): PageBlock {
  return {
    id: `tmp-seed-${pageId}-${region}`,
    type: "faq_item",
    section: region,
    order,
    visible: true,
    data: { question, answer },
  };
}

function headline(
  pageId: PublicPageId,
  region: string,
  order: number,
  text: string,
  level = 2,
): PageBlock {
  return {
    id: `tmp-seed-${pageId}-${region}`,
    type: "headline",
    section: region,
    order,
    visible: true,
    data: { text, level },
  };
}

function cardGrid(
  pageId: PublicPageId,
  region: string,
  order: number,
  cards: CardGridData["cards"],
): PageBlock {
  return {
    id: `tmp-seed-${pageId}-${region}`,
    type: "card_grid",
    section: region,
    order,
    visible: true,
    data: { cards },
  };
}

function seed(
  pageId: PublicPageId,
  title: string,
  description: string,
  seoDescription: string,
  blocks: PageBlock[],
  seo: { noindex?: boolean } = {},
): PageCompositionSeed {
  const definition = publicPage(pageId);
  if (!definition) throw new Error(`Missing public page definition for ${pageId}`);
  return {
    pageId,
    capturedAt: "2026-08-05",
    sourcePath: definition.path,
    metadata: {
      title,
      description,
      seo: { description: seoDescription, ...seo },
    },
    blocks,
  };
}

function seedAsset(id: string, fileName: string): PageSeedAsset {
  const publicPath = `/brand/spotlight/${fileName}`;
  return Object.freeze({
    id,
    publicPath,
    sourceUrl: `https://njpbs.org${publicPath}`,
    mimeType: "image/jpeg",
    width: 640,
    height: 360,
  });
}

function homeStartAsset(id: string, fileName: string): PageSeedAsset {
  const publicPath = `/brand/starthere/${fileName}`;
  return Object.freeze({
    id,
    publicPath,
    sourceUrl: `https://njpbs.org${publicPath}`,
    mimeType: "image/webp",
    width: 800,
    height: 450,
  });
}

const PAGE_SEED_ASSETS: Readonly<Record<string, PageSeedAsset>> = Object.freeze({
  "launch-watch": seedAsset("launch-watch", "watch.jpg"),
  "launch-support": seedAsset("launch-support", "support.jpg"),
  "launch-under-the-dome": seedAsset("launch-under-the-dome", "under-the-dome.jpg"),
  "launch-about": seedAsset("launch-about", "about.jpg"),
  "launch-give": seedAsset("launch-give", "give.jpg"),
  "launch-passport": seedAsset("launch-passport", "passport.jpg"),
  "launch-contact": seedAsset("launch-contact", "contact.jpg"),
  "launch-politics": seedAsset("launch-politics", "politics.jpg"),
  "home-start-live": homeStartAsset("home-start-live", "live.webp"),
  "home-start-ondemand": homeStartAsset("home-start-ondemand", "ondemand.webp"),
  "home-start-schedule": homeStartAsset("home-start-schedule", "schedule.webp"),
  "home-start-kids": homeStartAsset("home-start-kids", "kids.webp"),
});

const DONATE_URL =
  "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport";
const PASSPORT_LEARN_MORE_URL = "https://watch.njpbs.org/passport/learn-more/";
const PASSPORT_LOOKUP_URL = "https://www.pbs.org/passport/lookup/";
const PBS_LIVESTREAM_URL =
  "https://player.pbs.org/ga-livestream-partnerplayer/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&feed_cid=4211290e-ce30-49e5-9be1-2c412c5b3278";
const NJ_SPOTLIGHT_ANNOUNCEMENT_URL =
  "https://inside.montclair.edu/news/montclair-state-university-acquire-nj-spotlight-commits-continuing-its-watchdog-journalism-through";

const TRANSITION_NOTICE = section(
  "Giving and Passport during the transition",
  "Existing gifts, including one-time and recurring gifts, ended June 30, 2026. If you would like to continue supporting NJ PBS, you will need to set up a new monthly recurring gift or make a one-time donation through the new donation portal. You can also donate by mail. Make checks payable to NJ PBS and mail them to NJ PBS, 1 Normal Ave., Montclair, NJ 07043. A mailed check supports NJ PBS but does not activate PBS Passport; to start or renew Passport streaming, donate through the new donation portal.",
  "PBS manages Passport account status. Use the PBS Passport lookup tool to check an existing account. If access does not appear or a renewal is due, contact NJ PBS for help with the current account or donation path.",
);

const HOME_SEED = seed(
  "home",
  "Home",
  "The new NJ PBS — New Jersey's public television, live and on demand.",
  "Watch NJ PBS live and on demand, explore programs, and follow New Jersey news.",
  [],
);

// These are import fixtures, not a second renderer. They capture the current CMS-owned
// inventory from each public service route and its committed launch source. A missing
// cmsPages/<page-id> document receives a fresh copy; any stored document, including an
// intentionally empty one, wins. The first save replaces the deterministic tmp ids.
const WATCH_SEED = seed(
  "watch",
  "Watch NJ PBS",
  "Find NJ PBS programs, PBS series, full episodes, specials, and Passport video on demand.",
  "Browse NJ PBS programs and PBS series on demand.",
  [
    ctaRow("watch", "hero-actions", 0, [
      { label: "Open PBS video portal", href: "https://watch.njpbs.org/", variant: "primary" },
      { label: "Watch live", href: "/live/", variant: "secondary" },
    ]),
    proseRegion(
      "watch",
      "body-copy",
      1,
      prose(
        "Use Watch for NJ PBS video you can play on demand: full episodes, specials, documentaries, PBS series, and member video benefits.",
        "Playback, episode availability, Passport access, and sign-in are handled through the PBS video portal so the same account works on the web, the PBS app, and supported devices.",
      ),
    ),
    cardGrid("watch", "watch-destinations", 2, [
      {
        label: "Watch",
        title: "Programs on demand",
        body: prose("Open the PBS-hosted video portal for full episodes and specials."),
        imageAssetId: "launch-watch",
        href: "https://watch.njpbs.org/",
      },
      {
        label: "Member",
        title: "PBS Passport",
        body: prose("Learn about the member streaming benefit and account help."),
        imageAssetId: "launch-support",
        href: PASSPORT_LEARN_MORE_URL,
      },
      {
        label: "Live",
        title: "Livestream",
        body: prose("Watch the NJ PBS broadcast stream from the live page."),
        imageAssetId: "launch-under-the-dome",
        href: "/live/",
      },
      {
        label: "App",
        title: "PBS app",
        body: prose("Use the PBS app on phones, tablets, and connected-TV devices."),
        imageAssetId: "launch-about",
        href: "https://www.pbs.org/pbs-app/",
      },
    ]),
    proseRegion(
      "watch",
      "service-note",
      3,
      prose("PBS handles the player, app, account sign-in, and video availability."),
    ),
  ],
);

const LIVE_SEED = seed(
  "live",
  "PBS Livestream",
  "Watch the NJ PBS broadcast stream through the PBS livestream player.",
  "Watch the NJ PBS broadcast stream through PBS live video.",
  [
    ctaRow("live", "hero-actions", 0, [
      { label: "Open PBS livestream", href: PBS_LIVESTREAM_URL, variant: "primary" },
      { label: "See the schedule", href: "/schedule/", variant: "secondary" },
    ]),
    proseRegion(
      "live",
      "body-copy",
      1,
      prose(
        "The livestream uses PBS playback, location rules, and account services so it works consistently with the PBS app and watch.njpbs.org.",
      ),
    ),
    proseRegion(
      "live",
      "caption-guidance",
      2,
      section(
        "Watching with captions",
        "Captions are available on NJ PBS programming. To turn them on, use the CC, or closed-caption, control in the PBS player toolbar.",
        "You can also change how captions look, including their size and color, in your device settings or the PBS app settings.",
      ),
    ),
    ctaRow("live", "caption-actions", 3, [
      { label: "Closed captioning", href: "/closed-captioning/", variant: "primary" },
      { label: "Accessibility", href: "/accessibility/", variant: "secondary" },
    ]),
    proseRegion(
      "live",
      "service-note",
      4,
      prose("The stream itself runs through PBS video systems."),
    ),
    cardGrid("live", "service-destinations", 5, [
      {
        label: "Play",
        title: "Open PBS player",
        body: prose("Open the livestream directly on PBS video."),
        imageAssetId: "launch-watch",
        href: PBS_LIVESTREAM_URL,
      },
      {
        label: "Guide",
        title: "Schedule",
        body: prose("See what is airing now and later this week."),
        imageAssetId: "launch-under-the-dome",
        href: "/schedule/",
      },
      {
        label: "Browse",
        title: "On demand",
        body: prose("Find programs after broadcast from the Watch page."),
        imageAssetId: "launch-support",
        href: "/watch/",
      },
    ]),
  ],
);

const KIDS_SEED = seed(
  "kids",
  "Kids",
  "PBS Kids gives families trusted shows, games, and learning activities from PBS.",
  "PBS Kids videos, games, and learning resources for families.",
  [
    ctaRow("kids", "hero-actions", 0, [
      { label: "Open PBS Kids", href: "https://pbskids.org/", variant: "primary" },
    ]),
    proseRegion(
      "kids",
      "body-copy",
      1,
      prose(
        "PBS Kids offers videos, games, and activities for young viewers, families, caregivers, and teachers.",
        "Use PBS Kids for favorite characters, family-friendly programming, and learning resources built around curiosity and play.",
      ),
    ),
    proseRegion(
      "kids",
      "broadcast-guidance",
      2,
      section(
        "Watch on NJ PBS",
        "Want a child watching on the broadcast channel? Start the NJ PBS livestream, or see the full NJ PBS TV schedule to find kids shows.",
      ),
    ),
    ctaRow("kids", "broadcast-actions", 3, [
      { label: "Watch NJ PBS live", href: "/live/", variant: "primary" },
      { label: "See the NJ PBS TV schedule", href: "/schedule/", variant: "secondary" },
    ]),
    cardGrid("kids", "service-destinations", 4, [
      {
        label: "Watch",
        title: "PBS Kids video",
        body: prose("Open PBS Kids videos and favorite series for young viewers."),
        href: "https://pbskids.org/video/",
      },
      {
        label: "Play",
        title: "PBS Kids games",
        body: prose("Find games and activities built around PBS Kids characters."),
        href: "https://pbskids.org/games/",
      },
      {
        label: "Learn",
        title: "Family resources",
        body: prose("Use PBS resources for parents, caregivers, and classrooms."),
        href: "https://www.pbs.org/parents/",
      },
    ]),
  ],
);

function transitionActions(pageId: "support" | "give" | "passport", order: number): PageBlock {
  return ctaRow(pageId, "transition-actions", order, [
    { label: "See the full transition FAQ", href: "/faq/", variant: "secondary" },
    { label: "Look up Passport access", href: PASSPORT_LOOKUP_URL, variant: "secondary" },
  ]);
}

const SUPPORT_SEED = seed(
  "support",
  "Support NJ PBS",
  "Support NJ PBS and keep public media available for New Jersey.",
  "Donate, become a member, and support public television in New Jersey.",
  [
    ctaRow("support", "hero-actions", 0, [
      { label: "Donate", href: DONATE_URL, variant: "primary" },
      { label: "Contact NJ PBS", href: "/contact/", variant: "secondary" },
    ]),
    proseRegion("support", "transition-notice", 1, TRANSITION_NOTICE),
    transitionActions("support", 2),
    proseRegion(
      "support",
      "body-copy",
      3,
      prose(
        "Gifts to NJ PBS support public television programming, statewide storytelling, education, arts, culture, and public affairs.",
        "Online donation processing is handled through PBS, and this site does not collect payment information.",
        "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
      ),
    ),
    cardGrid("support", "service-destinations", 4, [
      {
        label: "Give",
        title: "Donate",
        body: prose("Open the secure PBS payment form for NJ PBS."),
        imageAssetId: "launch-give",
        href: DONATE_URL,
      },
      {
        label: "Member",
        title: "Passport access",
        body: prose("Learn about the Passport member benefit before you watch."),
        imageAssetId: "launch-passport",
        href: "/passport/",
      },
      {
        label: "Help",
        title: "Contact NJ PBS",
        body: prose("Reach the station team with membership or site questions."),
        imageAssetId: "launch-contact",
        href: "/contact/",
      },
    ]),
  ],
);

const GIVE_SEED = seed(
  "give",
  "Give to NJ PBS",
  "Make a gift to NJ PBS and support public television, statewide reporting, education, arts, and culture.",
  "Support public television in New Jersey through NJ PBS membership and donations.",
  [
    ctaRow("give", "hero-actions", 0, [
      { label: "Donate through PBS", href: DONATE_URL, variant: "primary" },
      { label: "Learn about Passport", href: "/passport/", variant: "secondary" },
    ]),
    proseRegion("give", "transition-notice", 1, TRANSITION_NOTICE),
    transitionActions("give", 2),
    proseRegion(
      "give",
      "body-copy",
      3,
      prose(
        "Your gift supports trusted PBS programming, statewide reporting, educational media, arts and culture, and public-service broadcasting for New Jersey.",
        "This page is the local NJ PBS giving destination. When you donate online, the payment form opens through PBS so transaction handling and member records stay secure.",
        "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
      ),
    ),
    proseRegion(
      "give",
      "service-note",
      4,
      prose("For online gifts, payment information is collected by PBS, not by this website."),
    ),
    cardGrid("give", "service-destinations", 5, [
      {
        label: "Donate",
        title: "PBS donation form",
        body: prose("Open the secure PBS payment form for NJ PBS."),
        imageAssetId: "launch-give",
        href: DONATE_URL,
      },
      {
        label: "Member",
        title: "Passport",
        body: prose("Learn how the member streaming benefit works."),
        imageAssetId: "launch-passport",
        href: "/passport/",
      },
      {
        label: "Help",
        title: "Contact NJ PBS",
        body: prose("Reach the station team with membership or donation questions."),
        imageAssetId: "launch-contact",
        href: "/contact/",
      },
    ]),
  ],
);

const PASSPORT_SEED = seed(
  "passport",
  "NJ PBS Passport",
  "Learn how PBS Passport works for NJ PBS supporters before signing in, donating, or looking up an account.",
  "Learn how the PBS Passport member benefit works for NJ PBS supporters.",
  [
    ctaRow("passport", "hero-actions", 0, [
      { label: "Donate through PBS", href: DONATE_URL, variant: "primary" },
      { label: "Find Passport access", href: PASSPORT_LOOKUP_URL, variant: "secondary" },
    ]),
    proseRegion("passport", "transition-notice", 1, TRANSITION_NOTICE),
    transitionActions("passport", 2),
    proseRegion(
      "passport",
      "body-copy",
      3,
      prose(
        "PBS Passport is a member benefit that gives eligible donors extended access to a library of PBS programs, films, and specials.",
        "Support NJ PBS to start or renew access, or use the PBS lookup tool if you already donate and need help finding your Passport account.",
      ),
    ),
    proseRegion(
      "passport",
      "service-note",
      4,
      prose("Passport account lookup, sign-in, and member verification are handled by PBS."),
    ),
    cardGrid("passport", "service-destinations", 5, [
      {
        label: "Give",
        title: "Donate through PBS",
        body: prose("Support NJ PBS and start or renew the Passport member benefit."),
        imageAssetId: "launch-give",
        href: DONATE_URL,
      },
      {
        label: "Lookup",
        title: "Find Passport access",
        body: prose("Use PBS account lookup if you already donate and need help."),
        imageAssetId: "launch-passport",
        href: PASSPORT_LOOKUP_URL,
      },
      {
        label: "Learn",
        title: "PBS Passport help",
        body: prose("Read PBS guidance on how the Passport member benefit works."),
        imageAssetId: "launch-support",
        href: PASSPORT_LEARN_MORE_URL,
      },
    ]),
  ],
);

const ABOUT_SEED = seed(
  "about",
  "About NJ PBS",
  "NJ PBS connects viewers across New Jersey with public television: trusted PBS programs, local journalism, arts and culture, learning for children, and coverage of the issues facing the state. As of July 1, 2026, Montclair State University is the new operator of NJ PBS.",
  "New Jersey's public television service: the member stations, how to watch and support, and Montclair State University's new role.",
  [
    ctaRow("about", "hero-actions", 0, [
      { label: "Support NJ PBS", href: "/give/", variant: "primary" },
      {
        label: "NJ Spotlight News",
        href: "https://www.njspotlightnews.org/",
        variant: "secondary",
      },
    ]),
    proseRegion(
      "about",
      "body-copy",
      1,
      prose(
        "NJ PBS is New Jersey's public television service. It carries PBS programs, local stories, arts and culture, education, and statewide public affairs to viewers across the state and the surrounding region.",
        "Use this site to watch live and on demand, check the broadcast schedule, follow statewide reporting from NJ Spotlight News, explore PBS Kids, and support public media in New Jersey.",
      ),
    ),
    proseRegion(
      "about",
      "what-njpbs-is",
      2,
      section(
        "What NJ PBS is",
        "NJ PBS is New Jersey's PBS member service, part of the national Public Broadcasting Service. It brings national PBS programming together with New Jersey storytelling: documentaries, arts and music, history, children's learning, and public-affairs coverage made for and about the state.",
        "The service is nonprofit and viewer-supported. Programming is free to watch over the air and through PBS-hosted streaming, and member donations help keep it that way.",
      ),
    ),
    proseRegion(
      "about",
      "montclair-role",
      3,
      section(
        "Montclair's role",
        "NJ PBS is housed at the College of Communication and Media at Montclair State University. The transition became official on July 1, 2026, after the State of New Jersey selected Montclair to program and manage New Jersey's four FCC-licensed public television stations.",
        "This summer, Montclair is hiring staff, setting up systems, and preparing programming that informs, connects, and educates residents across the Garden State.",
      ),
    ),
    proseRegion(
      "about",
      "spotlight-announcement",
      4,
      linkedSection(
        "NJ Spotlight News",
        "Montclair State University will acquire NJ Spotlight and has committed to continuing its watchdog journalism through NJ PBS.",
        "Read the announcement",
        NJ_SPOTLIGHT_ANNOUNCEMENT_URL,
      ),
    ),
    proseRegion(
      "about",
      "member-stations",
      5,
      section(
        "The member stations",
        "NJ PBS reaches the state over four broadcast stations licensed to the New Jersey Public Broadcasting Authority: WNJS in Camden, WNJN in Montclair, WNJT in Trenton, and WNJB in New Brunswick. Together they cover New Jersey and reach into neighboring markets.",
        "Each station keeps its own FCC online public inspection file. The four files are linked in the footer of every page on this site.",
      ),
    ),
    proseRegion(
      "about",
      "what-continues",
      6,
      section(
        "What continues",
        "WNET operated NJ PBS from July 1, 2011, through June 30, 2026. Programming continues during the transition to Montclair, and viewers can keep watching the broadcast channel, PBS programs, and NJ PBS video through PBS-hosted services.",
        "Eligible members retain their PBS Passport benefit while Montclair sets up the next phase of NJ PBS operations. If you have a question about your membership, contact the station team.",
      ),
    ),
    proseRegion(
      "about",
      "contact-guidance",
      7,
      section(
        "How to reach us",
        "For questions about programs, membership, donations, or NJ PBS service, contact the station team. If you have trouble using any part of this site, our accessibility page explains how to report a barrier and what to expect.",
        "For press and media inquiries, email njpbs@montclair.edu.",
        "Mailing address: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
      ),
    ),
    ctaRow("about", "contact-actions", 8, [
      { label: "Contact NJ PBS", href: "/contact/", variant: "primary" },
      { label: "Transition FAQ", href: "/faq/", variant: "secondary" },
      { label: "Accessibility", href: "/accessibility/", variant: "secondary" },
    ]),
    proseRegion(
      "about",
      "service-note",
      9,
      prose(
        "Video playback, account sign-in, Passport access, and online payment processing are handled by PBS-hosted services.",
      ),
    ),
  ],
);

const SCHEDULE_SEED = seed(
  "schedule",
  "Schedule",
  "See what is airing on NJ PBS today and this week.",
  "Browse the NJ PBS broadcast schedule and find programs to watch live or on demand.",
  [
    ctaRow("schedule", "hero-actions", 0, [
      { label: "Watch live", href: "/live/", variant: "primary" },
      { label: "Watch on demand", href: "https://watch.njpbs.org/", variant: "secondary" },
    ]),
    proseRegion(
      "schedule",
      "body-copy",
      1,
      prose(
        "Review the NJ PBS broadcast schedule. Listings come from PBS and update through the day, so check back before tuning in, setting a recording, or looking for a program on demand.",
        "Programs air across NJ PBS and its companion channels. After something airs, look for it on demand through the PBS video portal.",
      ),
    ),
  ],
);

const STAFF_SEED = seed(
  "staff",
  "Staff",
  "Meet the people who make NJ PBS.",
  "Meet the people who make NJ PBS.",
  [],
);

const contactFallback = contactPageFallback();
const CONTACT_SEED = seed(
  "contact",
  contactFallback.title,
  contactFallback.description,
  contactFallback.seoDescription,
  contactFallback.blocks,
  { noindex: contactFallback.noindex },
);

const FAQ_SEED = seed(
  "faq",
  "NJ PBS transition FAQ",
  "Answers about the NJ PBS operator transition, PBS Passport, donations, renewals, and how to get help.",
  "Answers about the NJ PBS transition, Passport, donations, renewals, and support.",
  [
    proseRegion("faq", "operations-heading", 0, section("NJ PBS operations")),
    faqItem(
      "faq",
      "operations-changing",
      1,
      "What is changing at NJ PBS?",
      prose(
        "Beginning July 1, 2026, Montclair State University is the new operator of NJ PBS. During the next three months, Montclair will hire staff, set up systems, and prepare programming for the next phase of NJ PBS.",
      ),
    ),
    faqItem(
      "faq",
      "operations-operator",
      2,
      "Who is the new operator of NJ PBS?",
      prose("Montclair State University is the new operator of NJ PBS."),
    ),
    faqItem(
      "faq",
      "operations-wnet",
      3,
      "What was WNET's role?",
      prose("WNET operated NJ PBS from July 1, 2011, until June 30, 2026."),
    ),
    faqItem(
      "faq",
      "operations-reason",
      4,
      "Why is this transition happening?",
      prose(
        "WNET's contract to operate NJ PBS ended June 30, 2026. Montclair State University became the new operator on July 1, 2026. Montclair is using the summer to hire staff, set up systems, and prepare programming. We appreciate your patience and support during this transition.",
      ),
    ),
    proseRegion("faq", "viewing-heading", 5, section("Viewing and Passport")),
    faqItem(
      "faq",
      "viewing-immediate",
      6,
      "Is anything changing immediately for viewers?",
      prose(
        "Nothing will change immediately during the transition period. Viewers can continue watching NJ PBS, and eligible members will retain PBS Passport while Montclair sets up the next phase of NJ PBS.",
      ),
    ),
    faqItem(
      "faq",
      "viewing-passport",
      7,
      "Does my existing access to PBS Passport continue without interruption?",
      proseWithLink(
        [
          "PBS manages Passport account status. Use the PBS Passport lookup tool to check an existing account. If access does not appear or a renewal is due, contact NJ PBS for help with the current account or donation path.",
        ],
        "PBS Passport lookup tool",
        PASSPORT_LOOKUP_URL,
      ),
    ),
    faqItem(
      "faq",
      "viewing-action",
      8,
      "Do I need to do anything right now?",
      prose(
        "You do not need an account for immediate broadcast viewing. For Passport, check your account through PBS and contact NJ PBS if access or renewal information is not shown correctly.",
        "Existing gifts, including one-time and recurring gifts, ended June 30, 2026. If you would like to continue supporting NJ PBS, you will need to set up a new monthly recurring gift or make a one-time donation through the new donation portal. You can also donate by mail. Make checks payable to NJ PBS and mail them to NJ PBS, 1 Normal Ave., Montclair, NJ 07043. A mailed check supports NJ PBS but does not activate PBS Passport; to start or renew Passport streaming, donate through the new donation portal.",
      ),
    ),
    proseRegion("faq", "donations-heading", 9, section("Donations and renewals")),
    faqItem(
      "faq",
      "donations-recurring",
      10,
      "What happens to my recurring donation?",
      prose(
        "Existing recurring gifts ended June 30, 2026. Members who want to continue a monthly gift to NJ PBS will need to set up a new monthly recurring gift through the new donation portal.",
      ),
    ),
    faqItem(
      "faq",
      "donations-renew",
      11,
      "Where can I renew or make a donation?",
      proseWithLink(
        ["You can renew or make a donation through the new NJ PBS donation portal."],
        "PBS donation portal",
        DONATE_URL,
      ),
    ),
    faqItem(
      "faq",
      "donations-check",
      12,
      "Can I donate by mailing a check?",
      prose(
        "Yes. Make checks payable to NJ PBS and mail them to NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
      ),
    ),
    faqItem(
      "faq",
      "donations-payment",
      13,
      "Will donors need to re-enter payment information?",
      prose(
        "Yes, for online gifts. Donors giving online will need to enter payment information in the new donation form. Mailing a check skips that step.",
      ),
    ),
    faqItem(
      "faq",
      "donations-history",
      14,
      "What happens to my prior giving history and tax receipts?",
      prose("WNET maintains giving history and tax receipts for all donations made before July 1, 2026."),
    ),
    proseRegion("faq", "data-heading", 15, section("Data, preferences, and help")),
    faqItem(
      "faq",
      "data-handling",
      16,
      "How is my personal or payment information handled?",
      prose(
        "For online gifts, payment information is entered through the PBS donation portal and processed by its payment processor. A mailed check goes to NJ PBS in Montclair and does not pass through that portal. Member and Passport records are handled through PBS membership systems. This website does not collect payment-card information.",
      ),
    ),
    faqItem(
      "faq",
      "data-help",
      17,
      "Where should I go for help?",
      prose(
        "Email njpbs@montclair.edu or call 800-882-6622. Mailing address: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
      ),
    ),
    faqItem(
      "faq",
      "data-updates",
      18,
      "Where should members go for updates?",
      proseWithLink(["Members should go to njpbs.org for updates."], "NJ PBS", "https://njpbs.org/"),
    ),
  ],
  { noindex: true },
);

const ACCESSIBILITY_SEED = seed(
  "accessibility",
  "Accessibility statement",
  "How NJ PBS works to meet WCAG 2.1 AA, the accessibility features built into this site, and how to report a barrier.",
  "Read the NJ PBS accessibility statement and learn how to report a barrier.",
  [
    proseRegion(
      "accessibility",
      "body-copy",
      0,
      prose(
        "NJ PBS is committed to making this website usable by everyone, including people who navigate by keyboard, use a screen reader or other assistive technology, need captions, or rely on high-contrast or larger text.",
      ),
    ),
    proseRegion(
      "accessibility",
      "conformance",
      1,
      section(
        "Conformance statement",
        "Our goal is to conform to the Web Content Accessibility Guidelines (WCAG) 2.1, level AA, and to apply WCAG 2.2 AA guidance where it is practical.",
        "This is also a legal commitment. As a state agency and a state university, the New Jersey Public Broadcasting Authority and Montclair State University are covered by Title II of the Americans with Disabilities Act, which sets WCAG 2.1 level AA as the standard for public-entity websites by April 26, 2027. We are building to that standard now rather than retrofitting it later.",
        "Accessibility is checked as the site is built. Color combinations are tested against the WCAG AA contrast minimum automatically, so a failing pairing stops a release.",
        "The site provides a skip link, visible focus outlines, reduced-motion support, high-contrast and forced-colors support, screen-reader cues for new tabs, captions, resilient text resizing, and a reduced-data mode.",
      ),
    ),
    proseRegion(
      "accessibility",
      "known-limitations",
      2,
      section(
        "Known limitations",
        "Some features on this site open services that PBS and other partners host and control, including the video player on watch.njpbs.org, the PBS app, account sign-in, and the donation form. We do not control the code on those platforms, so their accessibility is set by the partner that runs them. Where a barrier sits on an outside service, we will raise it with that partner and point you to their accessibility contact.",
        "The schedule page uses a native schedule grid built in this site from PBS-supplied listings. Its day switcher, program buttons, shortcuts, and program details dialog are keyboard-operable, and focus returns to the program button when the dialog closes. If the baked listings do not include the current day, the page shows an empty current-day state with live and on-demand links instead of presenting old listings as current. The listings data still comes from PBS, so a PBS feed delay can leave the page temporarily without current programs.",
        "We treat accessibility reports about this site as priority fixes. If you find a part of the site that does not meet the standard above, tell us.",
      ),
    ),
    proseRegion(
      "accessibility",
      "feedback-channel",
      3,
      section(
        "Feedback channel",
        "If you have trouble using any part of this site, contact NJ PBS at njpbs@montclair.edu or 800-882-6622.",
        "Mailing address: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
        "Please include the page address, the device and browser you are using, and a short description of the barrier. We aim to acknowledge accessibility reports within five business days and to give a target date for a fix when we respond. If the issue involves an external PBS service, video player, donation form, or another partner platform, we will route the report to the right contact.",
      ),
    ),
    ctaRow("accessibility", "feedback-actions", 4, [
      { label: "Email NJ PBS", href: "mailto:njpbs@montclair.edu", variant: "primary" },
      { label: "Call 800-882-6622", href: "tel:+18008826622", variant: "secondary" },
    ]),
    proseRegion(
      "accessibility",
      "disability-assistance",
      5,
      section(
        "Disability-assistance contact",
        "If you need help using this site, or want the information on a page in another format, contact us at the email address or telephone number above and we will work with you directly.",
        "Montclair State University also maintains a digital accessibility initiative with accessibility policies, procedures, training, and web guidance.",
      ),
    ),
    ctaRow("accessibility", "university-actions", 6, [
      {
        label: "Montclair digital accessibility initiative",
        href: "https://www.montclair.edu/digital-accessibility-initiative/",
        variant: "secondary",
      },
    ]),
  ],
);

const CLOSED_CAPTIONING_SEED = seed(
  "closed-captioning",
  "Closed captioning",
  "Closed-captioning quality certification, immediate contact, and written complaint information.",
  "Find NJ PBS closed-captioning help, quality certification, and complaint contacts.",
  [
    proseRegion(
      "closed-captioning",
      "body-copy",
      0,
      prose(
        "Captions are available on NJ PBS programming. To turn them on while watching, use the CC, or closed-caption, control in the PBS player toolbar, and adjust how captions look, including their size and color, in your device or PBS app settings. For the accessibility features built into this site, see the accessibility statement. The sections below cover NJ PBS's closed-captioning quality certification and how to reach us about a captioning problem.",
      ),
    ),
    proseRegion(
      "closed-captioning",
      "quality-certification",
      1,
      section(
        "Closed-captioning quality certification",
        "Programming produced for NJ PBS and broadcast on NJ PBS channels is expected to comply with the closed-captioning requirements established by the Federal Communications Commission in 47 C.F.R. § 79.1, including the FCC rules about captioning quality. Programming provided for NJ PBS may satisfy those requirements by meeting the caption quality standards in 47 C.F.R. § 79.1(j)(2), following the Video Programmer Best Practices in 47 C.F.R. § 79.1(k)(1), or qualifying for one of the captioning exemptions in 47 C.F.R. § 79.1(d).",
      ),
    ),
    proseRegion(
      "closed-captioning",
      "immediate-response",
      2,
      section(
        "Immediate response for captioning concerns",
        "For captioning problems during a program, or while watching NJ PBS on television or through PBS-hosted streaming, call 800-882-6622 or email njpbs@montclair.edu. Fax is not available.",
        "Calls should be used for live or in-progress captioning problems. This contact path is for immediate response to captioning concerns. If station staff are not immediately available, calls or inquiries using this contact information will be returned or otherwise addressed as soon as possible, and no later than 24 hours. Captioning problems outside NJ PBS's direct control will be referred to engineering, PBS support, or the responsible program source for resolution.",
      ),
    ),
    ctaRow("closed-captioning", "immediate-actions", 3, [
      { label: "Call 800-882-6622", href: "tel:+18008826622", variant: "primary" },
      { label: "Email NJ PBS", href: "mailto:njpbs@montclair.edu", variant: "secondary" },
    ]),
    proseRegion(
      "closed-captioning",
      "written-complaints",
      4,
      section(
        "Written complaints",
        "Written closed-captioning complaints that do not require immediate response may be sent to Stefanie Murray, director, Center for Cooperative Media, NJ PBS closed-captioning contact, Montclair State University, Center for Cooperative Media, 1 Normal Ave., Montclair, NJ 07043. Email njpbs@montclair.edu or call 800-882-6622. Fax is not available.",
        "NJ PBS will respond to written closed-captioning complaints in writing within 30 days. Viewers may also file a closed-captioning complaint with the FCC through the FCC Accessibility Complaint Center.",
      ),
    ),
    ctaRow("closed-captioning", "complaint-actions", 5, [
      {
        label: "FCC Accessibility Complaint Center",
        href: "https://www.fcc.gov/accessibilitycomplaints",
        variant: "secondary",
      },
    ]),
    proseRegion(
      "closed-captioning",
      "complaint-details",
      6,
      section(
        "What to include",
        "Include your name, mailing address, telephone number, email address, and preferred response format; the program name, channel or platform, date, time, and time zone; the device, app, browser, provider, or other viewing method; a description of the problem; and the requested correction, if any.",
        "Captioning complaints should be filed within 60 days of the captioning problem.",
      ),
    ),
  ],
);

const PRIVACY_SEED = seed(
  "privacy",
  "Privacy policy",
  "How NJ PBS handles information on this site, and what you can ask for.",
  "Read how NJ PBS handles website information and how to make a privacy request.",
  [
    proseRegion(
      "privacy",
      "body-copy",
      0,
      prose(
        "This notice explains how NJ PBS handles information on this website. Montclair State University also publishes a website privacy notice for university-owned websites, services, applications, and technology products.",
      ),
    ),
    ctaRow("privacy", "university-notice", 1, [
      {
        label: "Montclair website privacy notice",
        href: "https://www.montclair.edu/privacy-notice/",
        variant: "secondary",
      },
    ]),
    proseRegion(
      "privacy",
      "data-collected",
      2,
      section(
        "Data collected",
        "NJ PBS may collect limited technical information needed to operate, secure, and improve the website, including browser type, device type, pages visited, referring page, approximate connection information, and the date and time of the visit. If you email NJ PBS or submit a form, the information you provide is used to respond to your request.",
      ),
    ),
    proseRegion(
      "privacy",
      "analytics-cookies",
      3,
      section(
        "Analytics and cookies",
        "The website may use cookies, server logs, and aggregate analytics to understand site traffic and diagnose technical problems.",
      ),
    ),
    proseRegion(
      "privacy",
      "third-party-services",
      4,
      section(
        "Third-party services",
        "This website links to services that are hosted or controlled by other organizations. Watching on watch.njpbs.org, the PBS app, PBS.org, PBS Passport pages, PBS donation forms, social media platforms, and the NJ Spotlight News website may be governed by their own privacy notices and account terms.",
      ),
    ),
    proseRegion(
      "privacy",
      "donation-passport-data",
      5,
      section(
        "Donation and Passport data",
        "NJ PBS does not collect payment-card information on this site. Online donations are processed through PBS donation tools; a donation mailed as a check goes directly to NJ PBS and does not pass through those tools. PBS Passport viewing and account sign-in are handled by PBS-hosted services.",
      ),
    ),
    proseRegion(
      "privacy",
      "privacy-choices",
      6,
      section(
        "Your privacy choices",
        "You can ask NJ PBS to tell you what personal information it holds about you and give you a copy; correct information that is wrong; delete personal information it holds about you; or opt out of any sale of your personal information, or its use for targeted advertising.",
        "Email njpbs@montclair.edu and say which of these you are asking for. You can also manage cookies through your browser settings. Some features may not work as expected if cookies are blocked.",
      ),
    ),
    proseRegion(
      "privacy",
      "contact-details",
      7,
      section(
        "Contact",
        "To ask a privacy question or request help with this website, email njpbs@montclair.edu or call 800-882-6622.",
        "Mailing address: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
      ),
    ),
    ctaRow("privacy", "contact-actions", 8, [
      { label: "Email NJ PBS", href: "mailto:njpbs@montclair.edu", variant: "primary" },
      { label: "Call 800-882-6622", href: "tel:+18008826622", variant: "secondary" },
    ]),
  ],
);

const PUBLIC_FILE_SEED = seed(
  "public-file",
  "FCC public inspection files",
  "Links to the four FCC online public files and a station-representative contact.",
  "Open the FCC public inspection files for the four NJ PBS stations.",
  [
    proseRegion(
      "public-file",
      "body-copy",
      0,
      prose(
        "NJ PBS broadcasts over four transmitters licensed to the New Jersey Public Broadcasting Authority (NJPBA). Each licensed station keeps its own FCC online public inspection file, and FCC rules require a link to that file, plus a station-representative contact, on the station website.",
      ),
    ),
    proseRegion(
      "public-file",
      "file-guidance",
      1,
      section(
        "What the public file is",
        "The online public inspection file holds the records the FCC requires a television station to make available to the public, including its license, ownership reports, and equal employment opportunity filings. Each NJ PBS station's file is hosted by the FCC at publicfiles.fcc.gov. The four files are also linked in the footer of every page.",
      ),
    ),
    ctaRow("public-file", "station-file-actions", 2, [
      {
        label: "WNJS (Camden)",
        href: "https://publicfiles.fcc.gov/tv-profile/wnjs",
        variant: "secondary",
      },
      {
        label: "WNJN (Montclair)",
        href: "https://publicfiles.fcc.gov/tv-profile/wnjn",
        variant: "secondary",
      },
      {
        label: "WNJT (Trenton)",
        href: "https://publicfiles.fcc.gov/tv-profile/wnjt",
        variant: "secondary",
      },
      {
        label: "WNJB (New Brunswick)",
        href: "https://publicfiles.fcc.gov/tv-profile/wnjb",
        variant: "secondary",
      },
    ]),
    proseRegion(
      "public-file",
      "representative-contact",
      3,
      sectionWithLinks(
        "Station-representative contact",
        [
          "The stations are licensed to the New Jersey Public Broadcasting Authority, which holds the public files. For help with the contents of a station's public inspection file, contact Nichol Gee, deputy executive director, NJPBA:",
          "For general questions about NJ PBS, email njpbs@montclair.edu or call 800-882-6622.",
          "Mailing address: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
        ],
        [
          { label: "Email Nichol Gee", href: "mailto:nichol.gee@treas.nj.gov" },
          { label: "Call 609-984-9449", href: "tel:+16099849449" },
        ],
      ),
    ),
    proseRegion(
      "public-file",
      "disability-assistance",
      4,
      section(
        "Disability-assistance contact",
        "If you need help getting any material from a public file in an accessible format, contact us at the email address or telephone number above. Our accessibility statement explains how to report a barrier and what to expect.",
      ),
    ),
    ctaRow("public-file", "assistance-actions", 5, [
      { label: "Accessibility statement", href: "/accessibility/", variant: "secondary" },
      { label: "Email NJ PBS", href: "mailto:njpbs@montclair.edu", variant: "secondary" },
    ]),
  ],
);

const EEO_SEED = seed(
  "eeo",
  "FCC EEO report",
  "The current FCC broadcast equal-employment-opportunity public-file report.",
  "Open the current FCC annual EEO report for NJ PBS stations.",
  [
    proseRegion(
      "eeo",
      "current-report",
      0,
      section("Current EEO public-file report", "The current report is available from NJPBA."),
    ),
    ctaRow("eeo", "report-action", 1, [
      {
        label: "FCC annual EEO report 2026",
        href: "https://www.nj.gov/treasury/njpba/assets/files/pdf/2026/FCCANNUALEEOREPORT2026.pdf",
        variant: "primary",
      },
    ]),
    proseRegion(
      "eeo",
      "broadcast-program",
      2,
      section(
        "The broadcast EEO program",
        "The FCC broadcast EEO rule (47 CFR §73.2080) requires a station with five or more full-time employees to prepare an annual EEO public-file report, post it in the online public inspection file, and link it from the station website. This page is the home for that link, and it points to the current report, which NJPBA hosts. It is the FCC broadcast EEO report, distinct from any CPB EEO certification a grantee files separately.",
      ),
    ),
    proseRegion(
      "eeo",
      "report-coverage",
      3,
      section(
        "What the report covers",
        "The annual report describes the station's full-time job openings during the period, how each opening was publicized, and the recruitment and outreach the station carried out to reach a wide range of candidates.",
      ),
    ),
    proseRegion(
      "eeo",
      "contact-details",
      4,
      section(
        "EEO contact",
        "For questions about the station's EEO public file, contact NJ PBS at njpbs@montclair.edu or 800-882-6622.",
        "Mailing address: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
      ),
    ),
    ctaRow("eeo", "contact-actions", 5, [
      { label: "Email NJ PBS", href: "mailto:njpbs@montclair.edu", variant: "secondary" },
      { label: "Call 800-882-6622", href: "tel:+18008826622", variant: "secondary" },
    ]),
  ],
);

const PUBLIC_MEETINGS_SEED = seed(
  "public-meetings",
  "Meeting notices",
  "Meeting notices from NJPBA and NJ PBS, newest first.",
  "Browse public meeting notices from NJPBA and NJ PBS.",
  [
    proseRegion(
      "public-meetings",
      "body-copy",
      0,
      prose(
        "Download public meeting notices from NJPBA and NJ PBS. The most recently added notices appear first.",
      ),
    ),
    { id: "seed-public-meetings-documents", type: "document_list", section: "meeting-notices",
      order: 1, visible: true, data: { documents: [] } },
    proseRegion(
      "public-meetings",
      "njpba-notices",
      2,
      section(
        "NJPBA public meeting notices",
        "The New Jersey Public Broadcasting Authority posts its meeting schedules, agendas, and minutes on its official page.",
      ),
    ),
    proseRegion(
      "public-meetings",
      "montclair-notices",
      3,
      section(
        "Montclair State University public meeting notices",
        "The Montclair State University board of trustees posts its agenda and schedule on its official page.",
      ),
    ),
    ctaRow("public-meetings", "notice-actions", 4, [
      {
        label: "NJPBA public meetings",
        href: "https://www.nj.gov/treasury/njpba/minutes.shtml",
        variant: "primary",
      },
      {
        label: "Montclair board of trustees agenda and schedule",
        href: "https://www.montclair.edu/board-of-trustees/agenda-and-schedule/",
        variant: "secondary",
      },
    ]),
    proseRegion(
      "public-meetings",
      "open-meetings-act",
      5,
      section(
        "Open Public Meetings Act",
        "New Jersey's Open Public Meetings Act requires public bodies to give advance public notice of their meetings. For the latest details, use the official pages linked above.",
      ),
    ),
  ],
);

const PAGE_COMPOSITION_SEEDS: Readonly<Partial<Record<PublicPageId, PageCompositionSeed>>> =
  Object.freeze({
    home: HOME_SEED,
    watch: WATCH_SEED,
    live: LIVE_SEED,
    schedule: SCHEDULE_SEED,
    kids: KIDS_SEED,
    support: SUPPORT_SEED,
    give: GIVE_SEED,
    passport: PASSPORT_SEED,
    about: ABOUT_SEED,
    staff: STAFF_SEED,
    contact: CONTACT_SEED,
    faq: FAQ_SEED,
    accessibility: ACCESSIBILITY_SEED,
    "closed-captioning": CLOSED_CAPTIONING_SEED,
    privacy: PRIVACY_SEED,
    "public-file": PUBLIC_FILE_SEED,
    eeo: EEO_SEED,
    "public-meetings": PUBLIC_MEETINGS_SEED,
  });

const PAGE_COMPOSITION_FIXED_REGIONS: Readonly<
  Partial<Record<PublicPageId, readonly PageCompositionFixedRegion[]>>
> = Object.freeze({
  home: Object.freeze([
    Object.freeze({
      label: "Public Home frame",
      detail: "The hero, newsletter signup, program and news shelves, and Passport band stay fixed. Up to eight manual content shelves are editable.",
    }),
  ]),
  staff: Object.freeze([
    Object.freeze({
      label: "Published staff roster",
      detail: "The roster is generated from published public author profiles. It is read-only on this Page and cannot be replaced with authored blocks.",
    }),
  ]),
  live: Object.freeze([
    Object.freeze({
      label: "PBS livestream player",
      detail: "PBS owns playback, location rules, and player behavior.",
    }),
    Object.freeze({
      label: "Live schedule",
      detail: "The current and upcoming programs come from the PBS schedule feed.",
    }),
  ]),
  schedule: Object.freeze([
    Object.freeze({
      label: "PBS schedule grid",
      detail: "Day tabs, channel filters, program details, and listings stay in the site frame and read the PBS schedule feed.",
    }),
  ]),
});

const PAGE_COMPOSITION_REGION_LABELS: Readonly<
  Partial<Record<PublicPageId, Readonly<Record<string, string>>>>
> = Object.freeze({
  home: {
    "hero-heading": "Hero heading",
    "hero-copy": "Hero introduction",
    "hero-actions": "Hero actions",
    "start-heading": "Start here heading",
    "start-actions": "Start here action",
    "start-destinations": "Start here destinations",
    "featured-shelf": "Featured programs shelf",
    "passport-copy": "Passport band",
    "passport-actions": "Passport action",
    "more-shelf": "More to watch shelf",
    "spotlight-shelf": "NJ Spotlight News shelf",
    "home-featured": "Featured programs",
    "home-passport-copy": "Passport",
    "home-passport-action": "Passport action",
    "home-more": "More to watch",
    "home-spotlight": "NJ Spotlight News",
  },
  watch: {
    "hero-actions": "Hero actions",
    "body-copy": "Watch introduction",
    "watch-destinations": "Watch destinations",
    "service-note": "PBS service note",
  },
  live: {
    "hero-actions": "Hero actions",
    "body-copy": "Livestream introduction",
    "caption-guidance": "Watching with captions",
    "caption-actions": "Caption help actions",
    "service-note": "PBS stream note",
    "service-destinations": "Livestream destinations",
  },
  schedule: {
    "hero-actions": "Schedule actions",
    "body-copy": "Schedule introduction",
  },
  kids: {
    "hero-actions": "Hero actions",
    "body-copy": "Kids introduction",
    "broadcast-guidance": "Watch on NJ PBS",
    "broadcast-actions": "Broadcast actions",
    "service-destinations": "Kids destinations",
  },
  support: {
    "hero-actions": "Hero actions",
    "transition-notice": "Giving and Passport transition notice",
    "transition-actions": "Transition FAQ action",
    "body-copy": "Support introduction",
    "service-destinations": "Support destinations",
  },
  give: {
    "hero-actions": "Hero actions",
    "transition-notice": "Giving and Passport transition notice",
    "transition-actions": "Transition FAQ action",
    "body-copy": "Giving introduction",
    "service-note": "Payment service note",
    "service-destinations": "Giving destinations",
  },
  passport: {
    "hero-actions": "Hero actions",
    "transition-notice": "Giving and Passport transition notice",
    "transition-actions": "Transition FAQ action",
    "body-copy": "Passport introduction",
    "service-note": "Passport service note",
    "service-destinations": "Passport destinations",
  },
  about: {
    "hero-actions": "Hero actions",
    "body-copy": "About introduction",
    "what-njpbs-is": "What NJ PBS is",
    "montclair-role": "Montclair's role",
    "spotlight-announcement": "NJ Spotlight News",
    "member-stations": "The member stations",
    "what-continues": "What continues",
    "contact-guidance": "How to reach us",
    "contact-actions": "Contact actions",
    "service-destinations": "Unused destination cards",
    "service-note": "PBS-hosted services note",
  },
  contact: {
    "body-copy": "Contact introduction",
    "contact-details": "How to contact NJ PBS",
    "contact-actions": "Contact actions",
    "when-to-contact": "When to contact NJ PBS",
    "other-help": "Other help pages",
    "help-actions": "Help page actions",
  },
  faq: {
    "operations-heading": "NJ PBS operations",
    "operations-changing": "What is changing",
    "operations-operator": "New operator",
    "operations-wnet": "WNET's role",
    "operations-reason": "Reason for the transition",
    "viewing-heading": "Viewing and Passport",
    "viewing-immediate": "Immediate viewer changes",
    "viewing-passport": "Existing Passport access",
    "viewing-action": "Actions for viewers",
    "donations-heading": "Donations and renewals",
    "donations-recurring": "Recurring donations",
    "donations-renew": "Renew or donate",
    "donations-check": "Donate by check",
    "donations-payment": "Payment information",
    "donations-history": "Prior giving history",
    "data-heading": "Data, preferences, and help",
    "data-handling": "Personal and payment information",
    "data-help": "Contact for help",
    "data-updates": "Member updates",
  },
  accessibility: {
    "body-copy": "Accessibility introduction",
    conformance: "Conformance statement",
    "known-limitations": "Known limitations",
    "feedback-channel": "Feedback channel",
    "feedback-actions": "Accessibility contact actions",
    "disability-assistance": "Disability-assistance contact",
    "university-actions": "Montclair accessibility action",
  },
  "closed-captioning": {
    "body-copy": "Captioning introduction",
    "quality-certification": "Closed-captioning quality certification",
    "immediate-response": "Immediate response for captioning concerns",
    "immediate-actions": "Immediate response actions",
    "written-complaints": "Written complaints",
    "complaint-actions": "FCC complaint action",
    "complaint-details": "What to include",
  },
  privacy: {
    "body-copy": "Privacy notice introduction",
    "university-notice": "Montclair privacy notice action",
    "data-collected": "Data collected",
    "analytics-cookies": "Analytics and cookies",
    "third-party-services": "Third-party services",
    "donation-passport-data": "Donation and Passport data",
    "privacy-choices": "Privacy choices",
    "contact-details": "Privacy contact",
    "contact-actions": "Privacy contact actions",
  },
  "public-file": {
    "body-copy": "Public file introduction",
    "file-guidance": "What the public file is",
    "station-file-actions": "Station public files",
    "representative-contact": "Station-representative contact",
    "disability-assistance": "Disability-assistance contact",
    "assistance-actions": "Public file assistance actions",
  },
  eeo: {
    "current-report": "Current EEO public-file report",
    "report-action": "Current EEO report action",
    "broadcast-program": "The broadcast EEO program",
    "report-coverage": "What the report covers",
    "contact-details": "EEO contact",
    "contact-actions": "EEO contact actions",
  },
  "public-meetings": {
    "body-copy": "Meeting notices introduction",
    "meeting-notices": "PDF notices",
    "njpba-notices": "NJPBA public meeting notices",
    "montclair-notices": "Montclair State University public meeting notices",
    "notice-actions": "Official meeting notice actions",
    "open-meetings-act": "Open Public Meetings Act",
  },
});

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function pageHasCompositionSeed(pageId: PublicPageId): boolean {
  return PAGE_COMPOSITION_SEEDS[pageId] !== undefined;
}

export function pageCompositionSeed(pageId: PublicPageId): PageCompositionSeed | null {
  if (pageId === "data-hub") return {pageId,capturedAt:"2026-10-22T12:00:00.000Z",sourcePath:"/data-hub/",
    metadata:{title:"New Jersey by the Numbers",description:"Official New Jersey figures and related reporting.",slug:"data-hub"},blocks:[]};
  const composition = PAGE_COMPOSITION_SEEDS[pageId];
  return composition ? copyJson(composition) : null;
}

export function pageCompositionFixedRegions(
  pageId: PublicPageId,
  options?: { homeCompositionVersion?: 1 | 2 },
): PageCompositionFixedRegion[] {
  if (pageId === "home" && options?.homeCompositionVersion !== undefined) {
    return [{
      label: "Newsletter signup",
      detail: "The public Home newsletter band stays in its assigned position. It is not a Page block.",
    }];
  }
  return (PAGE_COMPOSITION_FIXED_REGIONS[pageId] ?? []).map((region) => ({ ...region }));
}

export function pageSeedAsset(assetId: string): PageSeedAsset | null {
  const asset = PAGE_SEED_ASSETS[assetId];
  return asset ? { ...asset } : null;
}

export function pageSeedAssetIds(): string[] {
  return Object.keys(PAGE_SEED_ASSETS);
}

export function pageCompositionRegionLabel(
  pageId: PublicPageId,
  sectionId: string | undefined,
): string | null {
  return sectionId ? PAGE_COMPOSITION_REGION_LABELS[pageId]?.[sectionId] ?? null : null;
}

