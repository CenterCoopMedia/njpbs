export const ADMIN_DOCS_BASE = "/admin/docs/";

export interface AdminDocPage {
  slug: string;
  title: string;
  description: string;
  audience: string;
}

export interface AdminDocSection {
  id: string;
  title: string;
  description: string;
  pages: readonly AdminDocPage[];
}

export const ADMIN_DOC_SECTIONS: readonly AdminDocSection[] = [
  {
    id: "start-here",
    title: "Start here",
    description:
      "Understand the CMS, get approved access, and set up a workspace that matches how you work.",
    pages: [
      {
        slug: "boardwalk-usage",
        title: "Boardwalk usage analytics and privacy",
        description: "Understand usage analytics, privacy limits and the aggregate Reports view.",
        audience: "All staff",
      },
      {
        slug: "first-session",
        title: "Your first Boardwalk session",
        description:
          "Follow a screenshot walkthrough to find an assigned draft, make one small edit, save it, and hand it to your reviewer.",
        audience: "New staff and training leads",
      },
      {
        slug: "overview",
        title: "Overview",
        description:
          "What Boardwalk controls, how drafts relate to the public site, and where each task begins.",
        audience: "All staff",
      },
      {
        slug: "access-and-roles",
        title: "Access and roles",
        description:
          "Sign in, request access, understand permissions, and recover an account without exposing sensitive information.",
        audience: "All staff",
      },
      {
        slug: "navigation-and-preferences",
        title: "Rail and preferences",
        description:
          "Use Home, the rail, account controls, density settings, and the mobile rail.",
        audience: "All staff",
      },
      {
        slug: "video-tutorials",
        title: "Video tutorials",
        description:
          "Play the Boardwalk task videos and open the written section for each task.",
        audience: "All staff",
      },
    ],
  },
  {
    id: "create-and-edit",
    title: "Create and edit",
    description:
      "Find the right record, make an accessible change, and save a dependable draft.",
    pages: [
      {
        slug: "pages-posts-and-library",
        title: "Pages, posts, and All content",
        description:
          "Choose the right content type, search and filter the library, create records, and return to saved views.",
        audience: "Writers and editors",
      },
      {
        slug: "nj-decides",
        title: "NJ Decides election night",
        description:
          "Set the election brand and banner, prepare the hub Page, and review manual or automatic results.",
        audience: "Election producers, editors and Managers",
      },
      {
        slug: "block-editor",
        title: "Block editor",
        description:
          "Work with the content outline, editable blocks, locked regions, block settings, order, and visibility.",
        audience: "Writers and editors",
      },
      {
        slug: "create-live-blog",
        title: "Create a live blog",
        description: "Start a Post, prepare the first updates, choose election branding, and preview and publish the opening coverage.",
        audience: "Writers and editors",
      },
      {
        slug: "run-live-blog",
        title: "Run a live blog",
        description: "Add updates, correct or withdraw reporting, manage reader updates, and pause or end coverage.",
        audience: "Writers and editors",
      },
      {
        slug: "metadata-and-media",
        title: "Metadata and media",
        description:
          "Maintain search and social metadata, choose reusable assets, and write useful alternative text and credits.",
        audience: "Writers and editors",
      },
      {
        slug: "shared-video-library",
        title: "Videos",
        description:
          "Browse, upload, play, seek through, download, and maintain private staff video files in Boardwalk.",
        audience: "All approved staff",
      },
      {
        slug: "premiere-panel",
        title: "Premiere Pro panel",
        description:
          "Connect the Boardwalk panel in Adobe Premiere Pro, import shared library video, keep source markers, and return finished videos.",
        audience: "Video editors and producers",
      },
      {
        slug: "storydesk-transfers",
        title: "StoryDesk transfers",
        description: "Send selected items to StoryDesk, import a private Post draft, and review transfer outcomes.",
        audience: "Staff with media or content access",
      },
      {
        slug: "accessible-workflows",
        title: "Accessible editorial work",
        description:
          "Use the CMS with keyboard, zoom, reduced motion, and narrow screens while creating accessible public content.",
        audience: "All staff",
      },
    ],
  },
  {
    id: "review-and-administer",
    title: "Review and administer",
    description:
      "Recover earlier work, move content through review, and use the administrative surfaces safely.",
    pages: [
      {
        slug: "drafts-revisions-and-recovery",
        title: "Drafts, revisions, and recovery",
        description:
          "Save without publishing, inspect revision history, handle unsaved work, and resolve locks or version conflicts.",
        audience: "Writers, editors, and Managers",
      },
      {
        slug: "review-preview-and-publish",
        title: "Review, preview, and publish",
        description:
          "Save, review, preview, publish, and verify CMS content.",
        audience: "Editors and Managers",
      },
      {
        slug: "voiceover-library",
        title: "Audio",
        description:
          "Find, upload, organize, and review station audio in one Media library tab.",
        audience: "All approved staff",
      },
      {
        slug: "profiles-access-and-administration",
        title: "Profiles, access, and administration",
        description:
          "Manage bylines, review staff profiles, inspect activity, maintain settings, and apply least-privilege access.",
        audience: "Staff and Managers",
      },
      {
        slug: "analytics",
        title: "Analytics",
        description: "Assess story reach, reader attention, referrals, and website delivery.",
        audience: "Managers and Site owners",
      },
      {
        slug: "api-access-and-integrations",
        title: "API access and integrations",
        description:
          "Understand the CMS API connection boundary, supported work, authentication, and current integration limits.",
        audience: "Developers and Managers",
      },
    ],
  },
  {
    id: "help",
    title: "Help",
    description:
      "Diagnose common problems, collect useful evidence, and use the CMS vocabulary consistently.",
    pages: [
      {
        slug: "troubleshooting",
        title: "Troubleshooting and support",
        description:
          "Resolve common sign-in, loading, saving, media, preview, and permission problems and report what remains.",
        audience: "All staff",
      },
      {
        slug: "glossary",
        title: "Glossary",
        description:
          "Plain-language definitions for the terms used throughout the NJ PBS editorial workflow.",
        audience: "All staff",
      },
    ],
  },
] as const;

export const ADMIN_DOC_PAGES = ADMIN_DOC_SECTIONS.flatMap((section) =>
  section.pages.map((page) => ({
    ...page,
    sectionId: section.id,
    sectionTitle: section.title,
    href: `${ADMIN_DOCS_BASE}${page.slug}/`,
  })),
);

export type AdminDocPageWithSection = (typeof ADMIN_DOC_PAGES)[number];

export function normalizeAdminDocsPath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || ADMIN_DOCS_BASE;
  return path.endsWith("/") ? path : `${path}/`;
}

export function findAdminDocPage(
  pathname: string,
): AdminDocPageWithSection | undefined {
  const normalized = normalizeAdminDocsPath(pathname);
  return ADMIN_DOC_PAGES.find((page) => page.href === normalized);
}

export function adminDocNeighbours(pathname: string): {
  previous?: AdminDocPageWithSection;
  next?: AdminDocPageWithSection;
} {
  const current = findAdminDocPage(pathname);
  if (!current) return {};

  const index = ADMIN_DOC_PAGES.findIndex((page) => page.href === current.href);
  return {
    previous: index > 0 ? ADMIN_DOC_PAGES[index - 1] : undefined,
    next:
      index < ADMIN_DOC_PAGES.length - 1
        ? ADMIN_DOC_PAGES[index + 1]
        : undefined,
  };
}
