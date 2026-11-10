import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/shadow-posts/post.json";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { renderRecordCards } from "../src/lib/cms-render-context";
import { resolveRecordCard } from "../src/lib/record-card-resolution";
import { renderBlock } from "../../packages/content-core/src/content-render";

const now = new Date("2026-10-07T13:00:00Z");
const rendererSha = "a".repeat(40);
const synopsis = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A weekly look at law and policy." }] }] };

function program(id: string, title: string, publiclyVisible = true) {
  return {
    id, status: "published", publiclyVisible, deleted: false, publishAt: "2026-08-20T14:00:00.000Z",
    published: {
      sourceVersion: 4, publishedAt: "2026-08-20T14:00:00.000Z", blocks: [],
      metadata: { type: "program", title, description: synopsis, slug: id, previousSlugs: [], locale: "en" },
    },
  };
}

const sponsor = {
  id: "sponsor-one", type: "sponsor", status: "draft", publiclyVisible: false, deleted: false, version: 8,
  name: "Draft sponsor", href: "https://draft.example.test/",
  approvedLibraryVersion: {
    status: "approved", type: "sponsor", deleted: false, version: 3, name: "Approved sponsor",
    href: "https://public.example.test/", logoAssetId: "public-logo", logoAlt: "Approved logo", activeUntil: "2026-12-01",
  },
};
const newsletter = {
  id: "news-one", type: "newsletter", status: "in_review", publiclyVisible: false, deleted: false, version: 9,
  title: "Draft newsletter", signupUrl: "https://draft.example.test/join",
  approvedLibraryVersion: {
    status: "approved", type: "newsletter", deleted: false, version: 4, title: "Approved newsletter",
    signupUrl: "https://public.example.test/join", summary: "Approved summary",
  },
};
const event = {
  id: "event-one", status: "published", publiclyVisible: true, deleted: false, publishAt: "2026-08-20T14:00:00.000Z",
  published: {
    sourceVersion: 2, publishedAt: "2026-08-20T14:00:00.000Z", blocks: [],
    metadata: {
      type: "event", title: "Newsroom night", slug: "newsroom-night", previousSlugs: [], locale: "en",
      description: synopsis, startsAt: "2026-10-01T18:00:00.000Z", isFree: true,
    },
  },
};

function joinedRead() {
  const read = structuredClone(fixture) as any;
  read.document.published.blocks.push(
    { id: "program", type: "record_card", visible: true, order: 1, data: { recordKind: "program", recordId: "prog-one", variant: "card" } },
    { id: "event", type: "record_card", visible: true, order: 2, data: { recordKind: "event", recordId: "event-one" } },
    { id: "sponsor", type: "record_card", visible: true, order: 3, data: { recordKind: "sponsor", recordId: "sponsor-one" } },
    { id: "newsletter", type: "record_card", visible: true, order: 4, data: { recordKind: "newsletter", recordId: "news-one" } },
    { id: "missing", type: "record_card", visible: true, order: 5, data: { recordKind: "program", recordId: "missing-program" } },
    { id: "strip", type: "sponsor_strip", visible: true, order: 6, data: { sponsorIds: ["sponsor-one"], layout: "row", heading: "Sponsors" } },
    { id: "signup", type: "newsletter_signup", visible: true, order: 7, data: { newsletterIds: ["news-one"], heading: "Newsletters", intro: "Join" } },
  );
  read.joinedRecords = [program("prog-one", "Due Process"), program("draft-program", "Draft program", false), sponsor, newsletter, event, { id: "staff-one", type: "staff", name: "Private staff" }];
  read.assets = [{ id: "public-logo", url: "https://media.example.test/public-logo.png", mimeType: "image/png", width: 640, height: 360 }];
  return read;
}

describe("joined record projection and render", () => {
  it("fills current public cards and omits a missing, draft or unrelated record", () => {
    const content = projectPublishedPostRead(joinedRead(), "shadow-fixture", rendererSha, now)!;
    expect(content.programs.map(item => item.title)).toEqual(["Due Process"]);
    expect(content.events?.map(item => item.title)).toEqual(["Newsroom night"]);
    expect(content.recordCards.map(card => `${card.kind}:${card.id}:${card.title}`)).toEqual([
      "program:prog-one:Due Process",
      "event:event-one:Newsroom night",
      "sponsor:sponsor-one:Approved sponsor",
      "newsletter:news-one:Approved newsletter",
    ]);
    expect(JSON.stringify(content.recordCards)).not.toMatch(/Draft sponsor|Draft newsletter|Draft program|Private staff|missing-program/);
    const programBlock = { data: { recordKind: "program" as const, recordId: "prog-one", variant: "card" as const } };
    expect(renderBlock({ id: "program", type: "record_card", visible: true, order: 1, data: programBlock.data }, {})).toBe("");
    expect(resolveRecordCard(programBlock, content.recordCards)?.title).toBe("Due Process");
    expect(resolveRecordCard({ data: { recordKind: "program", recordId: "missing-program" } }, content.recordCards)).toBeNull();
  });

  it("projects program key art when the joined read includes the asset", () => {
    const read = joinedRead();
    const program = read.joinedRecords.find((record: { id: string }) => record.id === "prog-one");
    program.published.metadata.keyArtAssetId = "program-art";
    read.assets.push({ id: "program-art", url: "https://media.njpbs.org/cms-media/program-art.png", mimeType: "image/png", width: 640, height: 360 });
    const content = projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)!;
    expect(content.programs[0].keyArt?.url).toBe("https://media.njpbs.org/cms-media/program-art.png");
    const missing = joinedRead();
    missing.joinedRecords.find((record: { id: string }) => record.id === "prog-one").published.metadata.keyArtAssetId = "program-art";
    expect(() => projectPublishedPostRead(missing, "shadow-fixture", rendererSha, now)).toThrow("missing media asset program-art");
  });

  it("still refuses a block type outside the editor's Post catalog by name", () => {
    const read = structuredClone(fixture) as any;
    read.document.published.blocks.push({ id: "coverage", type: "coverage_list", visible: true, order: 1, data: { entries: [] } });
    expect(() => projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)).toThrow("Post block type coverage_list is outside the Post template");
  });

  it("uses projected cards on a compiled Post and the collection on a full build", () => {
    const content = projectPublishedPostRead(joinedRead(), "shadow-fixture", rendererSha, now)!;
    const collected = [{ kind: "program" as const, id: "other", title: "Collection card", href: "/programs/other/" }];
    expect(renderRecordCards({ content, homeSources: { sections: [] } } as never, collected)).toBe(content.recordCards);
    expect(renderRecordCards(undefined, collected)).toBe(collected);
    for (const file of ["PostPage.astro", "PostBlockList.astro"]) {
      const source = readFileSync(path.join(process.cwd(), "src/components", file), "utf8");
      expect(source).toContain("renderRecordCards(Astro.locals.cmsRender");
      expect(source.indexOf("renderRecordCards")).toBeLessThan(source.indexOf('getCollection("cmsRecordCards")'));
    }
  });
});
