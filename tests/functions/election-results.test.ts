import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { isElectionResultsData, electionRaceError } from "../../packages/content-core/src/election-results";
import { electionPartyTone, renderElectionResults } from "../../packages/content-core/src/election-results-render";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { electionRace, electionBlock } from "../fixtures/election-results";

const require = createRequire(import.meta.url);
const approvals = require("../../functions/lib/election-results-approval.js");
const snapshots = require("../../functions/lib/publish-snapshot.js");
const serverBlocks = require("../../functions/lib/content-blocks.js");
const publicProjection = require("../../functions/lib/public-content-projection.js");
const compatibility = require("../../functions/lib/election-results-compatibility.js");
const media = require("../../functions/lib/media-usage.js");
const actor = { uid: "editor-a", displayName: "Editor A" };
const time = "2026-11-04T02:16:00.000Z";
function source(collection = "cmsPages") {
  return { id: collection === "cmsPages" ? "contact" : "election-story", title: "Election results", type: "post", status: "approved",
    version: 3, contentVersion: 2, date: "2026-11-03", tags: [], slug: "election-story", previousSlugs: [], locale: "en", blocks: [electionBlock()] };
}
function freeze(document: ReturnType<typeof source> & { electionResultsApprovals?: unknown }, collection = "cmsPages") {
  return snapshots.createPublishedSnapshot({ collection, document, publishedAt: time, publishedBy: actor.uid });
}

describe("Election race input boundary", () => {
  it("shares the exact Page/Post block contract with Functions", () => {
    expect(parseBlocks([electionBlock()]).ok).toBe(true);
    expect(serverBlocks.parseBlocks([electionBlock()])).toEqual(parseBlocks([electionBlock()]));
    expect(isElectionResultsData({ races: [electionRace()] }, true)).toBe(true);
    expect(isElectionResultsData({ races: [] }, false)).toBe(true);
    expect(isElectionResultsData({ races: [] }, true)).toBe(false);
  });
  it.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "123"])("refuses an invalid vote total %s", votes => {
    const race = electionRace(); race.candidates[0].votes = votes as number;
    expect(electionRaceError(race)).toMatch(/whole number/);
    expect(parseBlocks([electionBlock(race)], { complete: false }).ok).toBe(false);
  });
  it("refuses bad percentages, duplicated candidates and unknown fields during draft save", () => {
    const race = electionRace(); race.candidates[0].share = 105;
    expect(electionRaceError(race)).toMatch(/between 0 and 100/);
    race.candidates[0].share = 99;
    expect(electionRaceError(race)).toMatch(/total more than/);
    race.candidates[0].share = 62; race.candidates[1].id = race.candidates[0].id;
    expect(electionRaceError(race)).toMatch(/unique/);
    expect(isElectionResultsData({ races: [electionRace()], approved: true })).toBe(false);
  });
  it.each(["http://results.example.test/", "https://user:password@results.example.test/", "javascript:alert(1)"])("refuses unsafe sources", sourceUrl => {
    expect(electionRaceError(electionRace({ sourceUrl }))).toMatch(/HTTPS/);
  });
  it.each(["2026-02-30T12:00:00Z", "2026-11-03T21:15:00", "2026-11-03T24:00:00Z", "not-a-date"])("requires a real zoned as-of time", asOf => {
    expect(electionRaceError(electionRace({ asOf }))).toMatch(/date and time/);
  });
  it("keeps unknown numbers distinct from zero and never projects an official-source race", () => {
    const race = electionRace({ status: "awaiting", candidates: electionRace().candidates.map(candidate => ({ ...candidate, votes: null, share: null })) });
    expect(electionRaceError(race, true)).toBeNull();
    expect(electionRaceError(electionRace({ status: "called", calledCandidateId: "ellis", apCallUrl: "https://apnews.com/example" }), true)).toMatch(/AP source/);
    expect(electionRaceError(electionRace({ status: "certified", sourceKind: "ap" }), true)).toMatch(/official source/);
  });
  it("requires AP call attribution and a candidate in that race", () => {
    const race = electionRace({ status: "called", sourceKind: "ap", calledCandidateId: "ellis", apCallUrl: "https://apnews.com/example" });
    expect(electionRaceError(race, true)).toBeNull();
    expect(electionRaceError({ ...race, calledCandidateId: "someone-else" }, true)).toMatch(/called candidate/);
    expect(electionRaceError({ ...race, apCallUrl: undefined }, true)).toMatch(/link/);
  });
});

