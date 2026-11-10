import { describe, expect, it } from "vitest";
import {
  NAVIGATION_PREFERENCES_VERSION,
  isDefaultArrangement,
  moveDestination,
  parseNavigationPreferences,
  readNavigationPreferences,
  resolveNavigation,
  setDestinationHidden,
  storedFromResolved,
  visibleNavigation,
  type NavigationPreferences,
  type OrganizableDestination,
} from "../src/lib/navigation-preferences";

// A small catalog stands in for the real rail so the ordering rules are proven on data the test
// owns. `required` marks the destinations an account may never hide.
const CATALOG: OrganizableDestination[] = [
  { id: "home", required: true },
  { id: "pages" },
  { id: "posts" },
  { id: "library" },
  { id: "admin-settings", required: true },
  { id: "media" },
];

function ids(
  rows: ReadonlyArray<{ destination: OrganizableDestination }>,
): string[] {
  return rows.map((row) => row.destination.id);
}

function preferences(
  order: string[],
  hidden: string[] = [],
): NavigationPreferences {
  return { version: NAVIGATION_PREFERENCES_VERSION, order, hidden, custom: [] };
}

describe("navigation preferences: parsing", () => {
  it("treats a missing record as no stored arrangement", () => {
    expect(parseNavigationPreferences(undefined)).toBeNull();
    expect(parseNavigationPreferences(null)).toBeNull();
  });

  it("refuses malformed records rather than half-reading them", () => {
    expect(parseNavigationPreferences("home,pages")).toBeNull();
    expect(parseNavigationPreferences([{ id: "home" }])).toBeNull();
    expect(
      parseNavigationPreferences({ version: NAVIGATION_PREFERENCES_VERSION }),
    ).toBeNull();
    expect(
      parseNavigationPreferences({
        version: NAVIGATION_PREFERENCES_VERSION,
        order: "home",
        hidden: [],
      }),
    ).toBeNull();
  });

  it("refuses a record written by an older or newer schema", () => {
    expect(
      parseNavigationPreferences({ version: 0, order: ["media"], hidden: [] }),
    ).toBeNull();
    expect(
      parseNavigationPreferences({
        version: NAVIGATION_PREFERENCES_VERSION + 1,
        order: ["media"],
        hidden: [],
      }),
    ).toBeNull();
  });

  it.each([
    [[], []],
    [["media"], []],
    [["voiceovers"], []],
    [["media", "voiceovers"], ["media"]],
  ])("migrates v1 library visibility from %j to %j", (hidden, expected) => {
    expect(parseNavigationPreferences({
      version: 1, order: ["posts", "voiceovers", "media"], hidden: [...hidden, "pages"],
    })).toEqual(preferences(["posts", "media"], [...expected, "pages"]));
  });

  it("keeps Media reachable for arrangements saved before Voiceover existed", () => {
    expect(parseNavigationPreferences({
      version: 1, order: ["posts", "media"], hidden: ["media"],
    })).toEqual(preferences(["posts", "media"]));
  });

  it("preserves an explicit hide of the combined Media library in v2", () => {
    expect(parseNavigationPreferences(preferences(["media"], ["media"])))
      .toEqual(preferences(["media"], ["media"]));
  });

  it("repositions Broadcast schedule from a saved pre-move order", () => {
    expect(parseNavigationPreferences({
      version: 2,
      order: [
        "posts",
        "home",
        "schedule",
        "pages",
        "library",
        "media",
        "editorial-queue",
        "activity",
        "staff-profiles",
        "admin-settings",
      ],
      hidden: ["media"],
    })).toEqual(preferences(
      [
        "posts",
        "home",
        "pages",
        "library",
        "media",
        "editorial-queue",
        "activity",
        "schedule",
        "staff-profiles",
        "admin-settings",
      ],
      ["media"],
    ));

    expect(parseNavigationPreferences({
      version: 1,
      order: [
        "posts",
        "voiceovers",
        "home",
        "schedule",
        "pages",
        "media",
        "editorial-queue",
        "activity",
      ],
      hidden: ["pages"],
    })).toEqual(preferences(
      ["posts", "home", "pages", "media", "editorial-queue", "activity", "schedule"],
      ["pages"],
    ));
  });

  it("migrates a stored v2 default order so Broadcast schedule follows Workflow", () => {
    const v2DefaultOrder = [
      "home",
      "schedule",
      "pages",
      "posts",
      "library",
      "media",
      "editorial-queue",
      "activity",
      "staff-profiles",
      "staff-access",
      "analytics",
      "reports",
      "admin-settings",
    ];
    expect(parseNavigationPreferences({
      version: 2,
      order: v2DefaultOrder,
      hidden: ["media"],
    })).toEqual(preferences(
      [
        "home",
        "pages",
        "posts",
        "library",
        "media",
        "editorial-queue",
        "activity",
        "schedule",
        "staff-profiles",
        "staff-access",
        "analytics",
        "reports",
        "admin-settings",
      ],
      ["media"],
    ));
  });

  it("treats a leading Broadcast schedule without Home as the old default slot", () => {
    expect(parseNavigationPreferences({
      version: 2,
      order: ["schedule", "pages", "editorial-queue", "activity", "admin-settings"],
      hidden: [],
    })).toEqual(preferences(
      ["pages", "editorial-queue", "activity", "schedule", "admin-settings"],
    ));
  });

  it("preserves an explicit v2 Broadcast schedule position", () => {
    const customAfterPages = [
      "home",
      "pages",
      "schedule",
      "posts",
      "library",
      "media",
      "editorial-queue",
      "activity",
      "admin-settings",
    ];
    expect(parseNavigationPreferences({
      version: 2,
      order: customAfterPages,
      hidden: ["library"],
    })).toEqual(preferences(customAfterPages, ["library"]));

    const customAtEnd = [
      "home",
      "pages",
      "posts",
      "editorial-queue",
      "activity",
      "admin-settings",
      "schedule",
    ];
    expect(parseNavigationPreferences({
      version: 2,
      order: customAtEnd,
      hidden: [],
    })).toEqual(preferences(customAtEnd));
  });

  it("does not migrate a current-schema arrangement that still has schedule after Home", () => {
    const order = ["home", "schedule", "pages", "editorial-queue", "activity"];
    expect(parseNavigationPreferences({ version: 3, order, hidden: [] }))
      .toEqual(preferences(order));
  });

  it("keeps Broadcast schedule in place when Workflow anchors are absent", () => {
    expect(parseNavigationPreferences({
      version: 2,
      order: [
        "posts",
        "home",
        "schedule",
        "pages",
        "media",
        "admin-settings",
      ],
      hidden: ["media"],
    })).toEqual(preferences(
      [
        "posts",
        "home",
        "schedule",
        "pages",
        "media",
        "admin-settings",
      ],
      ["media"],
    ));
  });

  it("leaves current Broadcast schedule orders in place", () => {
    const order = [
      "home",
      "pages",
      "editorial-queue",
      "activity",
      "schedule",
      "admin-settings",
    ];
    const hidden = ["pages"];
    expect(parseNavigationPreferences({ version: 2, order, hidden }))
      .toEqual(preferences(order, hidden));
    expect(parseNavigationPreferences({ version: 3, order, hidden }))
      .toEqual(preferences(order, hidden));
  });

  it("keeps only string entries and drops duplicates", () => {
    expect(
      parseNavigationPreferences({
        version: NAVIGATION_PREFERENCES_VERSION,
        order: ["media", 7, "media", "pages"],
        hidden: ["pages", null, "pages"],
      }),
    ).toEqual(preferences(["media", "pages"], ["pages"]));
  });

  it("reads the record out of a staff profile document", () => {
    expect(
      readNavigationPreferences({
        preferences: {
          navigation: {
            version: NAVIGATION_PREFERENCES_VERSION,
            order: ["media", "home"],
            hidden: ["posts"],
          },
        },
      }),
    ).toEqual(preferences(["media", "home"], ["posts"]));
    expect(readNavigationPreferences(null)).toBeNull();
    expect(readNavigationPreferences({ preferences: 4 })).toBeNull();
  });
});

