import { describe, expect, it } from "vitest";
import contractPkg from "../../functions/lib/content-document-contract.js";
import {
  editorFieldGroupsFor,
} from "../../packages/content-core/src/editor-admin";

const {
  CONTENT_DOCUMENT_CONTRACTS,
  RETIRED_CONTENT_KINDS,
  SERVER_MANAGED_CONTENT_FIELDS,
  unsupportedContentFields,
  validateContentFieldValues,
} = contractPkg;

const RECORD_KINDS = [
  "program",
  "staff",
  "event",
  "sponsor",
  "newsletter",
  "post",
];

const STRUCTURAL_FIELDS = {
  // Page audience classification travels with snapshots without adding an editor control.
  page: { template: "string", pageTheme: "pageTheme", status: "string", publishAt: "publishAt", blocks: "blocks", childDirected: "boolean", homeCompositionVersion: "homeCompositionVersion", serviceCompositionVersion: "serviceCompositionVersion", homeHero: "object", dataHubCompositionVersion: "dataHubCompositionVersion", dataHubReporting: "object" },
  program: { type: "type", status: "string", publishAt: "publishAt" },
  staff: { type: "type", status: "string", publishAt: "publishAt" },
  event: { type: "type", status: "string", publishAt: "publishAt" },
  sponsor: { type: "type", status: "string", publishAt: "publishAt" },
  newsletter: { type: "type", status: "string", publishAt: "publishAt" },
  // Coverage assignment ships in the server layer before the companion Admin choice.
  post: { type: "type", status: "string", publishAt: "publishAt", blocks: "blocks", leadMedia: "leadMedia", liveBlog: "liveBlog", coverageLabelId: "coverageLabelId" },
};

function ruleFor(field) {
  if (field.path?.[0] === "seo" || field.path?.[0] === "social") return "object";
  switch (field.kind) {
    case "richText": return "richText";
    case "toggle": return "boolean";
    case "datetime": return field.key === "publishAt" ? "publishAt" : "instant";
    case "date": return "calendarDate";
    case "list": return "stringList";
    case "text":
    case "url": return field.required ? "text" : "string";
    case "asset": return "assetId";
    case "recordList":
    case "select": return "string";
    case "storyCredits": return "storyCredits";
    default: throw new Error(`Unhandled editor field kind ${field.kind}`);
  }
}

function editorRulesFor(kind, pageId) {
  const rules = {};
  for (const group of editorFieldGroupsFor(kind, pageId)) {
    for (const field of group.fields) {
      const root = field.path?.[0] ?? field.key;
      if (SERVER_MANAGED_CONTENT_FIELDS.includes(root)) continue;
      const rule = ruleFor(field);
      if (rules[root] !== undefined && rules[root] !== rule) {
        throw new Error(`Conflicting rules for ${kind}.${root}`);
      }
      rules[root] = rule;
    }
  }
  return rules;
}