describe("Frozen race approval", () => {
  it("refuses a source time later than the server approval time", () => {
    expect(() => approvals.approveElectionResults(source(), actor, "2026-11-04T01:00:00Z")).toThrow(/future/);
  });
  it.each(["cmsPages", "cmsPosts"])("admits only the exact approved race on %s", collection => {
    const document = source(collection);
    expect(() => freeze(document, collection)).toThrow(snapshots.PublishSnapshotError);
    expect(() => freeze(document, collection)).toThrow(/approve/);
    const approved = { ...document, electionResultsApprovals: approvals.approveElectionResults(document, actor, time) };
    const published = freeze(approved, collection);
    expect(published.blocks[0].data.races).toEqual([electionRace()]);
    expect(JSON.stringify(published)).not.toContain("electionResultsApprovals");
    expect(JSON.stringify(published)).not.toContain("Editor A");
    approved.blocks[0].data.races[0].candidates[0].votes = 700;
    expect(() => freeze(approved, collection)).toThrow(/approve/);
    expect(published.blocks[0].data.races[0].candidates[0].votes).toBe(620);
  });
  it("records each approved status change with actor, time and revision", () => {
    const document = { ...source(), electionResultsApprovals: [] };
    const first = approvals.approveElectionResults(document, actor, time);
    expect(first[0]).toMatchObject({ revision: 1, approvedAt: time, approvedBy: actor, status: "counting" });
    const next = { ...document, electionResultsApprovals: first };
    expect(approvals.approveElectionResults(next, actor, time)[0].revision).toBe(1);
    next.blocks = [electionBlock(electionRace({ status: "official" }))];
    const secondActor = { uid: "editor-b", displayName: "Editor B" };
    const second = approvals.approveElectionResults(next, secondActor, "2026-11-04T03:00:00Z");
    expect(second[0].statusHistory).toEqual([
      { revision: 1, status: "counting", approvedAt: time, approvedBy: actor },
      { revision: 2, status: "official", approvedAt: "2026-11-04T03:00:00Z", approvedBy: secondActor },
    ]);
    expect(first[0].race.status).toBe("counting");
  });
  it("omits hidden unapproved race data and permits private draft previews", () => {
    const document = source(); document.blocks[0].visible = false;
    expect(freeze(document).blocks).toEqual([]);
    document.blocks[0].visible = true;
    const preview = snapshots.createPublishedSnapshot({ collection: "cmsPages", document, publishedAt: time, publishedBy: actor.uid, allowIncompletePresentation: true });
    expect(preview.blocks[0].data.races[0].candidates[0].votes).toBe(620);
  });
  it("preserves unrelated blocks and their existing order", () => {
    const blocks = [{ id: "prose", order: 4, visible: true, type: "prose", data: { content: { type: "doc", content: [] } } }];
    expect(approvals.approvedElectionBlocks({ blocks })).toBe(blocks);
  });
});

