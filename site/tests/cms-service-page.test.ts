import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  pageCompositionSeed,
  pageSeedAsset,
  pageSeedAssetIds,
} from "../../packages/content-core/src/page-composition-seeds";
import type { PublicPageId } from "../../packages/content-core/src/public-pages";
import { projectCmsServicePage } from "../src/lib/cms-service-page";
import {
  renderServiceBody,
  renderServiceCards,
  servicePageClass,
} from "../src/lib/cms-service-render";
import { njDecidesServiceHeading } from "../../packages/content-core/src/nj-decides-page";
import { launchFallbackPages } from "../src/data/launch-fallback";

function serviceInput(pageId: PublicPageId = "watch") {
  const seed = pageCompositionSeed(pageId);
  if (!seed) throw new Error(`${pageId} composition seed is missing`);
  const assets = Object.fromEntries(
    pageSeedAssetIds().map(
      (assetId) => {
        const asset = pageSeedAsset(assetId);
        if (!asset) throw new Error(`Watch seed asset ${assetId} is missing`);
        return [
          assetId,
          {
            url: asset.sourceUrl,
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
          },
        ];
      },
    ),
  );
  return {
    frame: launchFallbackPages[pageId]!,
    title: String(seed.metadata.title),
    description: String(seed.metadata.description),
    blocks: seed.blocks,
    assets,
  };
}