describe("navigation preferences: resolution", () => {
  it("falls back to the approved default order when nothing is stored", () => {
    const rows = resolveNavigation(null, CATALOG);
    expect(ids(rows)).toEqual([
      "home",
      "pages",
      "posts",
      "library",
      "admin-settings",
      "media",
    ]);
    expect(rows.every((row) => !row.hidden)).toBe(true);
  });

  it("applies a stored order and hidden set", () => {
    const rows = resolveNavigation(
      preferences(["media", "posts", "home"], ["posts"]),
      CATALOG,
    );
    // The three stored ids keep their stored relative order; the ids this partial record never
    // mentioned land beside their default neighbours.
    expect(ids(rows)).toEqual([
      "media",
      "posts",
      "library",
      "admin-settings",
      "home",
      "pages",
    ]);
    expect(rows.find((row) => row.destination.id === "posts")?.hidden).toBe(
      true,
    );
    expect(visibleNavigation(rows).map((row) => row.destination.id)).not.toContain(
      "posts",
    );
  });

  it("drops a stored id that no longer exists in the catalog", () => {
    const rows = resolveNavigation(
      preferences(["retired-destination", "media"], ["retired-destination"]),
      CATALOG,
    );
    expect(ids(rows)).not.toContain("retired-destination");
    expect(ids(rows)).toEqual([
      "home",
      "pages",
      "posts",
      "library",
      "admin-settings",
      "media",
    ]);
  });

  it("drops a destination the role no longer allows, however it was stored", () => {
    const withoutMedia = CATALOG.filter(
      (destination) => destination.id !== "media",
    );
    const rows = resolveNavigation(
      preferences(["media", "home", "pages"], []),
      withoutMedia,
    );
    expect(ids(rows)).not.toContain("media");
    expect(ids(rows).slice(0, 2)).toEqual(["home", "pages"]);
  });

  it("never hides a required destination, even when the record says to", () => {
    const rows = resolveNavigation(
      preferences(["home", "admin-settings"], ["home", "admin-settings"]),
      CATALOG,
    );
    expect(rows.find((row) => row.destination.id === "home")?.hidden).toBe(false);
    expect(
      rows.find((row) => row.destination.id === "admin-settings")?.hidden,
    ).toBe(false);
    expect(visibleNavigation(rows).map((row) => row.destination.id)).toContain(
      "home",
    );
  });

  it("appends a newly added destination at its default position", () => {
    // The account arranged the rail before "library" and "media" existed.
    const rows = resolveNavigation(
      preferences(["posts", "home", "pages", "admin-settings"]),
      CATALOG,
    );
    // "library" follows "posts" by default, and "media" follows "admin-settings".
    expect(ids(rows)).toEqual([
      "posts",
      "library",
      "home",
      "pages",
      "admin-settings",
      "media",
    ]);
    expect(rows.every((row) => !row.hidden)).toBe(true);
  });

  it("places a new first destination ahead of the stored arrangement", () => {
    const rows = resolveNavigation(preferences(["media", "posts"]), CATALOG);
    expect(ids(rows)[0]).toBe("home");
  });
});

