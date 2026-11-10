import { expect, it } from "vitest";
import { countSafeExternalLinks, serviceDonationLinks } from "../scripts/public-contract-links.mjs";

const href = "https://www.pbs.org/donation/?station_id=test&campaign=passport";

it("counts safe links with reordered attributes, CMS classes and encoded URLs", () => {
  const html = `<a href="${href.replace("&", "&amp;")}" class="btn" rel="noopener" target="_blank">Donate</a>
    <a target='_blank' rel='noreferrer noopener' class='card' href='${href}'>Donate</a>`;
  expect(countSafeExternalLinks(html, href)).toBe(2);
});

it("does not count wrong destinations, unsafe links or lookalike text", () => {
  const html = `<a href="${href}" target="_blank">Unsafe</a>
    <a href="${href}" rel="noopener">Same tab</a>
    <a href="${href}x" target="_blank" rel="noopener">Wrong URL</a>
    <a href="${href}" target="_blank" rel="not-noopener">Wrong rel</a>
    <!-- <a href="${href}" target="_blank" rel="noopener">Comment</a> -->`;
  expect(countSafeExternalLinks(html, href)).toBe(0);
});

it("keeps the four-link template contract on unmarked and unrelated pages", () => {
  const link = `<a href="${href}" rel="noopener" target="_blank">Donate</a>`;
  expect(serviceDonationLinks(link.repeat(4), href, "support")).toEqual({ composed: false, actual: 4, expected: 4 });
  expect(serviceDonationLinks(`<div class="cms-page--service-composition" data-cms-page="about" data-service-composition-version="1">${link.repeat(4)}</div>`, href, "support"))
    .toEqual({ composed: false, actual: 4, expected: 4 });
});

it("allows staff to add or remove every composed link while checking the fixed shell", () => {
  const link = `<a href="${href}" rel="noopener" target="_blank">Donate</a>`;
  const content = (body: string) => `<div class="cms-page cms-page--service-composition" data-cms-page="support" data-service-composition-version="1">${body}</div>`;
  for (const body of ["", link.repeat(5), `<a href="${href}">Same-tab authored link</a>`]) {
    expect(serviceDonationLinks(link.repeat(2) + content(body), href, "support")).toEqual({ composed: true, actual: 2, expected: 2 });
  }
  expect(serviceDonationLinks(link + content(""), href, "support")).toEqual({ composed: true, actual: 1, expected: 2 });
});
