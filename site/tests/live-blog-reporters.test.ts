import { afterEach, describe, expect, it, vi } from "vitest";
import { renderLiveBlog } from "../../packages/content-core/src/live-blog-render";
import { liveBlogReporterBio, type LiveBlogReporter } from "../../packages/content-core/src/live-blog-reporters-render";
import { installLiveBlogInteractions } from "../../packages/content-core/src/live-blog-interactions";
import type { LiveBlogData } from "../../packages/content-core/src/live-blog";

const at = "2026-10-30T12:00:00.000Z", authorId = `au_${"a".repeat(32)}`;
const credits = [{ kind: "registered" as const, authorId, displayName: "Frozen reporter" }];
const body = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Reporting." }] }] };
const profile: LiveBlogReporter = { authorId, displayName: "Current reporter", jobTitle: "Statehouse reporter", bio: "Covers New Jersey. A second sentence.", path: "/authors/current-reporter/", photo: { url: "https://media.example.test/photo.jpg" } };
function blog(presentation?: LiveBlogData["presentation"]): LiveBlogData {
  return { schemaVersion: 1, coverageState: "ongoing", updatedAt: at, ...(presentation ? { presentation } : {}), updates: [
    { id: "first", headline: "First report", credits: [...credits], body, keyUpdate: true, publishedAt: at, updatedAt: at,
      followUps: [{ id: "reply", credits: [...credits], body, publishedAt: at, updatedAt: at }] },
    { id: "withdrawn", headline: "Update withdrawn", credits: [...credits], body: { type: "doc", content: [] }, withdrawal: "Unverified.", keyUpdate: false, publishedAt: "2026-10-30T11:59:00.000Z", updatedAt: at },
  ] };
}
function render(presentation?: LiveBlogData["presentation"], reporters = [profile]) {
  document.body.innerHTML = renderLiveBlog(blog(presentation), { id: "post", asOf: at, reporters, canonicalUrl: "https://njpbs.org/posts/coverage/?private=discard#old" });
  return document.querySelector<HTMLElement>("[data-live-blog]")!;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

describe("live blog reporter presentation", () => {
  it.each([
    ["2026-11-01T03:59:00.000Z", "2026-11-01T04:01:00.000Z", "Sun., Nov. 1 · 12:01 AM EDT", "Sat., Oct. 31 · 11:59 PM EDT"],
    ["2026-11-02T04:59:00.000Z", "2026-11-02T05:01:00.000Z", "Mon., Nov. 2 · 12:01 AM EST", "Sun., Nov. 1 · 11:59 PM EST"],
    ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z", "Sun., Nov. 1 · 1:30 AM EST", "1:30 AM EDT"],
  ])("uses station days across the Nov. 1 DST boundary from %s to %s", (earlier, later, newest, older) => {
    const value = blog(); value.updatedAt = later;
    value.updates = [earlier, later].map((publishedAt, index) => ({ ...value.updates[0], id: `dst-${index}`, publishedAt, updatedAt: later, followUps: undefined }));
    document.body.innerHTML = renderLiveBlog(value, { id: "dst", asOf: later });
    const stamps = [...document.querySelectorAll(".live-blog__stamp>.live-blog__metadata time")];
    expect(stamps.map(stamp => {
      const day = stamp.querySelector<HTMLElement>("[data-live-blog-day-label]")!;
      return `${day.hidden ? "" : day.textContent}${stamp.querySelector(".live-blog__clock")?.textContent}`;
    })).toEqual([newest, older]);
    expect(stamps.map(stamp => stamp.getAttribute("datetime"))).toEqual([later, earlier]);
  });
  it("labels station-day boundaries newest first and compares each reply with its parent or previous reply", () => {
    const cutoff = "2026-11-04T05:10:00.000Z";
    const value = blog(); value.updatedAt = cutoff;
    const seed = value.updates[0];
    value.updates = ["2026-11-04T04:58:00.000Z", "2026-11-04T05:01:00.000Z", "2026-11-04T04:59:00.000Z"].map((publishedAt, i) => ({ ...seed, id: `day-${i}`, publishedAt, updatedAt: cutoff, followUps: undefined }));
    value.updates[0].followUps = ["2026-11-04T04:59:00.000Z", "2026-11-04T05:01:00.000Z", "2026-11-04T05:02:00.000Z"].map((publishedAt, i) => ({ id: `reply-${i}`, credits, body, publishedAt, updatedAt: publishedAt }));
    document.body.innerHTML = renderLiveBlog(value, { id: "days", asOf: cutoff });
    const stamps = Array.from(document.querySelectorAll(".live-blog__stamp>.live-blog__metadata time"));
    const visible = (stamp: Element) => {
      const day = stamp.querySelector<HTMLElement>("[data-live-blog-day-label]")!;
      return `${day.hidden ? "" : day.textContent}${stamp.querySelector(".live-blog__clock")?.textContent}`;
    };
    expect(stamps.map(visible)).toEqual(["Wed., Nov. 4 · 12:01 AM EST", "Tue., Nov. 3 · 11:59 PM EST", "11:58 PM EST"]);
    expect(stamps[0].getAttribute("datetime")).toBe("2026-11-04T05:01:00.000Z");
    expect(stamps[0].getAttribute("aria-label")).toBe("Nov. 4, 2026, 12:01 AM EST");
    expect(stamps[2].getAttribute("aria-label")).toBe("Nov. 3, 2026, 11:58 PM EST");
    const replies = Array.from(document.querySelectorAll(".live-blog-follow-up__header>.live-blog__metadata time"));
    expect(replies.map(visible)).toEqual(["11:59 PM EST", "Wed., Nov. 4 · 12:01 AM EST", "12:02 AM EST"]);
    expect(replies[0].getAttribute("aria-label")).toBe("Nov. 3, 2026, 11:59 PM EST");
    expect(replies[2].getAttribute("datetime")).toBe("2026-11-04T05:02:00.000Z");
  });
  it("labels the first reply when its station day differs from its parent", () => {
    const value = blog(); value.updatedAt = "2026-11-04T05:10:00.000Z";
    value.updates = [{ ...value.updates[0], publishedAt: "2026-11-04T04:59:00.000Z", updatedAt: value.updatedAt,
      followUps: [{ id: "next-day", credits, body, publishedAt: "2026-11-04T05:01:00.000Z", updatedAt: "2026-11-04T05:01:00.000Z" }] }];
    document.body.innerHTML = renderLiveBlog(value, { id: "next-day", asOf: value.updatedAt });
    const label = document.querySelector<HTMLElement>('.live-blog-follow-up__header [data-live-blog-day-label]')!;
    expect(label.hidden).toBe(false); expect(label.textContent).toBe("Wed., Nov. 4 · ");
  });
  it("removes a stale first-of-day label from an entry reused after new updates load", async () => {
    const value = blog(); value.updates = [value.updates[0]];
    document.body.innerHTML = renderLiveBlog(value, { id: "days", asOf: at });
    const root = document.querySelector<HTMLElement>("[data-live-blog]")!; installLiveBlogInteractions(root);
    const original = root.querySelector<HTMLElement>(".live-blog__stamp [data-live-blog-day-label]")!;
    expect(original.hidden).toBe(false);
    const incoming = document.createElement("div");
    incoming.innerHTML = renderLiveBlog({ ...value, updates: [{ ...value.updates[0], id: "newest" }] }, { id: "days", asOf: at });
    root.querySelector(".live-blog__updates")!.prepend(incoming.querySelector(".live-blog__updates>li")!);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector<HTMLElement>(".live-blog__stamp [data-live-blog-day-label]")!.hidden).toBe(false);
    expect(original.hidden).toBe(true);
  });
  it.each([[true, true], [true, false], [false, true], [false, false]])("keeps photos=%s and cards=%s independent", (reporterPhotos, reporterCards) => {
    const root = render({ reporterPhotos, reporterCards });
    const stamp = root.querySelector(".live-blog__stamp")!;
    expect(root.dataset.liveBlogReporterPhotos).toBe(String(reporterPhotos));
    expect(root.dataset.liveBlogReporterCards).toBe(String(reporterCards));
    expect(Boolean(stamp.querySelector(".live-blog__portrait"))).toBe(reporterPhotos);
    expect(Boolean(stamp.querySelector(".live-blog__reporter-trigger"))).toBe(reporterCards);
    expect(stamp.textContent).toContain("Current reporter");
    expect(stamp.querySelector(".live-blog__reporter-trigger--text") !== null).toBe(!reporterPhotos && reporterCards);
    if (reporterCards) {
      expect(root.classList.contains("live-blog--enhanced")).toBe(false);
      expect(stamp.querySelector(".live-blog__reporter-fallback")).not.toBeNull();
    }
  });
  it("uses only public profile identity and counts parent reporting without withdrawals or replies", () => {
    const root = render();
    const card = root.querySelector(".live-blog__reporter-card")!;
    expect(card.textContent).toContain("Covers New Jersey."); expect(card.textContent).not.toContain("A second sentence");
    expect(card.textContent).toContain("1 update in this live blog");
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/authors/current-reporter/");
    expect(root.textContent).not.toContain("Frozen reporter");
    const ids = Array.from(root.querySelectorAll("[id]"), node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("uses initials for a public reporter without a photo and PBS for custom/missing profiles", () => {
    const root = render(undefined, [{ ...profile, photo: null }]);
    expect(root.querySelector(".live-blog__initials")?.textContent).toBe("CR");
    const source = blog(); source.updates[0].credits.push({ kind: "custom", name: "Custom newsroom" });
    document.body.innerHTML = renderLiveBlog(source, { id: "post", asOf: at });
    expect(document.querySelector(".live-blog__reporter-name")?.textContent).toBe("Frozen reporter");
    expect(document.querySelectorAll(".live-blog__portrait>svg")).toHaveLength(4);
    expect(document.querySelector(".live-blog__reporter-trigger,.live-blog__reporter-card")).toBeNull();
  });
  it("bounds the first public bio sentence by Unicode points", () => {
    expect(liveBlogReporterBio('  Covers NJ. ” More.')).toBe("Covers NJ.");
    expect(Array.from(liveBlogReporterBio("😀".repeat(141)))).toHaveLength(140);
    expect(liveBlogReporterBio("😀".repeat(141))).toMatch(/…$/u);
  });
  it.each([
    ["Covers N.J. politics. More background.", "Covers N.J. politics."],
    ["Dr. Smith reports. More background.", "Dr. Smith reports."],
    ["U.S. Rep. X covers Congress. More background.", "U.S. Rep. X covers Congress."],
    ["A. B. Chen reports at 9 a.m. and 6 p.m. on weekdays. More background.", "A. B. Chen reports at 9 a.m. and 6 p.m. on weekdays."],
    ["Mr. and Mrs. Smith cover St. Mary with Ms. Jones Jr. and Gov. Reed Sr. Sen. Kay joins Rep. X and Lt. Y on No. 5. More background.", "Mr. and Mrs. Smith cover St. Mary with Ms. Jones Jr. and Gov. Reed Sr. Sen. Kay joins Rep. X and Lt. Y on No. 5."],
  ])("retains abbreviations within a bounded reporter bio (%s)", (bio, expected) => {
    expect(liveBlogReporterBio(bio)).toBe(expected);
  });
  it("separates auxiliary control ids from adversarial immutable reply ids", () => {
    const value = blog(); const reply = value.updates[0].followUps![0];
    value.updates[0].followUps!.push({ ...reply, id: "reply-copy-link" }, { ...reply, id: "reply-reporter-0" });
    document.body.innerHTML = renderLiveBlog(value, { id: "post", asOf: at, reporters: [profile] });
    const ids = Array.from(document.querySelectorAll("[id]"), node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const trigger of document.querySelectorAll(".live-blog__reporter-trigger")) {
      expect(document.getElementById(trigger.getAttribute("aria-controls")!)?.getAttribute("role")).toBe("dialog");
    }
  });
  it("opens by keyboard activation, closes with Escape/outside action, and enhances refreshed nodes", async () => {
    const root = render(); installLiveBlogInteractions(root);
    const trigger = root.querySelector<HTMLButtonElement>(".live-blog__reporter-trigger")!;
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(trigger.hidden).toBe(false); trigger.click(); expect(panel.hidden).toBe(false);
    expect(document.activeElement).toBe(panel.querySelector(".live-blog__card-close"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
    trigger.click();
    const restoreFocus = vi.spyOn(trigger, "focus");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(panel.hidden).toBe(true); expect(restoreFocus).not.toHaveBeenCalled();
    const incoming = document.createElement("div"); incoming.innerHTML = renderLiveBlog(blog(), { id: "incoming", asOf: at, reporters: [profile] });
    root.querySelector("ol")!.append(incoming.querySelector("ol>li")!);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelectorAll(".live-blog__reporter-trigger[hidden]")).toHaveLength(0);
    expect(root.querySelectorAll(".live-blog__copy-button")).toHaveLength(5);
  });
  it("copies only the public canonical URL and immutable fragment, then resets feedback", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const root = render({ playful: true }); installLiveBlogInteractions(root);
    const id = root.querySelector("article")!.id, button = root.querySelector<HTMLButtonElement>(".live-blog__copy-button")!;
    button.click(); await Promise.resolve(); await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(`https://njpbs.org/posts/coverage/#${id}`);
    expect(button.getAttribute("aria-label")).toBe("Copy link to this update"); expect(button.dataset.copied).toBe("");
    expect(root.querySelector('.live-blog__copy-control [role="status"]')?.textContent).toBe("Link copied");
    expect(root.querySelectorAll(".live-blog__ripple i")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2600); expect(button.hasAttribute("data-copied")).toBe(false); expect(root.querySelector(".live-blog__ripple")).toBeNull();
  });
  it("keeps copy confirmation without motion and offers a selected URL when clipboard is denied", async () => {
    const root = render({ playful: true });
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true, addEventListener: vi.fn() } as unknown as MediaQueryList);
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    installLiveBlogInteractions(root); const button = root.querySelector<HTMLButtonElement>(".live-blog__copy-button")!;
    button.click(); await Promise.resolve(); await Promise.resolve(); expect(button.hasAttribute("data-copied")).toBe(true); expect(root.querySelector(".live-blog__ripple")).toBeNull();
    writeText.mockRejectedValue(new Error("Denied")); button.click(); await Promise.resolve(); await Promise.resolve();
    expect(button.hasAttribute("data-copied")).toBe(false);
    const input = root.querySelector<HTMLInputElement>(".live-blog__copy-fallback input")!;
    expect(input.closest<HTMLElement>("label")!.hidden).toBe(false); expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length); expect(input.value).not.toContain("private");
  });
  it("leaves working native anchors when no public canonical URL was supplied", () => {
    document.body.innerHTML = renderLiveBlog(blog(), { id: "post", asOf: at });
    const root = document.querySelector<HTMLElement>("[data-live-blog]")!; installLiveBlogInteractions(root);
    expect(root.querySelector(".live-blog__copy-button")).toBeNull(); expect(root.querySelector(".live-blog__permalink")?.getAttribute("href")).toBe(`#${root.querySelector("article")!.id}`);
  });
  it("keeps an open reporter card and its focused control through a refreshed parent", async () => {
    const root = render(); installLiveBlogInteractions(root);
    root.querySelector<HTMLButtonElement>(".live-blog__reporter-trigger")!.click();
    const focusedId = (document.activeElement as HTMLElement).id;
    const incoming = document.createElement("div"); incoming.innerHTML = renderLiveBlog(blog(), { id: "post", asOf: at, reporters: [profile] });
    const old = root.querySelector("article")!, fresh = incoming.querySelector("article")!;
    old.replaceWith(fresh);
    // The feed's fallback focuses the stable parent before enhancement runs.
    fresh.focus(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.activeElement?.id).toBe(focusedId);
    expect(root.querySelector<HTMLButtonElement>(".live-blog__reporter-trigger")?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector<HTMLElement>(".live-blog__reporter-card")?.hidden).toBe(false);
  });
});
