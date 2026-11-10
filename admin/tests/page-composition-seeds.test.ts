import { describe, expect, it } from "vitest";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { validateSection } from "../../packages/content-core/src/editor-admin";
import {
  pageCompositionFixedRegions,
  pageCompositionRegionLabel,
  pageCompositionSeed,
  pageSeedAsset,
} from "../../packages/content-core/src/page-composition-seeds";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";

const SERVICE_PAGE_IDS = [
  "watch",
  "live",
  "kids",
  "support",
  "give",
  "passport",
  "about",
] as const;

const EXPECTED_REGIONS = {
  watch: [
    ["hero-actions", "cta_row"],
    ["body-copy", "prose"],
    ["watch-destinations", "card_grid"],
    ["service-note", "prose"],
  ],
  live: [
    ["hero-actions", "cta_row"],
    ["body-copy", "prose"],
    ["caption-guidance", "prose"],
    ["caption-actions", "cta_row"],
    ["service-note", "prose"],
    ["service-destinations", "card_grid"],
  ],
  kids: [
    ["hero-actions", "cta_row"],
    ["body-copy", "prose"],
    ["broadcast-guidance", "prose"],
    ["broadcast-actions", "cta_row"],
    ["service-destinations", "card_grid"],
  ],
  support: [
    ["hero-actions", "cta_row"],
    ["transition-notice", "prose"],
    ["transition-actions", "cta_row"],
    ["body-copy", "prose"],
    ["service-destinations", "card_grid"],
  ],
  give: [
    ["hero-actions", "cta_row"],
    ["transition-notice", "prose"],
    ["transition-actions", "cta_row"],
    ["body-copy", "prose"],
    ["service-note", "prose"],
    ["service-destinations", "card_grid"],
  ],
  passport: [
    ["hero-actions", "cta_row"],
    ["transition-notice", "prose"],
    ["transition-actions", "cta_row"],
    ["body-copy", "prose"],
    ["service-note", "prose"],
    ["service-destinations", "card_grid"],
  ],
  about: [
    ["hero-actions", "cta_row"],
    ["body-copy", "prose"],
    ["what-njpbs-is", "prose"],
    ["montclair-role", "prose"],
    ["spotlight-announcement", "prose"],
    ["member-stations", "prose"],
    ["what-continues", "prose"],
    ["contact-guidance", "prose"],
    ["contact-actions", "cta_row"],
    ["service-note", "prose"],
  ],
} as const;

