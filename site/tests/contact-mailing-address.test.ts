// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const contentDirectory = fileURLToPath(
  new URL("../src/content/pages/", import.meta.url),
);
const mailingAddress = ["NJ PBS", "1 Normal Ave.", "Montclair, NJ 07043"];
const markdownAddress = mailingAddress.join("<br />\n");
const contactPattern = /mailto:njpbs@montclair\.edu|tel:\+18008826622/;

const contactPages = readdirSync(contentDirectory)
  .filter((name) => name.endsWith(".md"))
  .filter((name) =>
    contactPattern.test(readFileSync(`${contentDirectory}/${name}`, "utf8")),
  )
  .sort();

describe("NJ PBS mailing address", () => {
  it("adds the exact address to the About-page contact section", () => {
    expect(read("../src/components/PublicSubpage.astro")).toContain(
      '"Mailing address: NJ PBS, 1 Normal Ave., Montclair, NJ 07043.",',
    );
  });

  it("publishes a semantic site-wide address in the footer", () => {
    expect(contactPages.length).toBeGreaterThan(0);
    for (const page of contactPages) {
      const content = readFileSync(`${contentDirectory}/${page}`, "utf8");

      if (page === "closed-captioning.md") {
        expect(content).toContain("NJ PBS closed-captioning contact<br />");
        expect(content).toContain(
          "1 Normal Ave.<br />\nMontclair, NJ 07043",
        );
        continue;
      }

      expect(
        content,
        `${page} publishes NJ PBS contact information without the mailing address`,
      ).toContain(markdownAddress);
    }

    const layout = read("../src/layouts/PublicSiteLayout.astro");
    expect(layout).toMatch(
      /<address class="foot-address">[\s\S]*?NJ PBS[\s\S]*?1 Normal Ave\.[\s\S]*?Montclair, NJ 07043[\s\S]*?<\/address>/,
    );
  });
});
