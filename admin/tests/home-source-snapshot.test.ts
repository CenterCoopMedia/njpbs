import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadHomeSourceSnapshot,
  readHomeSourceSnapshot,
  readHomeSourceResponse,
} from "../src/lib/home-source-snapshot";
import savedHome from "../../site/tests/fixtures/home-v2-selections.json";

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const source = {
  schemaVersion: 1,
  publication: {
    buildBatchId: "home-2026-09-05",
    generation: 7,
    commitSha,
  },
  pbs: {
    source: "media-manager",
    checkedAt: "2026-09-05T13:00:00.000Z",
    featured: [
      {
        title: "State of the Arts",
        description: "A New Jersey arts program",
        href: "/watch/state-of-the-arts",
        image: "https://image.pbs.org/state-of-the-arts.jpg",
      },
    ],
    more: [],
  },
  spotlight: {
    source: "spotlight-rss",
    checkedAt: "2026-09-05T13:05:00.000Z",
    cards: [
      {
        title: "New Jersey policy update",
        category: "Politics",
        dateLabel: "September 5, 2026",
        href: "https://www.njspotlightnews.org/policy-update/",
        image: "/brand/spotlight/politics.jpg",
      },
    ],
  },
};
const publication = {
  schemaVersion: 1,
  ...source.publication,
  publishedAt: "2026-09-05T13:10:00.000Z",
};

function response(body: string, ok = true): Response {
  return { ok, headers: new Headers(), text: async () => body } as Response;
}

