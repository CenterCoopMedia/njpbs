import { describe, expect, it } from "vitest";
import serverContract from "../../functions/lib/cms-settings-contract.js";
import {
  DEFAULT_SITE_NAVIGATION,
  CMS_SETTINGS_READ_SCHEMAS,
  projectPublishedCmsSettings,
  SITE_NAVIGATION_SETTINGS_ID,
  cmsSettingsSchemaFor,
  cloneSettingsValues,
  currentCmsSettingsSchemaFor,
  validateCmsSettingsValues,
  type SiteNavigationColumn,
  type SiteNavigationLink,
  type SiteNavigationSettingsValues,
} from "../../packages/content-core/src/cms-settings";
import {
  resolveSiteNavigation,
  validSiteNavigationValues,
} from "../../packages/content-core/src/site-navigation";
import {
  donateUrl,
  passportLearnMoreUrl,
  pbsVideoUrl,
} from "../src/data/launch-fallback";

const schema = cmsSettingsSchemaFor(SITE_NAVIGATION_SETTINGS_ID, 1)!;

function clone(): {
  header: SiteNavigationLink[];
  footer: { id: string; heading: string; links: SiteNavigationLink[] }[];
} {
  return JSON.parse(JSON.stringify(DEFAULT_SITE_NAVIGATION));
}

function link(id: string, overrides: Partial<SiteNavigationLink> = {}): SiteNavigationLink {
  return {
    id,
    label: `Link ${id}`,
    target: { type: "page", pageId: "about" },
    external: false,
    ...overrides,
  };
}

function validate(values: unknown) {
  const local = validateCmsSettingsValues(schema, values);
  const server = serverContract.validateCmsSettingsValues(
    serverContract.cmsSettingsSchemaFor(SITE_NAVIGATION_SETTINGS_ID, 1),
    values,
  );
  // The Admin callable and the public build must reach the same decision.
  expect(server).toBe(local);
  return local;
}