describe("CMS service public-page projection", () => {
  it("preserves saved hero button variants independently of their position", () => {
    const input = serviceInput();
    const actions = input.blocks.find((block) => block.section === "hero-actions");
    if (actions?.type !== "cta_row") throw new Error("Missing hero actions");
    actions.data.ctas = [
      { label: "First secondary", href: "/live/", variant: "secondary" },
      { label: "Second primary", href: "/watch/", variant: "primary" },
      { label: "Default", href: "/about/" },
    ];
    expect(projectCmsServicePage(input).actions.map((action) => action.variant))
      .toEqual(["secondary", "primary", undefined]);
  });

  it.each(["watch", "live", "kids", "support", "give", "passport", "about"] as const)(
    "maps the complete %s seed once, without a duplicate content tail",
    (pageId) => {
      const input = serviceInput(pageId);
      const projected = projectCmsServicePage(input);
      expect(projected.page.slug).toBe(pageId);
      expect(projected.page.body).toEqual([]);
      expect(projected.remainingBlocks).toEqual([]);
      expect(projected.actions.length).toBeGreaterThan(0);
      expect(projected.bodyHtml).toBeTruthy();
      if (pageId === "about") expect(projected.cards).toEqual([]);
      else expect(projected.cards.length).toBeGreaterThan(0);
      expect(projected.sections).toHaveLength(pageId === "about" ? 7 : ["live", "kids"].includes(pageId) ? 2 : 0);
      expect(Boolean(projected.noticeHtml)).toBe(["support", "give", "passport"].includes(pageId));
    },
  );

  it("keeps About section order and rich links while reflecting hidden and removed regions", () => {
    const input = serviceInput("about");
    const contact = input.blocks.find((block) => block.section === "contact-guidance")!;
    const blocks = input.blocks
      .filter((block) => !["body-copy", "service-note", "contact-actions"].includes(block.section ?? ""))
      .map((block) => block.section === "montclair-role"
        ? { ...block, visible: false }
        : block.id === contact.id ? { ...block, order: -1 } : block);
    const projected = projectCmsServicePage({ ...input, blocks });
    expect(projected.sections[0]?.id).toBe(contact.id);
    expect(projected.sections).toHaveLength(5);
    expect(projected.sections.map((section) => section.html).join("")).toContain("https://inside.montclair.edu/");
    expect(projected.bodyHtml).toBeUndefined();
    expect(projected.noteHtml).toBeUndefined();
    expect(projected.remainingBlocks).toEqual([]);
  });

  it("uses the shared reading layout unless the page declares destination cards", () => {
    const about = projectCmsServicePage(serviceInput("about"));
    const legacyAbout = {
      ...about,
      blockIds: { ...about.blockIds, cards: "legacy-about-destinations" },
      cards: [{
        title: "Legacy destination",
        href: "/watch/",
        external: false,
      }],
    };
    const watch = projectCmsServicePage(serviceInput("watch"));

    expect(servicePageClass(legacyAbout.page)).toBe("public-page");
    expect(renderServiceBody(legacyAbout)).not.toContain("public-page__side");
    expect(renderServiceBody(legacyAbout)).not.toContain("Legacy destination");
    expect(servicePageClass(watch.page)).toContain("public-page--wide-cards");
    expect(renderServiceBody(watch)).toContain("public-page__side");
    expect(renderServiceBody(watch)).toContain("Programs on demand");
  });

  it("does not restore deleted notice, cards or actions from the committed giving frame", () => {
    const projected = projectCmsServicePage({ ...serviceInput("give"), blocks: [] });
    expect(projected.noticeHtml).toBeUndefined();
    expect(projected.noticeActions).toEqual([]);
    expect(projected.actions).toEqual([]);
    expect(projected.cards).toEqual([]);
    expect(projected.page.body).toEqual([]);
  });
  it("keeps editor-authored rich-text links outside the card destination link", () => {
    const cmsCards = renderServiceCards(projectCmsServicePage(serviceInput()));
    expect(cmsCards).not.toMatch(/<a\s+class="public-page__card"/);
    expect(cmsCards).toContain("public-page__card-title-link");
    expect(cmsCards).toContain('</a></strong><div class="public-page__card-description">');
  });

  it("fills the real Watch frame from the four editable regions without a duplicate block tail", () => {
    const projected = projectCmsServicePage(serviceInput());

    expect(projected.page).toMatchObject({
      slug: "watch",
      title: "Watch NJ PBS",
      description:
        "Find NJ PBS programs, PBS series, full episodes, specials, and Passport video on demand.",
      body: [],
    });
    expect(projected.actions).toEqual([
      {
        label: "Open PBS video portal",
        href: "https://watch.njpbs.org/",
        external: true,
        variant: "primary",
      },
      { label: "Watch live", href: "/live/", external: false, variant: "secondary" },
    ]);
    expect(projected.bodyHtml).toContain(
      "Use Watch for NJ PBS video you can play on demand",
    );
    expect(projected.cards).toHaveLength(4);
    expect(projected.cards[0]).toMatchObject({
      label: "Watch",
      title: "Programs on demand",
      href: "https://watch.njpbs.org/",
      image: {
        url: "https://njpbs.org/brand/spotlight/watch.jpg",
        mimeType: "image/jpeg",
        width: 640,
        height: 360,
      },
      imageAssetId: "launch-watch",
    });
    expect(projected.cards[0]?.bodyHtml).toContain(
      "Open the PBS-hosted video portal",
    );
    expect(projected.noteHtml).toContain(
      "PBS handles the player, app, account sign-in, and video availability.",
    );
    expect(projected.remainingBlocks).toEqual([]);
  });

  it("routes Watch card art through the shared responsive descriptor renderer", () => {
    const route = readFileSync(
      join(process.cwd(), "src/pages/[...slug].astro"),
      "utf8",
    );
    const projected = projectCmsServicePage(serviceInput());
    projected.cards[0]!.image!.srcset = "https://njpbs.org/small.jpg 320w, https://njpbs.org/large.jpg 640w";
    const cards = renderServiceCards(projected);

    expect(route).toContain("resolveCmsResponsiveAssets");
    expect(route).toContain('responsiveImageKey(card.imageAssetId, "grid")');
    expect(cards).toContain('srcset="https://njpbs.org/small.jpg 320w, https://njpbs.org/large.jpg 640w"');
    expect(cards).toContain('loading="lazy"');
  });

  it("reflects edits and removals while leaving unrelated added blocks for the canonical tail renderer", () => {
    const input = serviceInput();
    const [actions, body, cards, note] = input.blocks;
    if (!actions || !body || !cards || !note) {
      throw new Error("Watch composition is incomplete");
    }
    const added = {
      id: "added-heading",
      type: "headline" as const,
      order: 4,
      visible: true,
      data: { text: "More to watch", level: 2 },
    };
    const editedActions = {
      id: actions.id,
      type: "cta_row" as const,
      section: actions.section,
      order: actions.order,
      visible: true,
      data: {
        ctas: [
          {
            label: "Browse episodes",
            href: "https://watch.njpbs.org/",
            variant: "primary" as const,
          },
        ],
      },
    };

    const projected = projectCmsServicePage({
      ...input,
      blocks: [
        editedActions,
        cards,
        note,
        added,
      ],
    });

    expect(projected.actions.map((action) => action.label)).toEqual([
      "Browse episodes",
    ]);
    expect(projected.bodyHtml).toBeUndefined();
    expect(projected.remainingBlocks).toEqual([added]);
  });
});

describe("NJ Decides legacy service heading", () => {
  it("preserves all saved hero actions outside the band's two-link limit", () => {
    const input = serviceInput("watch");
    const actions = input.blocks.find(block => block.section === "hero-actions")!;
    const projected = projectCmsServicePage({ ...input, blocks: [{ ...actions, type: "cta_row", data: {
      ctas: [1, 2, 3].map(number => ({ label: `Saved action ${number}`, href: `/saved-${number}/`, variant: "primary" as const })),
    } }] });
    const heading = njDecidesServiceHeading(projected);
    expect(heading.description).toBe(projected.summary);
    expect(heading.actionsHtml.match(/<a /g)).toHaveLength(3);
    expect(heading.actionsHtml.indexOf("Saved action 1")).toBeLessThan(heading.actionsHtml.indexOf("Saved action 3"));
    expect(renderServiceBody(projected)).not.toContain("Saved action 1");
  });
  it("keeps Live introduction and actions together below the player exactly once", () => {
    const service = projectCmsServicePage(serviceInput("live"));
    expect(njDecidesServiceHeading(service)).toEqual({ description: "", actionsHtml: "" });
    expect(renderServiceBody(service)).toContain(service.summary);
  });
});