beforeEach(() => { vi.stubEnv("DEV", false); vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "njpbs-site"); });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Home source snapshot reader", () => {
  it.each(["https://tracker.example/pixel.png", "http://127.0.0.1/pixel.png", "https://image.pbs.org.evil.example/pixel.png"])(
    "drops untrusted feed artwork without losing the card: %s", (image) => {
      const parsed = readHomeSourceSnapshot({ ...source, pbs: { ...source.pbs,
        featured: [{ ...source.pbs.featured[0], image }], more: [{ ...source.pbs.featured[0], image }],
      } }, publication);
      for (const card of [...parsed.pbs.featured, ...parsed.pbs.more]) {
        expect(card.title).toBe("State of the Arts");
        expect(card.href).toBe("/watch/state-of-the-arts");
        expect(card.image).toBeUndefined();
      }
    },
  );

  it.each(["https://image.pbs.org/program.jpg", "https://media.njpbs.org/cms-media/program/image.jpg", "/brand/program.jpg"])(
    "retains trusted feed artwork: %s", (image) => {
      const parsed = readHomeSourceSnapshot({ ...source, pbs: { ...source.pbs,
        featured: [{ ...source.pbs.featured[0], image }],
      } }, publication);
      expect(parsed.pbs.featured[0].image).toBe(image);
    },
  );
  it("loads a Page operation catalog against current code and refuses incomplete or mismatched Page receipts", () => {
    const operationId = "HOMEpageoperation001";
    const page = { ...source, publication: { buildBatchId: operationId, generation: 21, commitSha },
      editorial: { ...savedHome.editorial, receipt: { ...savedHome.editorial.receipt, buildBatchId: operationId, commitSha } } };
    const headers = new Headers({ "X-Njpbs-Content-Source": "cms-page-no-build", "X-Njpbs-Publication-Operation": operationId,
      "X-Njpbs-Renderer-Sha": commitSha, "X-Njpbs-Context-Sha256": "b".repeat(64), "X-Njpbs-Snapshot-Sha256": "c".repeat(64),
      "X-Njpbs-Source-Version": "7", "X-Njpbs-Admission-Revision": "1", "X-Njpbs-Home-Refresh-Revision": "3" });
    expect(readHomeSourceResponse(page, publication, headers).editorial?.receipt.buildBatchId).toBe(operationId);
    for (const name of headers.keys()) {
      const incomplete = new Headers(headers); incomplete.delete(name);
      expect(() => readHomeSourceResponse(page, publication, incomplete)).toThrow(/catalog changed/);
    }
    const wrong = new Headers(headers); wrong.set("X-Njpbs-Publication-Operation", "HOMEpageoperation002");
    expect(() => readHomeSourceResponse(page, publication, wrong)).toThrow(/catalog changed/);
    expect(() => readHomeSourceResponse(page, { ...publication, commitSha: "f".repeat(40) }, headers)).toThrow(/catalog changed/);
    expect(() => readHomeSourceResponse(page, { ...publication, generation: 22 }, headers)).toThrow(/catalog changed/);
  });
  it("admits a current immutable Home generation against the active code receipt, without equating full-build generations", () => {
    const fast = { ...source, publication: { buildBatchId: savedHome.editorial.receipt.buildBatchId, generation: 21, commitSha },
      editorial: { ...savedHome.editorial, receipt: { ...savedHome.editorial.receipt, commitSha } } };
    const headers = new Headers({ "X-Njpbs-Background-State": "current", "X-Njpbs-Background-Renderer-Sha": commitSha,
      "X-Njpbs-Background-Context-Sha256": "b".repeat(64), "X-Njpbs-Background-Revision": "2" });
    expect(readHomeSourceResponse(fast, publication, headers).publication?.generation).toBe(21);
    for (const [name, value] of [["X-Njpbs-Background-State", "stale"], ["X-Njpbs-Background-Renderer-Sha", "a".repeat(40)],
      ["X-Njpbs-Background-Context-Sha256", ""], ["X-Njpbs-Background-Revision", "0"]]) {
      const invalid = new Headers(headers); invalid.set(name, value);
      expect(() => readHomeSourceResponse(fast, publication, invalid)).toThrow(/catalog changed/);
    }
    const partial = new Headers({ "X-Njpbs-Background-State": "current" });
    expect(() => readHomeSourceResponse(fast, publication, partial)).toThrow(/catalog changed/);
    expect(() => readHomeSourceResponse(fast, { ...publication, commitSha: "c".repeat(40) }, headers)).toThrow(/catalog changed/);
    expect(() => readHomeSourceResponse(fast, publication, new Headers())).toThrow(/receipts do not match/);
  });
  it("keeps shelf cards available when the independent hero catalog is invalid", () => {
    const snapshot = readHomeSourceSnapshot({ ...source, heroCatalog: [{ title: "x".repeat(301) }] }, publication);
    expect(snapshot.pbs.featured).toEqual(source.pbs.featured);
    expect(snapshot.spotlight.cards).toEqual(source.spotlight.cards);
    expect(snapshot.heroCatalog).toBeUndefined();
  });

  it("keeps the checked times separate from the matching publication identity", () => {
    expect(readHomeSourceSnapshot(source, publication)).toEqual({
      schemaVersion: 1,
      publication: source.publication,
      pbs: source.pbs,
      spotlight: source.spotlight,
    });
  });

  it.each([
    [{ ...source, schemaVersion: 2 }, publication],
    [source, { ...publication, schemaVersion: 2 }],
    [{ ...source, publication: null }, publication],
    [source, null],
    [
      {
        ...source,
        publication: { ...source.publication, buildBatchId: "another-batch" },
      },
      publication,
    ],
    [source, { ...publication, generation: 8 }],
    [source, { ...publication, commitSha: "f".repeat(40) }],
  ])(
    "rejects a missing, mixed, or non-schema-1 publication receipt",
    (value, receipt) => {
      expect(() => readHomeSourceSnapshot(value, receipt)).toThrow(
        "source and publication receipts do not match",
      );
    },
  );

  it("accepts the 8/16/8 card bounds and rejects each larger list", () => {
    const bounded = {
      ...source,
      pbs: {
        ...source.pbs,
        featured: Array.from({ length: 8 }, () => source.pbs.featured[0]),
        more: Array.from({ length: 16 }, () => source.pbs.featured[0]),
      },
      spotlight: {
        ...source.spotlight,
        cards: Array.from({ length: 8 }, () => source.spotlight.cards[0]),
      },
    };

    expect(readHomeSourceSnapshot(bounded, publication).pbs.more).toHaveLength(16);

    for (const tooLarge of [
      {
        ...bounded,
        pbs: {
          ...bounded.pbs,
          featured: [...bounded.pbs.featured, source.pbs.featured[0]],
        },
      },
      {
        ...bounded,
        pbs: { ...bounded.pbs, more: [...bounded.pbs.more, source.pbs.featured[0]] },
      },
      {
        ...bounded,
        spotlight: {
          ...bounded.spotlight,
          cards: [...bounded.spotlight.cards, source.spotlight.cards[0]],
        },
      },
    ]) {
      expect(() => readHomeSourceSnapshot(tooLarge, publication)).toThrow(
        "card list is invalid",
      );
    }
  });

  it.each(["javascript:alert(1)", "//attacker.example/card", "data:text/html,bad"])(
    "rejects the unsafe card link %s",
    (href) => {
      expect(() =>
        readHomeSourceSnapshot(
          {
            ...source,
            pbs: {
              ...source.pbs,
              featured: [{ ...source.pbs.featured[0], href }],
            },
          },
          publication,
        ),
      ).toThrow("invalid link");
    },
  );

  it("drops fields outside the source contract", () => {
    const parsed = readHomeSourceSnapshot(
      {
        ...source,
        ignoredRoot: true,
        publication: { ...source.publication, ignoredReceiptField: true },
        pbs: {
          ...source.pbs,
          ignoredPbsField: true,
          featured: [{ ...source.pbs.featured[0], ignoredCardField: true }],
        },
        spotlight: {
          ...source.spotlight,
          ignoredSpotlightField: true,
          cards: [{ ...source.spotlight.cards[0], ignoredCardField: true }],
        },
      },
      { ...publication, ignoredPublicationField: true },
    );

    expect(parsed).toEqual({
      schemaVersion: 1,
      publication: source.publication,
      pbs: source.pbs,
      spotlight: source.spotlight,
    });
  });

  it("accepts empty source card arrays", () => {
    const parsed = readHomeSourceSnapshot(
      {
        ...source,
        pbs: { ...source.pbs, featured: [], more: [] },
        spotlight: { ...source.spotlight, cards: [] },
      },
      publication,
    );

    expect(parsed.pbs.featured).toEqual([]);
    expect(parsed.pbs.more).toEqual([]);
    expect(parsed.spotlight.cards).toEqual([]);
  });
});