describe("site navigation settings contract", () => {
  it("registers schema version 1 with the brief's limits in both contracts", () => {
    expect(currentCmsSettingsSchemaFor(SITE_NAVIGATION_SETTINGS_ID)?.schemaVersion).toBe(2);
    expect(cmsSettingsSchemaFor(SITE_NAVIGATION_SETTINGS_ID, 1)).toBe(schema);
    expect(schema.fields.header).toEqual({
      kind: "navigationLinks",
      required: true,
      maxItems: 12,
      labelMaxBytes: 80,
      hrefMaxBytes: 2048,
    });
    expect(schema.fields.footer).toMatchObject({
      kind: "navigationColumns",
      required: true,
      maxItems: 6,
      headingMaxBytes: 40,
      maxLinks: 10,
      labelMaxBytes: 80,
      hrefMaxBytes: 2048,
      lockedLinks: [{ id: "contact", target: { type: "page", pageId: "contact" } }],
    });
    expect(serverContract.cmsSettingsSchemaFor(SITE_NAVIGATION_SETTINGS_ID, 1)).toEqual(schema);
  });

  it("admits old duplicate headings only for management reads in both contracts", () => {
    expect(serverContract.CMS_SETTINGS_READ_SCHEMAS).toEqual(CMS_SETTINGS_READ_SCHEMAS);
    const values = clone();
    values.footer[1].heading = "  WATCH  ";
    const storedSchema = CMS_SETTINGS_READ_SCHEMAS[SITE_NAVIGATION_SETTINGS_ID].versions[1];
    expect(validateCmsSettingsValues(storedSchema, values)).toBeNull();
    expect(serverContract.validateCmsSettingsValues(storedSchema, values)).toBeNull();
    expect(validate(values)).toMatch(/heading must be unique/);
    expect(validSiteNavigationValues(values)).toBeNull();
    const document = { version: 4, published: {
      schemaVersion: 1, values, sourceVersion: 3, publishedAt: "2026-09-25T14:00:00.000Z",
    } };
    for (const project of [projectPublishedCmsSettings, serverContract.projectPublishedCmsSettings]) {
      expect(project({ documentId: SITE_NAVIGATION_SETTINGS_ID, document, schemas: CMS_SETTINGS_READ_SCHEMAS }))
        .toMatchObject({ values });
      expect(() => project({ documentId: SITE_NAVIGATION_SETTINGS_ID, document }))
        .toThrow(/heading must be unique/);
    }
    values.footer[1].links[0] = { ...values.footer[1].links[0], target: { type: "href", href: "javascript:alert(1)" } };
    expect(validateCmsSettingsValues(storedSchema, values)).toMatch(/safe link/);
    expect(serverContract.validateCmsSettingsValues(storedSchema, values)).toMatch(/safe link/);
  });

  it("accepts the seed", () => {
    expect(validate(DEFAULT_SITE_NAVIGATION)).toBeNull();
    expect(Object.isFrozen(DEFAULT_SITE_NAVIGATION.footer[0].links[0].target)).toBe(true);
  });

  it("enforces the header, column, link, heading, label, and href limits", () => {
    const tooManyHeader = clone();
    tooManyHeader.header = Array.from({ length: 13 }, (_, index) => link(`h-${index}`));
    expect(validate(tooManyHeader)).toMatch(/header can contain at most 12 links/);

    const tooManyColumns = clone();
    for (let index = 0; index < 3; index += 1) {
      tooManyColumns.footer.push({ id: `extra-${index}`, heading: "Extra", links: [link(`x-${index}`)] });
    }
    expect(validate(tooManyColumns)).toMatch(/footer can contain at most 6 columns/);

    const tooManyLinks = clone();
    tooManyLinks.footer[0].links = Array.from({ length: 11 }, (_, index) => link(`w-${index}`));
    expect(validate(tooManyLinks)).toMatch(/links can contain at most 10 links/);

    const longHeading = clone();
    longHeading.footer[0].heading = "h".repeat(41);
    expect(validate(longHeading)).toMatch(/heading can be at most 40 bytes/);

    const longLabel = clone();
    longLabel.header[0] = { ...longLabel.header[0], label: "é".repeat(41) };
    expect(validate(longLabel)).toMatch(/label can be at most 80 bytes/);

    const longHref = clone();
    longHref.header[0] = link("long", {
      target: { type: "href", href: `https://example.org/${"a".repeat(2048)}` },
    });
    expect(validate(longHref)).toMatch(/target link can be at most 2048 bytes/);

    const emptyLabel = clone();
    emptyLabel.header[0] = { ...emptyLabel.header[0], label: "   " };
    expect(validate(emptyLabel)).toMatch(/label is required/);

    const emptyColumn = clone();
    emptyColumn.footer[1].links = [];
    expect(validate(emptyColumn)).toMatch(/links must contain at least one link/);
  });

  it("rejects unsafe or malformed targets", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,hi",
      "//evil.example/",
      "/\\evil.example/",
      " https://example.org/",
      // A relative address resolves differently on each page.
      "schedule",
      "../contact",
      "./about/",
      "?ref=1",
      "#hours",
      "https://user:secret@example.test/",
      "http://user@example.test/",
      "https://:secret@example.test/",
      "HTTPS://us%65r:p%40ss@example.test/",
    ]) {
      const values = clone();
      values.header[0] = link("bad", { target: { type: "href", href } });
      expect(validate(values), href).not.toBeNull();
    }
    const route = clone();
    route.header[0] = link("bad", { target: { type: "route", key: "admin" } as never });
    expect(validate(route)).toMatch(/target is invalid/);

    const launch = clone();
    launch.header[0] = link("bad", { target: { type: "launch", key: "evil" } as never });
    expect(validate(launch)).toMatch(/target is invalid/);

    const extraField = clone();
    extraField.header[0] = link("bad", {
      target: { type: "page", pageId: "about", href: "https://example.org/" } as never,
    });
    expect(validate(extraField)).toMatch(/target is invalid/);

    const hash = clone();
    hash.header[0] = link("bad", { target: { type: "page", pageId: "about", hash: "a b" } });
    expect(validate(hash)).toMatch(/section anchor is invalid/);

    const external = clone();
    external.header[0] = { ...external.header[0], external: "yes" as never };
    expect(validate(external)).toMatch(/external must be a boolean/);
  });

  it("accepts root paths, web, mailto and tel links, and page section anchors", () => {
    const values = clone();
    values.header.push(link("relative", { target: { type: "href", href: "/posts/some-post/?ref=1#top" } }));
    values.header.push(link("web", { target: { type: "href", href: "HTTPS://example.org/" } }));
    values.header.push(link("mail", { target: { type: "href", href: "mailto:njpbs@montclair.edu" } }));
    values.header.push(link("phone", { target: { type: "href", href: "tel:+18008826622" } }));
    values.header.push(link("anchor", { target: { type: "page", pageId: "privacy", hash: "your-privacy-choices" } }));
    expect(validate(values)).toBeNull();
  });

  it.each(["Watch more", "  watch more  ", "WATCH   MORE", "Watch\tmore"])(
    "rejects duplicate footer headings after normalization: %s",
    (heading) => {
      const values = clone();
      values.footer[0].heading = "Watch more";
      values.footer[1].heading = heading;
      expect(validate(values)).toBe("footer[1].heading must be unique");
      values.footer[1].heading = "Other links";
      expect(validate(values)).toBeNull();
    },
  );

  it("normalizes stale new-tab flags in header and footer without mutating input", () => {
    const targets: SiteNavigationLink["target"][] = [
      { type: "page", pageId: "about" },
      { type: "route", key: "postsIndex" },
      { type: "route", key: "inTheNews" },
      { type: "href", href: "/about/" },
      { type: "href", href: "mailto:test@example.org" },
      { type: "href", href: "tel:+18008826622" },
      { type: "href", href: "HTTPS://example.org/" },
      { type: "launch", key: "pbsVideo" },
    ];
    const values = clone();
    values.header = targets.map((target, index) => link(`test-${index}`, { target, external: true }));
    values.footer[0].links = values.header;
    expect(validate(values)).toBeNull();
    const normalized = cloneSettingsValues(schema, values) as unknown as SiteNavigationSettingsValues;
    expect(serverContract.cloneSettingsValues(schema, values)).toEqual(normalized);
    for (const links of [normalized.header, normalized.footer[0].links]) {
      expect(links.map(({ external }) => external)).toEqual([false, false, false, false, false, false, true, true]);
    }
    expect(values.header.every(({ external }) => external)).toBe(true);
  });

  it("requires unique ids across columns and links", () => {
    const duplicateLink = clone();
    duplicateLink.footer[1].links.push(link("watch-live"));
    expect(validate(duplicateLink)).toMatch(/footer ids must be unique/);

    const columnLinkClash = clone();
    columnLinkClash.footer[0].links.push(link("about"));
    expect(validate(columnLinkClash)).toMatch(/footer ids must be unique/);

    const badId = clone();
    badId.header[0] = { ...badId.header[0], id: "Not Valid" };
    expect(validate(badId)).toMatch(/id is invalid/);
  });

  it("keeps the contact link and its target, but allows a rename and a move", () => {
    const removed = clone();
    const about = removed.footer.find(({ id }) => id === "about")!;
    about.links = about.links.filter(({ id }) => id !== "contact");
    expect(validate(removed)).toMatch(/footer must keep the contact link/);

    const retargeted = clone();
    const contact = retargeted.footer.find(({ id }) => id === "about")!.links
      .find(({ id }) => id === "contact")!;
    Object.assign(contact, { target: { type: "href", href: "mailto:njpbs@montclair.edu" } });
    expect(validate(retargeted)).toMatch(/link contact cannot change its target/);

    const anchored = clone();
    const anchoredContact = anchored.footer.find(({ id }) => id === "about")!.links
      .find(({ id }) => id === "contact")!;
    Object.assign(anchoredContact, { target: { type: "page", pageId: "contact", hash: "form" } });
    expect(validate(anchored)).toMatch(/link contact cannot change its target/);

    const moved = clone();
    const aboutColumn = moved.footer.find(({ id }) => id === "about")!;
    const movedContact = aboutColumn.links.find(({ id }) => id === "contact")!;
    aboutColumn.links = aboutColumn.links.filter(({ id }) => id !== "contact");
    moved.footer[0].links.unshift({ ...movedContact, label: "Contact us" });
    expect(validate(moved)).toBeNull();
  });

  it("requires at least one header link and one footer column", () => {
    expect(validate({ ...clone(), header: [] })).toMatch(/header must contain at least one link/);
    expect(validate({ ...clone(), footer: [] })).toMatch(/footer must contain at least one column/);
    expect(validate({ header: clone().header })).toMatch(/footer/);
  });
});