describe("server content document contract", () => {
  it("keeps child-directed classification as a typed, Page-only structural field", () => {
    expect(Object.keys(editorRulesFor("page"))).not.toContain("childDirected");
    for (const childDirected of [true, false]) {
      expect(validateContentFieldValues("cmsPages", "page", {
        title: "Learning", blocks: [], childDirected,
      }, { complete: true })).toBeNull();
    }
    for (const childDirected of ["true", "false", 0, 1, null]) {
      expect(validateContentFieldValues("cmsPages", "page", { childDirected }))
        .toBe("childDirected must be a boolean");
    }
    expect(unsupportedContentFields("cmsPosts", "post", { childDirected: true }))
      .toEqual(["childDirected"]);
  });
  it("accepts only the two page theme values", () => {
    for (const pageTheme of ["default", "nj-decides"]) {
      expect(
        validateContentFieldValues("cmsPages", "page", { pageTheme }),
      ).toBeNull();
    }
    for (const pageTheme of ["election", "NJ-Decides", "", true, null, 2]) {
      expect(
        validateContentFieldValues("cmsPages", "page", { pageTheme }),
      ).toBe("pageTheme must be default or nj-decides");
    }
  });

  it("requires absolute HTTP or HTTPS sponsor links even for drafts", () => {
    for (const href of ["www.acme.org", "mailto:hello@example.org", "tel:+15551234567", "/support/", "https://user:pass@example.org"]) {
      expect(validateContentFieldValues("cmsPosts", "sponsor", { type: "sponsor", name: "NJ Foundation", href }))
        .toMatch(/absolute HTTP or HTTPS/);
    }
    expect(validateContentFieldValues("cmsPosts", "sponsor", { type: "sponsor", name: "NJ Foundation", href: "https://example.org" }))
      .toBeNull();
  });

  // Issue #1039 retired Article. Every write path -- cmsSaveContent, restore, the
  // lifecycle approval gate, and the scheduled publisher -- goes through this
  // validator, so refusing the kind here is what makes the retirement fail closed
  // on the API and not only in the UI.
  it("refuses an article write by name and holds no article contract", () => {
    expect(RETIRED_CONTENT_KINDS.article).toMatch(/retired/i);
    expect(CONTENT_DOCUMENT_CONTRACTS.article).toBeUndefined();
    expect(Object.keys(CONTENT_DOCUMENT_CONTRACTS)).not.toContain("article");

    const document = {
      type: "article",
      title: "Story",
      body: richText("The body."),
    };
    // Creating one, completing one, and re-saving a stored one all fail the same way,
    // and the message names Post rather than reading as a generic validation error.
    for (const options of [undefined, { complete: true }, { validateTypes: false }]) {
      expect(
        validateContentFieldValues("cmsPosts", "article", document, options),
      ).toBe(RETIRED_CONTENT_KINDS.article);
    }
    expect(RETIRED_CONTENT_KINDS.article).toContain("Post");
    // The refusal does not depend on the payload: an empty overlay is refused too.
    expect(validateContentFieldValues("cmsPosts", "article", {})).toBe(
      RETIRED_CONTENT_KINDS.article,
    );
  });

  it("refuses generic Staff writes while retaining its legacy read shape", () => {
    expect(RETIRED_CONTENT_KINDS.staff).toMatch(/retired/i);
    expect(RETIRED_CONTENT_KINDS.staff).toContain("Staff profiles");
    expect(CONTENT_DOCUMENT_CONTRACTS.staff).toBeDefined();
    const document = {
      type: "staff",
      name: "Pat Lee",
      role: "Reporter",
      bio: richText("A legacy biography."),
    };
    for (const options of [undefined, { complete: true }, { validateTypes: false }]) {
      expect(
        validateContentFieldValues("cmsPosts", "staff", document, options),
      ).toBe(RETIRED_CONTENT_KINDS.staff);
    }
  });

  it("keeps every editor-visible root and requirement in the CommonJS server mirror", () => {
    for (const kind of ["page", ...RECORD_KINDS]) {
      const expectedFields = {
        ...editorRulesFor(kind),
        ...(kind === "page" ? editorRulesFor(kind, "home") : {}),
        ...STRUCTURAL_FIELDS[kind],
        ...(kind === "program" ? { keyArt: "string" } : {}),
      };
      const contract = CONTENT_DOCUMENT_CONTRACTS[kind];
      expect(contract.fields, kind).toEqual(expectedFields);

      const expectedRequired = editorFieldGroupsFor(kind).flatMap((group) =>
        group.fields
          .filter((field) => field.required && !field.requiredWhen)
          .map((field) => field.path?.[0] ?? field.key),
      );
      expect(new Set(contract.required)).toEqual(new Set(expectedRequired));
      expect(new Set(contract.structuralRequired)).toEqual(
        new Set(kind === "page" ? ["blocks"] : kind === "post" ? ["type", "tags", "blocks"] : ["type"]),
      );
    }
  });

  it("reports unknown root fields and fields owned by a different record kind", () => {
    expect(
      unsupportedContentFields("cmsPages", "page", {
        title: "Home",
        blocks: [],
        surprise: true,
      }),
    ).toEqual(["surprise"]);
    expect(
      unsupportedContentFields("cmsPosts", "sponsor", {
        type: "sponsor",
        name: "NJ PBS supporter",
        href: "https://example.org",
        title: "Wrong record field",
      }),
    ).toEqual(["title"]);
  });

  it("treats the review request envelope as server-managed rather than client-owned", () => {
    const reviewRequest = {
      requestId: "review_0123456789abcdef",
      collection: "cmsPosts",
      recordId: "story-1",
      state: "in_review",
      sourceVersion: 4,
      requestedBy: "author-1",
      requestedAt: "2026-08-21T14:00:00.000Z",
    };
    expect(SERVER_MANAGED_CONTENT_FIELDS).toContain("reviewRequest");
    expect(
      unsupportedContentFields("cmsPosts", "post", {
        type: "post",
        reviewRequest,
      }),
    ).toEqual([]);
  });

  it("treats the scoped-grant section as server-managed rather than an unknown field", () => {
    // A stored document round-trips through this check, so a server-owned field must not
    // read as unsupported. save.js strips it from the client overlay separately, which is
    // what actually keeps a client from writing it.
    expect(SERVER_MANAGED_CONTENT_FIELDS).toContain("section");
    expect(
      unsupportedContentFields("cmsPosts", "sponsor", {
        type: "sponsor",
        name: "NJ PBS supporter",
        href: "https://example.org",
        section: "support",
      }),
    ).toEqual([]);
    expect(
      unsupportedContentFields("cmsPages", "page", {
        title: "Home",
        blocks: [],
        section: "station",
      }),
    ).toEqual([]);
  });

  it.each([
    ["page", { blocks: [] }, "title"],
    ["program", { type: "program", title: "Show" }, "description"],
    ["event", { type: "event", title: "Forum", description: richText("Details") }, "startsAt"],
    ["sponsor", { type: "sponsor", name: "Supporter" }, "href"],
    ["newsletter", { type: "newsletter", title: "Updates" }, "body"],
    ["post", { type: "post", tags: [], blocks: [] }, "title"],
  ])("requires the complete %s document fields", (kind, document, missing) => {
    const collection = kind === "page" ? "cmsPages" : "cmsPosts";
    expect(
      validateContentFieldValues(collection, kind, document, { complete: true }),
    ).toBe(`${missing} is required`);
  });

  it("allows legacy pages without hero copy and rejects supplied blank copy only when complete", () => {
    const page = { title: "Home", blocks: [] };

    expect(
      validateContentFieldValues("cmsPages", "page", page, { complete: true }),
    ).toBeNull();
    expect(
      validateContentFieldValues("cmsPages", "page", {
        ...page,
        homeHeroTitle: "",
        homeHeroSubtitle: "   ",
      }),
    ).toBeNull();
    expect(
      validateContentFieldValues(
        "cmsPages",
        "page",
        { ...page, homeHeroTitle: "" },
        { complete: true },
      ),
    ).toBe("homeHeroTitle must not be blank");
    expect(
      validateContentFieldValues(
        "cmsPages",
        "page",
        { ...page, homeHeroSubtitle: "   " },
        { complete: true },
      ),
    ).toBe("homeHeroSubtitle must not be blank");
    expect(
      validateContentFieldValues("cmsPages", "page", {
        ...page,
        homeHeroTitle: 42,
      }),
    ).toBe("homeHeroTitle must be a string");
  });

  // A post no longer needs an editorial date to be complete (#1041). Requiring one
  // made the day an editor started a draft the day the post claimed to have
  // published; the display date now comes from the moment publication completed,
  // and the field is filled in only to deliberately backdate a story. Blank still
  // has to be accepted on the way through, and a real day still has to be real.
  it("accepts a complete post with no editorial date, and still refuses a fake one", () => {
    const post = { type: "post", title: "Update", tags: [], blocks: [] };
    expect(validateContentFieldValues("cmsPosts", "post", post, { complete: true })).toBeNull();
    expect(
      validateContentFieldValues("cmsPosts", "post", { ...post, date: "" }, { complete: true }),
    ).toBeNull();
    expect(
      validateContentFieldValues("cmsPosts", "post", { ...post, date: "2026-02-30" }),
    ).toBe("date must be a valid date");
    expect(
      validateContentFieldValues("cmsPosts", "post", { ...post, date: 20260813 }),
    ).toBe("date must be a string");
  });

  it("validates post format markers without requiring draft presentation content", () => {
    expect(
      validateContentFieldValues("cmsPosts", "post", {
        tags: ["format:interactive"],
      }),
    ).toBeNull();
    expect(
      validateContentFieldValues("cmsPosts", "post", {
        tags: ["Environment", "New Jersey"],
      }),
    ).toBeNull();
    expect(
      validateContentFieldValues("cmsPosts", "post", {
        tags: ["format:reader"],
      }),
    ).toBe("Unsupported Post format tag: format:reader.");
    expect(
      validateContentFieldValues("cmsPosts", "post", {
        tags: ["format:interactive", "format:interactive"],
      }),
    ).toBe(
      "A Post may use one branded format tag; found format:interactive, format:interactive.",
    );
    expect(
      validateContentFieldValues(
        "cmsPosts",
        "post",
        { tags: ["format:reader"] },
        { validateTypes: false },
      ),
    ).toBeNull();
  });

  // The publication-date facts the server mints are not editable fields, so a client
  // that sends one is not refused as unknown -- it is stripped and re-applied from
  // trusted server state by the save boundary.
  it("treats the server-minted publication dates as server-managed, not unknown", () => {
    expect(
      unsupportedContentFields("cmsPosts", "post", {
        type: "post",
        title: "Update",
        firstPublishedAt: "2026-08-14T03:30:00.000Z",
        firstPublishedBy: "uid",
        editorialDateSource: "firstPublish",
        meaningfulUpdatedAt: "2026-08-20T14:00:00.000Z",
        meaningfulUpdatedBy: "uid",
      }),
    ).toEqual([]);
  });

  it("requires filled rich text and validates optional field types", () => {
    expect(
      validateContentFieldValues(
        "cmsPosts",
        "newsletter",
        {
          type: "newsletter",
          title: "Weekend brief",
          body: { type: "doc", content: [{ type: "paragraph" }] },
        },
        { complete: true },
      ),
    ).toBe("body is required");
    expect(
      validateContentFieldValues("cmsPosts", "program", { memberOnly: "yes" }),
    ).toBe("memberOnly must be a boolean");
    expect(
      validateContentFieldValues("cmsPosts", "post", {
        heroImage: "https://example.org/lead.jpg",
      }),
    ).toBe("heroImage must be a valid media asset id");
    expect(
      validateContentFieldValues("cmsPosts", "sponsor", {
        logoAssetId: "",
      }),
    ).toBeNull();
  });

  it.each([null,
    { kind: "image", data: { assetId: "new-image", alt: "Current image" } },
    { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "Current video" } },
  ])("uses the explicit lead accessibility instead of inactive legacy fields (%j)", leadMedia => {
    const old = { heroImage: "old-image", heroImageAlt: "Old description", heroImageDecorative: true };
    expect(validateContentFieldValues("cmsPosts", "post", { ...old, leadMedia })).toBeNull();
    expect(validateContentFieldValues("cmsPosts", "post", { ...old,
      leadMedia: { kind: "image", data: { assetId: "new-image", alt: "Invalid decorative description", altDecorative: true } },
    })).not.toBeNull();
  });

  it("allows empty alt text but refuses a described decorative record image", () => {
    expect(
      validateContentFieldValues("cmsPosts", "post", {
        heroImage: "asset-lead",
      }),
    ).toBeNull();
    expect(
      validateContentFieldValues("cmsPosts", "post", {
        heroImage: "asset-lead",
        heroImageAlt: "The NJ PBS newsroom.",
        heroImageDecorative: false,
      }),
    ).toBeNull();
    expect(
      validateContentFieldValues("cmsPosts", "post", {
        heroImage: "asset-lead",
        heroImageAlt: "",
        heroImageDecorative: true,
      }),
    ).toBeNull();
    expect(
      validateContentFieldValues("cmsPosts", "post", {
        heroImage: "asset-lead",
        heroImageAlt: "The NJ PBS newsroom.",
        heroImageDecorative: true,
      }),
    ).toBe("heroImageAlt must be empty when heroImageDecorative is true");
    expect(
      validateContentFieldValues("cmsPosts", "sponsor", {
        logoAssetId: "asset-logo",
        logoAlt: "",
        logoDecorative: false,
      }),
    ).toBeNull();
    expect(
      validateContentFieldValues("cmsPosts", "sponsor", {
        logoAssetId: "asset-logo",
        logoAlt: "",
        logoDecorative: true,
      }),
    ).toBeNull();
    expect(
      validateContentFieldValues("cmsPosts", "sponsor", {
        logoAssetId: "asset-logo",
        logoAlt: "NJ PBS supporter",
        logoDecorative: true,
      }),
    ).toBe("logoAlt must be empty when logoDecorative is true");
  });

  it("checks sponsor labels, description and active dates", () => {
    const sponsor = { type: "sponsor", name: "Acme", href: "https://example.org", tier: "Presenting sponsor", description: "Support for local reporting.", activeFrom: "2026-09-01", activeUntil: "2026-09-30" };
    expect(validateContentFieldValues("cmsPosts", "sponsor", sponsor, { complete: true })).toBeNull();
    expect(validateContentFieldValues("cmsPosts", "sponsor", { ...sponsor, description: "a".repeat(281) })).toMatch(/280/);
    expect(validateContentFieldValues("cmsPosts", "sponsor", { ...sponsor, activeUntil: "2026-08-31" })).toMatch(/activeUntil/);
    expect(validateContentFieldValues("cmsPosts", "sponsor", { ...sponsor, activeFrom: "2026-02-30" })).toMatch(/valid date/);
  });

  it("does not admit a page contract into the record collection", () => {
    expect(
      validateContentFieldValues("cmsPosts", "page", {
        type: "page",
        title: "Wrong collection",
        blocks: [],
      }),
    ).toBe("Unknown content type page");
  });

  it("requires secure newsletter signup links and consistent image alt text", () => {
    const newsletter = { type: "newsletter", title: "Weekly", body: richText("Updates"), signupUrl: "https://example.org/join" };
    expect(validateContentFieldValues("cmsPosts", "newsletter", newsletter, { complete: true })).toBeNull();
    expect(validateContentFieldValues("cmsPosts", "newsletter", { ...newsletter, signupUrl: "http://example.org/join" })).toBe("signupUrl must be an HTTPS link");
    expect(validateContentFieldValues("cmsPosts", "newsletter", { ...newsletter, imageAssetId: "asset-1", imageAlt: "Photo", imageDecorative: true })).toBe("imageAlt must be empty when imageDecorative is true");
  });

  it.each(["constructor", "toString", "__proto__"])(
    "rejects the inherited content type %s without throwing",
    (kind) => {
      expect(
        validateContentFieldValues("cmsPosts", kind, { type: kind }),
      ).toBe(`Unknown content type ${kind}`);
      expect(
        unsupportedContentFields("cmsPosts", kind, { type: kind }),
      ).toEqual([]);
    },
  );

  it("returns a validation error for a non-object document", () => {
    expect(validateContentFieldValues("cmsPages", "page", null)).toBe(
      "document must be an object",
    );
    expect(validateContentFieldValues("cmsPosts", "post", [])).toBe(
      "document must be an object",
    );
  });
});

function richText(text) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}