describe("Public election results", () => {
  it("renders a source, Eastern as-of time, reporting share and independent table", () => {
    const html = renderBlock(electionBlock());
    expect(html).toContain("75.5% reporting");
    expect(html).toContain("Nov 3, 2026 · 9:15 PM ET");
    expect(html).toContain('href="https://results.example.test/election"');
    expect(html).toContain('<th scope="row">Jordan Ellis (Leading)</th>');
    expect(html).toContain('election-results__candidate--neutral');
    expect(html).not.toContain("AP called this race");
    expect(publicProjection.selectedBlock(electionBlock()).data).toEqual(electionBlock().data);
  });
  it("renders explicit expected vote fractions without relabeling legacy reporting data", () => {
    const race = electionRace({ expectedVoteShare: 0.85, reportingShare: 100 });
    const html = renderElectionResults("race", { races: [race] });
    expect(html).toContain("Est. 85% of expected vote counted");
    expect(html).not.toContain("100% reporting");
    expect(renderElectionResults("race", { races: [electionRace({ expectedVoteShare: 0 })] })).toContain("Est. 0% of expected vote counted");
    expect(renderElectionResults("race", { races: [electionRace({ expectedVoteShare: 1 })] })).toContain("Est. 100% of expected vote counted");
    expect(renderElectionResults("race", { races: [electionRace({ reportingShare: 100 })] })).toContain("100% reporting");
    expect(renderElectionResults("race", { races: [electionRace({ reportingShare: null })] })).toContain("Reporting share unavailable");
    for (const value of [-0.01, 1.01, NaN, Infinity, null, "0.85"]) {
      const invalid = electionRace({ expectedVoteShare: value as number });
      expect(isElectionResultsData({ races: [invalid] }, true)).toBe(false);
      expect(serverBlocks.parseBlocks([electionBlock(invalid)]).ok).toBe(false);
      expect(renderElectionResults("race", { races: [invalid] })).toContain("Election results are not available");
    }
  });
  it("requires reader version 2 only for snapshots with an expected vote field", () => {
    for (const value of [0, 0.85, 1]) {
      const document = { blocks: [electionBlock(electionRace({ expectedVoteShare: value }))] };
      expect(compatibility.requiredElectionResultsVersion(document)).toBe(2);
      expect(compatibility.candidateSupportsOwnedElectionResults({ visible: true }, document, { electionResultsVersion: 1 })).toBe(false);
      expect(compatibility.candidateSupportsOwnedElectionResults({ visible: true }, document, { electionResultsVersion: 2 })).toBe(true);
      expect(compatibility.supportsElectionResults(document, { electionResultsVersion: 3 })).toBe(false);
    }
    expect(compatibility.supportsElectionResults({ blocks: [electionBlock()] }, { electionResultsVersion: 2 })).toBe(true);
  });
  it("marks only a unique positive uncalled leader and mirrors it in the table", () => {
    const html = renderElectionResults("race", { races: [electionRace()] });
    expect(html.match(/class="election-results__leading"/g)).toHaveLength(1);
    expect(html).toContain("Jordan Ellis (Leading)");
    expect(html).toContain("width:62%");
    for (const counts of [[0, 0], [500, 500]]) {
      const race = electionRace();
      race.candidates = race.candidates.map((candidate, index) => ({ ...candidate, votes: counts[index], share: counts[index] === 0 ? 0 : 50 }));
      expect(renderElectionResults("race", { races: [race] })).not.toContain('class="election-results__leading"');
    }
    const called = electionRace({ status: "called", sourceKind: "ap", calledCandidateId: "ellis", apCallUrl: "https://apnews.com/example" });
    expect(renderElectionResults("race", { races: [called] })).not.toContain('class="election-results__leading"');
  });
  it("never substitutes unknown values with zero or adds incomplete candidate counts", () => {
    const race = electionRace();
    race.status = "awaiting";
    race.candidates = race.candidates.map(candidate => ({ ...candidate, votes: null, share: null }));
    const html = renderElectionResults("race", { races: [race] });
    expect(html).toContain('class="election-results__total-value"><span class="election-results__not-reported"');
    expect(html).toContain('class="election-results__share election-results__share--unknown"><span class="election-results__not-reported"');
    expect(html).not.toContain('class="election-results__bar"');
    expect(html).not.toContain('class="election-results__leading"');
    const zero = electionRace();
    zero.candidates = zero.candidates.map(candidate => ({ ...candidate, votes: 0, share: 0 }));
    const zeroHtml = renderElectionResults("race", { races: [zero] });
    expect(zeroHtml).toContain('class="election-results__total-value">0');
    expect(zeroHtml).toContain("0 votes");
    expect(zeroHtml).toContain("width:0%");
    expect(zeroHtml).not.toContain('class="election-results__leading"');
    const partial = electionRace(); partial.candidates[0].votes = null;
    expect(renderElectionResults("race", { races: [partial] })).toContain("Election results are not available.");
  });
  it("keeps total counts exact beyond the safe range of a combined Number", () => {
    const race = electionRace();
    race.candidates = race.candidates.map(candidate => ({ ...candidate, votes: Number.MAX_SAFE_INTEGER }));
    expect(renderElectionResults("race", { races: [race] })).toContain("18,014,398,509,481,982");
  });
  it("requires explicit party labels for color and escapes candidate/source text", () => {
    expect(electionPartyTone()).toBe("neutral");
    expect(electionPartyTone("Independent")).toBe("neutral");
    expect(electionPartyTone("Democratic")).toBe("democratic");
    expect(electionPartyTone("Republican")).toBe("republican");
    const race = electionRace({ sourceLabel: '<img src=x onerror="alert(1)">' });
    race.candidates[0].name = "<script>alert(1)</script>";
    const html = renderElectionResults("race", { races: [race] });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });
  it("shows AP attribution, identifies the called candidate in the table and fails safely", () => {
    const race = electionRace({ status: "called", sourceKind: "ap", calledCandidateId: "ellis", apCallUrl: "https://apnews.com/example" });
    const html = renderElectionResults("race", { races: [race] });
    expect(html).toContain("Race called by The Associated Press");
    expect(html).toContain('class="election-results__winner"');
    expect(html).toContain("Jordan Ellis (Winner; AP called this race)");
    expect(renderElectionResults("race", { races: [{} as never] })).toContain("not available");
  });
  it("omits a missing photo slot and groups actual photo credits once per race", () => {
    const race = electionRace();
    race.candidates[0].photo = { assetId: "portrait", alt: "Portrait", caption: "Example photographer" };
    const html = renderElectionResults("race", { races: [race] }, 2, () => '<img src="https://example.test/photo.jpg" alt="Portrait">');
    expect(html.match(/class="election-results__portrait"/g)).toHaveLength(1);
    expect(html).toContain("election-results__candidate--no-photo");
    expect(html).toContain("Photo credits: Jordan Ellis: Example photographer");
    expect(html).not.toContain("Illustrative portrait");
  });
  it("freezes candidate Media usage and blocks unsupported public readers", () => {
    const race = electionRace(); race.candidates[0].photo = { assetId: "candidate-photo", alt: "Jordan Ellis" };
    const document = { ...source(), blocks: [electionBlock(race)] };
    expect(media.collectWorkingMediaUsage({ collection: "cmsPages", documentId: "contact", document }).assetIds).toContain("candidate-photo");
    expect(compatibility.candidateSupportsOwnedElectionResults({ visible: true }, document, {})).toBe(false);
    expect(compatibility.candidateSupportsOwnedElectionResults({ visible: true }, document, { electionResultsVersion: 1 })).toBe(true);
    expect(compatibility.candidateSupportsOwnedElectionResults({ visible: false }, document, {})).toBe(true);
  });
});


describe("Results in reusable Post templates", () => {
  it("copies content as a private draft and clears values for layout-only templates", () => {
    const templates = require("../../functions/lib/post-templates.js");
    const document = { ...source("cmsPosts"), electionResultsApprovals: [{ private: "approval" }] };
    const content = templates.capturePost(document, "content");
    expect(content.status).toBe("draft");
    expect(content.blocks[0].data.races).toEqual([electionRace()]);
    expect(content.electionResultsApprovals).toBeUndefined();
    expect(templates.capturePost(document, "layout").blocks[0].data.races).toEqual([]);
    expect(document.blocks[0].data.races).toEqual([electionRace()]);
  });
});