describe("site navigation seed and resolver", () => {
  const seed = resolveSiteNavigation(undefined, { postsIndexEnabled: true });

  it("reproduces the layout's committed header", () => {
    expect(seed.header.map(({ label, href, opensInNewTab }) => [label, href, opensInNewTab])).toEqual([
      ["Live", "/live/", false],
      ["Watch on demand", pbsVideoUrl, true],
      ["Schedule", "/schedule/", false],
      ["Posts", "/posts/", false],
      ["NJ Spotlight News", "https://www.njspotlightnews.org/", true],
      ["Kids", "/kids/", false],
      ["Support", "/support/", false],
    ]);
  });

  it("reproduces the layout's committed footer columns", () => {
    expect(seed.footer.map(({ heading, links }) => [
      heading,
      links.map(({ label, href, opensInNewTab }) => [label, href, opensInNewTab]),
    ])).toEqual([
      ["Watch", [
        ["Live", "/live/", false],
        ["Watch on demand", pbsVideoUrl, true],
        ["Schedule", "/schedule/", false],
        ["Kids", "/kids/", false],
      ]],
      ["Passport", [
        ["About Passport", passportLearnMoreUrl, true],
        ["Passport member benefit", passportLearnMoreUrl, true],
        ["PBS Passport help", passportLearnMoreUrl, true],
      ]],
      ["Support", [
        ["Donate", donateUrl, true],
        ["Membership", "/support/", false],
      ]],
      ["About", [
        ["About us", "/about/", false],
        ["FAQ", "/faq/", false],
        ["Contact", "/contact/", false],
        ["Careers", "https://montclair.wd1.myworkdayjobs.com/en-US/JobOpportunities/?q=PBS", true],
      ]],
    ]);
  });

  it("links In the news after About us only when the build has that published page", () => {
    const about = (options: Parameters<typeof resolveSiteNavigation>[1]) =>
      resolveSiteNavigation(undefined, options)
        .footer.find(({ id }) => id === "about")
        ?.links.map(({ label, href }) => [label, href]);
    expect(about({ postsIndexEnabled: true })?.map(([label]) => label)).not.toContain("In the news");
    expect(about({ postsIndexEnabled: true, hasPublishedPath: () => false })?.map(([label]) => label))
      .not.toContain("In the news");
    expect(about({
      postsIndexEnabled: true,
      hasPublishedPath: (path) => path === "/in-the-news/",
    })?.slice(0, 3)).toEqual([
      ["About us", "/about/"],
      ["In the news", "/in-the-news/"],
      ["FAQ", "/faq/"],
    ]);
  });

  it("omits Posts when routed content is off", () => {
    const header = resolveSiteNavigation(undefined, { postsIndexEnabled: false }).header;
    expect(header.map(({ label }) => label)).not.toContain("Posts");
    expect(header).toHaveLength(6);
  });

  it("opens a new tab only for an external http(s) link", () => {
    const values = clone();
    values.header = [
      link("a", { external: true, target: { type: "href", href: "mailto:njpbs@montclair.edu" } }),
      link("b", { external: true, target: { type: "page", pageId: "about" } }),
      link("c", { external: false, target: { type: "href", href: "https://example.org/" } }),
      link("d", { external: true, target: { type: "href", href: "https://example.org/" } }),
    ];
    expect(resolveSiteNavigation(values, { postsIndexEnabled: true }).header
      .map(({ id, opensInNewTab }) => [id, opensInNewTab])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", true],
    ]);
  });

  it("uses the published page path and omits unpublished custom pages", () => {
    const custom = `page-${"a".repeat(32)}`;
    const missing = `page-${"b".repeat(32)}`;
    const values = clone();
    values.header = [
      link("custom", { target: { type: "page", pageId: custom } }),
      link("missing", { target: { type: "page", pageId: missing } }),
      link("renamed", { target: { type: "page", pageId: "about", hash: "team" } }),
      link("unknown", { target: { type: "page", pageId: "not-a-page" } }),
    ];
    const paths = new Map([[custom, "/community/"], ["about", "/about-nj-pbs/"]]);
    const header = resolveSiteNavigation(values, {
      postsIndexEnabled: true,
      pagePath: (pageId) => paths.get(pageId),
    }).header;
    expect(header.map(({ id, href }) => [id, href])).toEqual([
      ["custom", "/community/"],
      ["renamed", "/about-nj-pbs/#team"],
    ]);
  });

  it("renders the seed for invalid values and for an area that resolves empty", () => {
    expect(resolveSiteNavigation({ header: "nope" }, { postsIndexEnabled: true })).toEqual(seed);
    expect(validSiteNavigationValues({ header: [], footer: [] })).toBeNull();

    const onlyUnpublished = clone();
    onlyUnpublished.header = [link("gone", { target: { type: "page", pageId: `page-${"c".repeat(32)}` } })];
    const resolved = resolveSiteNavigation(onlyUnpublished, { postsIndexEnabled: true });
    expect(resolved.header).toEqual(seed.header);
    expect(resolved.footer).toEqual(seed.footer);
  });

  it("drops a footer column whose links all resolve to nothing", () => {
    const values = clone() as { header: SiteNavigationLink[]; footer: SiteNavigationColumn[] };
    values.footer = [
      ...values.footer,
      { id: "posts-only", heading: "Posts", links: [link("posts-link", { target: { type: "route", key: "postsIndex" } })] },
    ];
    const footer = resolveSiteNavigation(values as SiteNavigationSettingsValues, { postsIndexEnabled: false }).footer;
    expect(footer.map(({ id }) => id)).toEqual(["watch", "passport", "support", "about"]);
  });
});