describe("navigation preferences: arranging", () => {
  it("moves a destination one step and refuses to move past either end", () => {
    const rows = resolveNavigation(null, CATALOG);
    expect(ids(moveDestination(rows, "posts", -1))).toEqual([
      "home",
      "posts",
      "pages",
      "library",
      "admin-settings",
      "media",
    ]);
    expect(ids(moveDestination(rows, "home", -1))).toEqual(ids(rows));
    expect(ids(moveDestination(rows, "media", 1))).toEqual(ids(rows));
    expect(ids(moveDestination(rows, "absent", 1))).toEqual(ids(rows));
  });

  it("hides an eligible destination and refuses to hide a required one", () => {
    const rows = resolveNavigation(null, CATALOG);
    const hiddenMedia = setDestinationHidden(rows, "media", true);
    expect(
      hiddenMedia.find((row) => row.destination.id === "media")?.hidden,
    ).toBe(true);
    expect(
      setDestinationHidden(rows, "home", true).find(
        (row) => row.destination.id === "home",
      )?.hidden,
    ).toBe(false);
    expect(
      setDestinationHidden(hiddenMedia, "media", false).find(
        (row) => row.destination.id === "media",
      )?.hidden,
    ).toBe(false);
  });

  it("recognizes the approved default arrangement", () => {
    const rows = resolveNavigation(null, CATALOG);
    expect(isDefaultArrangement(rows, CATALOG)).toBe(true);
    expect(isDefaultArrangement(moveDestination(rows, "media", -1), CATALOG)).toBe(
      false,
    );
    expect(
      isDefaultArrangement(setDestinationHidden(rows, "media", true), CATALOG),
    ).toBe(false);
  });
});

describe("navigation preferences: what gets stored", () => {
  it("writes the current arrangement against the current schema version", () => {
    const rows = setDestinationHidden(
      moveDestination(resolveNavigation(null, CATALOG), "media", -1),
      "media",
      true,
    );
    expect(storedFromResolved(rows, null, CATALOG)).toEqual({
      version: NAVIGATION_PREFERENCES_VERSION,
      custom: [],
      order: ["home", "pages", "posts", "library", "media", "admin-settings"],
      hidden: ["media"],
    });
  });

  it("keeps a catalog destination this role cannot currently reach in place", () => {
    // "media" is in the stored arrangement but outside this session's eligible set.
    const eligible = CATALOG.filter(
      (destination) => destination.id !== "media",
    );
    const stored = preferences(
      ["home", "media", "pages", "posts", "library", "admin-settings"],
      ["media", "posts"],
    );
    const rows = resolveNavigation(stored, eligible);
    const next = storedFromResolved(rows, stored, CATALOG);
    expect(next.order).toEqual([
      "home",
      "media",
      "pages",
      "posts",
      "library",
      "admin-settings",
    ]);
    expect(next.hidden).toEqual(["media", "posts"]);
  });

  it("forgets an id that is no longer in the catalog at all", () => {
    const stored = preferences(["retired", "home"], ["retired"]);
    const rows = resolveNavigation(stored, CATALOG);
    const next = storedFromResolved(rows, stored, CATALOG);
    expect(next.order).not.toContain("retired");
    expect(next.hidden).not.toContain("retired");
  });
});
