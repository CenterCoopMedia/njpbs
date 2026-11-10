import { describe, expect, it } from "vitest";
import {
  HOME_PASSPORT_CONTENT,
  homeStartItems,
  renderHomePassport,
  renderHomeStart,
} from "../../packages/content-core/src/home-section-render";

const destinations = {
  live: "/live/", ondemand: "https://watch.njpbs.org/",
  schedule: "/schedule/", kids: "/kids/",
};

function fragment(markup: string): HTMLDivElement {
  const element = document.createElement("div");
  element.innerHTML = markup;
  return element;
}

describe("shared Home sections", () => {
  it("keeps the four pathways, public destinations, artwork and external notice", () => {
    const content = fragment(renderHomeStart(homeStartItems(destinations, true), destinations.schedule));
    expect([...content.querySelectorAll(".sched__item")].map(item => item.getAttribute("href")))
      .toEqual(Object.values(destinations));
    expect(content.querySelectorAll(".sched__blocks .b")).toHaveLength(8);
    expect(content.querySelectorAll(".sched__pulse")).toHaveLength(1);
    expect(content.querySelector(".sched__time")).toBeNull();
    const onDemand = content.querySelector<HTMLAnchorElement>(".sched__item--ondemand")!;
    expect(onDemand.target).toBe("_blank");
    expect(onDemand.rel).toBe("noopener");
    expect(onDemand.querySelector(".sr-only")?.textContent).toContain("opens in new tab");
  });

  it("escapes pathway text and refuses unsafe destinations and image URLs", () => {
    const content = fragment(renderHomeStart([{
      show: '<img src=x onerror="alert(1)">',
      detail: "<script>bad()</script>", href: "javascript:bad()",
      image: "javascript:bad()",
    }], "javascript:bad()"));
    expect(content.querySelector("img, script, [href], [src]")).toBeNull();
    expect(content.querySelector(".sched__show")?.textContent).toContain("<img");
  });

  it("shares Passport's public copy and safe rich-text rendering", () => {
    const content = fragment(renderHomePassport(HOME_PASSPORT_CONTENT,
      "https://watch.njpbs.org/passport/learn-more/"));
    expect(content.querySelector("#pass-h")?.textContent).toBe(HOME_PASSPORT_CONTENT.heading);
    expect(content.querySelector(".passport__body p")?.textContent).toContain("Learn how the Passport member benefit works through PBS.");
    expect(content.querySelector(".passport__action a")?.getAttribute("href"))
      .toBe("https://watch.njpbs.org/passport/learn-more/");
    const escaped = fragment(renderHomePassport({
      ...HOME_PASSPORT_CONTENT, heading: "<script>bad()</script>",
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<img src=x>" }] }] },
      actionLabel: "<svg onload=bad()>",
    }, "javascript:bad()"));
    expect(escaped.querySelector("script, svg, .passport__action [href]")).toBeNull();
    expect(escaped.querySelector(".passport__body p")?.textContent).toBe("<img src=x>");
  });
});