describe("Home source snapshot loader", () => {
  it("fetches only the two public files without credentials or caching", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      response(
        JSON.stringify(
          String(input).includes("_home-sources.json") ? source : publication,
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadHomeSourceSnapshot(signal)).resolves.toMatchObject({
      publication: source.publication,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls).toEqual([
      ["https://njpbs.org/_home-sources.json?cms-home=rs&cms-context=home", {
        signal,
        credentials: "omit",
        cache: "no-store",
      }],
      ["https://njpbs.org/_publication.json?cms-home=rs&cms-context=code", {
        signal,
        credentials: "omit",
        cache: "no-store",
      }],
    ]);
  });

  it.each([
    ["a non-200 response", response("Unavailable", false)],
    ["malformed JSON", response("{")],
    ["an oversized response", response("x".repeat(500_001))],
  ])("rejects %s", async (_case, badResponse) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("_home-sources.json")
        ? badResponse
        : response(JSON.stringify(publication)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadHomeSourceSnapshot(new AbortController().signal),
    ).rejects.toThrow();
  });
});

describe("Home source environment boundary", () => {
  it.each([undefined, "njpbs-site-typo", "demo-njpbs"])("refuses an unknown build project %s before fetching source data", async (project) => {
    const { homeSourceOrigin } = await import("../src/lib/home-source-snapshot");
    for (const origin of [undefined, "https://njpbs.org", "https://dev-public.example.org"]) {
      expect(() => homeSourceOrigin({ VITE_FIREBASE_PROJECT_ID: project, VITE_PUBLIC_SITE_ORIGIN: origin })).toThrow(/not recognized/);
    }
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", project);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadHomeSourceSnapshot(new AbortController().signal)).rejects.toThrow(/not recognized/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses missing and production origins in the dev Firebase workspace", async () => {
    const { homeSourceOrigin } = await import("../src/lib/home-source-snapshot");
    expect(() => homeSourceOrigin({ VITE_FIREBASE_PROJECT_ID: "njpbs-site-dev" })).toThrow(/not configured/);
    expect(() => homeSourceOrigin({ VITE_FIREBASE_PROJECT_ID: "njpbs-site-dev", VITE_PUBLIC_SITE_ORIGIN: "https://njpbs.org" })).toThrow(/does not match/);
    expect(homeSourceOrigin({ VITE_FIREBASE_PROJECT_ID: "njpbs-site-dev", VITE_PUBLIC_SITE_ORIGIN: "https://dev-public.example.org" })).toBe("https://dev-public.example.org");
    expect(homeSourceOrigin({ VITE_FIREBASE_PROJECT_ID: "njpbs-site" })).toBe("https://njpbs.org");
  });
});
