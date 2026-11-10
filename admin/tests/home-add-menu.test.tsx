import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HomeAddMenu } from "../src/components/HomeAddMenu";
import type { AdminBlock } from "../src/lib/block-factory";
import { insertableBlocksForSection } from "../../packages/content-core/src/editor-admin";
import v1 from "../../site/tests/fixtures/home-composition-v1.json";

afterEach(cleanup);

it("uses bare nouns and distinct existing glyphs across all Home sections and content choices (#3510)", () => {
  const onRestore = vi.fn();
  const loadSources = vi.fn();
  const blocks = structuredClone(v1.blocks).map(block => ({ ...block, visible: false })) as AdminBlock[];
  render(<HomeAddMenu blocks={blocks}
    palette={insertableBlocksForSection("home").filter(type => !["row", "home_newscast", "newsletter_signup"].includes(type))}
    allowRows readOnly={false} destination={{}} loadSources={loadSources}
    onAddSection={vi.fn()} onRestore={onRestore} onAddPosts={vi.fn()} onInsert={() => null} />);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const menu = within(screen.getByRole("menu", { name: "Add" }));
  const choices = menu.getAllByRole("menuitem");
  expect(choices).toHaveLength(24);
  expect(choices.map(item => item.textContent)).toEqual(expect.arrayContaining([
    "NJ PBS Post section", "Newsletter signup", "Newscast", "Donor-advised giving",
    "Featured programs Restore hidden section", "Passport Restore hidden section",
    "More to watch Restore hidden section", "NJ Spotlight News Restore hidden section",
    "Image", "Image gallery", "Manual content shelf", "Sponsor strip", "Row",
  ]));
  expect(choices.every(item => !/^(Add|Restore)\b/.test(item.textContent ?? ""))).toBe(true);
  const glyphs = choices.map(item => item.querySelector("svg")?.innerHTML);
  expect(glyphs.every(Boolean)).toBe(true);
  expect(new Set(glyphs).size).toBe(choices.length);
  expect(loadSources).not.toHaveBeenCalled();
  fireEvent.click(menu.getByRole("menuitem", { name: "Passport Restore hidden section" }));
  expect(onRestore).toHaveBeenCalledWith(blocks.find(block => block.section === "home-passport-copy")!.id);
});