describe("page composition seeds", () => {
  it("captures the current Watch page as recognizable editable regions in public order", () => {
    const seed = pageCompositionSeed("watch");

    expect(seed?.metadata).toEqual({
      title: "Watch NJ PBS",
      description:
        "Find NJ PBS programs, PBS series, full episodes, specials, and Passport video on demand.",
      seo: { description: "Browse NJ PBS programs and PBS series on demand." },
    });
    expect(seed?.blocks.map((block) => [block.section, block.type])).toEqual([
      ["hero-actions", "cta_row"],
      ["body-copy", "prose"],
      ["watch-destinations", "card_grid"],
      ["service-note", "prose"],
    ]);
    expect(seed?.blocks[0]?.data).toEqual({
      ctas: [
        {
          label: "Open PBS video portal",
          href: "https://watch.njpbs.org/",
          variant: "primary",
        },
        { label: "Watch live", href: "/live/", variant: "secondary" },
      ],
    });
    expect(seed?.blocks[2]?.data).toEqual({
      cards: [
        expect.objectContaining({
          label: "Watch",
          title: "Programs on demand",
          imageAssetId: "launch-watch",
          href: "https://watch.njpbs.org/",
        }),
        expect.objectContaining({
          label: "Member",
          title: "PBS Passport",
          imageAssetId: "launch-support",
          href: "https://watch.njpbs.org/passport/learn-more/",
        }),
        expect.objectContaining({
          label: "Live",
          title: "Livestream",
          imageAssetId: "launch-under-the-dome",
          href: "/live/",
        }),
        expect.objectContaining({
          label: "App",
          title: "PBS app",
          imageAssetId: "launch-about",
          href: "https://www.pbs.org/pbs-app/",
        }),
      ],
    });
  });

  it("returns a fresh, valid, deterministic Watch draft without exposing an unmigrated page seed", () => {
    const first = pageCompositionSeed("watch");
    const second = pageCompositionSeed("watch");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.blocks).not.toBe(second?.blocks);
    expect(first?.blocks.every((block, index) => block.order === index)).toBe(true);
    expect(new Set(first?.blocks.map((block) => block.id)).size).toBe(first?.blocks.length);

    const parsed = parseBlocks(first?.blocks);
    expect(parsed.ok).toBe(true);
    expect(validateSection("programLanding", first?.blocks ?? [])).toBeNull();
  });

  it.each(PUBLIC_PAGES)(
    "gives $title a fresh, valid, deterministic populated composition",
    (page) => {
      const first = pageCompositionSeed(page.id);
      const second = pageCompositionSeed(page.id);

      expect(first, page.id).not.toBeNull();
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(first?.pageId).toBe(page.id);
      expect(first?.sourcePath).toBe(page.path);
      expect(first?.metadata.title).toEqual(expect.any(String));
      expect(first?.metadata.title).not.toBe("");
      expect(first?.metadata.description).toEqual(expect.any(String));
      expect(first?.metadata.description).not.toBe("");
      if (["home", "staff", "data-hub"].includes(page.id)) {
        // These public frames own their primary content. Home admits its manual shelf
        // separately; Staff generates its roster from detached public profiles. Authored
        // blocks remain optional; Data Hub permits only its compiled figure layout.
        expect(first?.blocks).toEqual([]);
      } else {
        expect(first?.blocks.length).toBeGreaterThan(0);
      }
      expect(first?.blocks.every((block, index) => block.order === index)).toBe(true);
      expect(new Set(first?.blocks.map((block) => block.id)).size).toBe(first?.blocks.length);
      expect(parseBlocks(first?.blocks).ok).toBe(true);
      expect(validateSection(page.editorTemplate, first?.blocks ?? [])).toBeNull();

      for (const block of first?.blocks ?? []) {
        expect(pageCompositionRegionLabel(page.id, block.section), block.section).toEqual(
          expect.any(String),
        );
      }
    },
  );

  it("seeds the Staff presentation while keeping the generated roster fixed", () => {
    expect(pageCompositionSeed("staff")).toMatchObject({
      metadata: {
        title: "Staff",
        description: "Meet the people who make NJ PBS.",
        seo: { description: "Meet the people who make NJ PBS." },
      },
      blocks: [],
    });
    expect(pageCompositionFixedRegions("staff")).toEqual([
      {
        label: "Published staff roster",
        detail: "The roster is generated from published public author profiles. It is read-only on this Page and cannot be replaced with authored blocks.",
      },
    ]);
  });

  it("preserves public-page indexing, schedule order, and representative contact behavior", () => {
    expect(pageCompositionSeed("contact")?.metadata.seo).toMatchObject({ noindex: true });
    expect(pageCompositionSeed("faq")?.metadata.seo).toMatchObject({ noindex: true });

    const scheduleCopy = pageCompositionSeed("schedule")?.blocks.find(
      (block) => block.section === "body-copy",
    );
    expect(JSON.stringify(scheduleCopy?.data)).not.toContain("schedule below");

    const representativeContact = pageCompositionSeed("public-file")?.blocks.find(
      (block) => block.section === "representative-contact",
    );
    expect(JSON.stringify(representativeContact?.data)).toContain(
      "mailto:nichol.gee@treas.nj.gov",
    );
    expect(JSON.stringify(representativeContact?.data)).toContain("tel:+16099849449");
  });

  it("keeps the fixed Home frame out of the editable seed", () => {
    const first = pageCompositionSeed("home");
    const second = pageCompositionSeed("home");

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.metadata).toEqual({
      title: "Home",
      description: "The new NJ PBS — New Jersey's public television, live and on demand.",
      seo: {
        description: "Watch NJ PBS live and on demand, explore programs, and follow New Jersey news.",
      },
    });
    expect(first?.blocks).toEqual([]);
    expect(first?.blocks.every((block, index) => block.order === index)).toBe(true);
    expect(new Set(first?.blocks.map((block) => block.id)).size).toBe(first?.blocks.length);
    expect(parseBlocks(first?.blocks).ok).toBe(true);
    expect(validateSection("home", first?.blocks ?? [])).toBeNull();
    expect(pageCompositionFixedRegions("home")).toEqual([
      {
        label: "Public Home frame",
        detail: "The hero, newsletter signup, program and news shelves, and Passport band stay fixed. Up to eight manual content shelves are editable.",
      },
    ]);
    for (const block of first?.blocks ?? []) {
      expect(pageCompositionRegionLabel("home", block.section), block.section).toEqual(
        expect.any(String),
      );
    }
  });

  it.each(SERVICE_PAGE_IDS)(
    "returns a fresh, valid, deterministic %s composition in public order",
    (pageId) => {
      const first = pageCompositionSeed(pageId);
      const second = pageCompositionSeed(pageId);

      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(first?.pageId).toBe(pageId);
      expect(first?.sourcePath).toBe(`/${pageId}/`);
      expect(first?.metadata.title).toEqual(expect.any(String));
      expect(first?.metadata.description).toEqual(expect.any(String));
      expect(first?.blocks.map((block) => [block.section, block.type])).toEqual(
        EXPECTED_REGIONS[pageId],
      );
      expect(first?.blocks.every((block, index) => block.order === index)).toBe(true);
      expect(new Set(first?.blocks.map((block) => block.id)).size).toBe(first?.blocks.length);
      expect(parseBlocks(first?.blocks).ok).toBe(true);
      expect(validateSection("programLanding", first?.blocks ?? [])).toBeNull();

      for (const block of first?.blocks ?? []) {
        expect(pageCompositionRegionLabel(pageId, block.section), block.section).toEqual(
          expect.any(String),
        );
      }
    },
  );

  it.each(["support", "give", "passport"] as const)(
    "keeps the %s transition seed on current Passport guidance",
    (pageId) => {
      const blocks = pageCompositionSeed(pageId)?.blocks ?? [];
      const notice = blocks.find((block) => block.section === "transition-notice");
      const actions = blocks.find((block) => block.section === "transition-actions");
      const noticeText = JSON.stringify(notice?.data);

      expect(noticeText).toContain("PBS manages Passport account status");
      expect(noticeText).not.toContain("July 31, 2026");
      expect(actions?.data).toEqual({
        ctas: [
          { label: "See the full transition FAQ", href: "/faq/", variant: "secondary" },
          {
            label: "Look up Passport access",
            href: "https://www.pbs.org/passport/lookup/",
            variant: "secondary",
          },
        ],
      });
    },
  );

  it("preserves the page-specific service content and external-system boundaries", () => {
    expect(pageCompositionSeed("live")?.blocks[0]?.data).toEqual({
      ctas: [
        {
          label: "Open PBS livestream",
          href:
            "https://player.pbs.org/ga-livestream-partnerplayer/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&feed_cid=4211290e-ce30-49e5-9be1-2c412c5b3278",
          variant: "primary",
        },
        { label: "See the schedule", href: "/schedule/", variant: "secondary" },
      ],
    });
    expect(pageCompositionFixedRegions("live")).toEqual([
      {
        label: "PBS livestream player",
        detail: "PBS owns playback, location rules, and player behavior.",
      },
      {
        label: "Live schedule",
        detail: "The current and upcoming programs come from the PBS schedule feed.",
      },
    ]);
    expect(pageCompositionFixedRegions("kids")).toEqual([]);

    expect(pageCompositionSeed("kids")?.blocks.at(-1)?.data).toEqual({
      cards: [
        expect.objectContaining({ title: "PBS Kids video", href: "https://pbskids.org/video/" }),
        expect.objectContaining({ title: "PBS Kids games", href: "https://pbskids.org/games/" }),
        expect.objectContaining({ title: "Family resources", href: "https://www.pbs.org/parents/" }),
      ],
    });
    expect(pageCompositionSeed("give")?.metadata.title).toBe("Give to NJ PBS");
    expect(pageCompositionSeed("passport")?.blocks.at(-1)?.data).toEqual({
      cards: [
        expect.objectContaining({ title: "Donate through PBS", imageAssetId: "launch-give" }),
        expect.objectContaining({ title: "Find Passport access", imageAssetId: "launch-passport" }),
        expect.objectContaining({ title: "PBS Passport help", imageAssetId: "launch-support" }),
      ],
    });
    expect(pageCompositionSeed("about")?.blocks.map((block) => block.section)).toContain(
      "member-stations",
    );
  });

  it("keeps the About seed aligned with the public announcement and contact copy", () => {
    const blocks = pageCompositionSeed("about")?.blocks ?? [];
    const announcement = blocks.find(
      (block) => block.section === "spotlight-announcement",
    );
    const contact = blocks.find((block) => block.section === "contact-guidance");

    expect(JSON.stringify(announcement?.data)).toContain("NJ Spotlight News");
    expect(JSON.stringify(announcement?.data)).toContain(
      "Montclair State University will acquire NJ Spotlight and has committed to continuing its watchdog journalism through NJ PBS.",
    );
    expect(JSON.stringify(announcement?.data)).toContain("Read the announcement");
    expect(JSON.stringify(announcement?.data)).toContain(
      "https://inside.montclair.edu/news/montclair-state-university-acquire-nj-spotlight-commits-continuing-its-watchdog-journalism-through",
    );
    expect(JSON.stringify(contact?.data)).toContain(
      "Mailing address: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",
    );
  });

  it("describes every migrated service thumbnail as a finite seed asset", () => {
    expect(pageSeedAsset("launch-watch")).toEqual({
      id: "launch-watch",
      publicPath: "/brand/spotlight/watch.jpg",
      sourceUrl: "https://njpbs.org/brand/spotlight/watch.jpg",
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    });
    for (const assetId of [
      "launch-support",
      "launch-under-the-dome",
      "launch-about",
      "launch-give",
      "launch-passport",
      "launch-contact",
      "launch-politics",
    ]) {
      expect(pageSeedAsset(assetId)).toMatchObject({
        id: assetId,
        publicPath: expect.stringMatching(/^\/brand\/spotlight\/.+\.jpg$/),
        sourceUrl: expect.stringMatching(/^https:\/\/njpbs\.org\/brand\/spotlight\/.+\.jpg$/),
        mimeType: "image/jpeg",
        width: 640,
        height: 360,
      });
    }
    expect(pageSeedAsset("not-a-seed-asset")).toBeNull();
  });

  it("describes the four current Home destination images without copying dynamic feed cards", () => {
    for (const assetId of [
      "home-start-live",
      "home-start-ondemand",
      "home-start-schedule",
      "home-start-kids",
    ]) {
      expect(pageSeedAsset(assetId)).toMatchObject({
        id: assetId,
        publicPath: expect.stringMatching(/^\/brand\/starthere\/.+\.webp$/),
        sourceUrl: expect.stringMatching(/^https:\/\/njpbs\.org\/brand\/starthere\/.+\.webp$/),
        mimeType: "image/webp",
        width: 800,
        height: 450,
      });
    }
  });
});
