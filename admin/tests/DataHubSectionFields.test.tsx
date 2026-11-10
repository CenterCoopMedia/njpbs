import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataHubSectionFields } from "../src/components/DataHubSectionFields";
import DataHubSectionPreview from "../src/components/DataHubSectionPreview";
import { createBlock } from "../src/lib/block-factory";
import { dataHubSectionSource } from "../src/lib/data-hub-section-source";
import { DATA_HUB_SECTIONS } from "../../packages/content-core/src/data-hub-composition";
import { DATA_HUB_FIGURES } from "../../packages/content-core/src/data-hub-reporting";
import { outlineSummary } from "../src/lib/content-outline";
afterEach(cleanup);

it("uses the reviewed section copy and figure values without copying them into a draft", () => {
  for (const id of Object.keys(DATA_HUB_SECTIONS) as (keyof typeof DATA_HUB_SECTIONS)[]) {
    expect(dataHubSectionSource(id).heading).toBeTruthy();
  }
  for (const id of Object.keys(DATA_HUB_FIGURES) as (keyof typeof DATA_HUB_FIGURES)[]) {
    const source = dataHubSectionSource(id);
    expect(source.introduction).toBeTruthy(); expect(source.display).toBeTruthy(); expect(source.period).toBeTruthy(); expect(source.checked).toBeTruthy();
  }
  expect(dataHubSectionSource("unemployment")).toMatchObject({ heading: "Unemployment rate", display: "4.2%", period: "September 2026", checked: "2026-10-20" });
  expect(dataHubSectionSource("featured").benchmarks).toEqual([
    { label: "Current rate · most workers", display: "$15.92", period: "Jan. 1–Dec. 31, 2026" },
    { label: "Announced · not yet in effect", display: "$16.48", period: "Effective Jan. 1, 2027" },
  ]);
  const changed = vi.fn();
  function Fields() {
    const [block, setBlock] = useState({ ...createBlock("data_hub_section", "figure"), data: { sectionId: "unemployment", heading: "", introduction: "" } });
    return <DataHubSectionFields block={block} usedSections={["unemployment"]} onChange={data => { changed(data); setBlock({ ...block, data: data as typeof block.data }); }} />;
  }
  render(<Fields />);
  expect(screen.getByRole("textbox", { name: "Heading" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Heading" })).toHaveAttribute("placeholder", "Unemployment rate");
  expect(screen.getByRole("textbox", { name: "Introduction" })).toHaveAttribute("placeholder", "Share of the New Jersey labor force unemployed in September 2026, seasonally adjusted.");
  expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "Employment context" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "" } });
  expect(screen.getByRole("textbox", { name: "Heading" })).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "  " } });
  expect(screen.getAllByText("Using compiled default")).toHaveLength(2);
  fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "New context" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset to default for Heading" }));
  expect(screen.getByRole("textbox", { name: "Heading" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Heading" })).toHaveAttribute("placeholder", "Unemployment rate");
  expect(changed).toHaveBeenLastCalledWith({ sectionId: "unemployment", heading: "", introduction: "" });
});

it("inherits compiled heading and introduction for whitespace-only overrides", () => {
  render(<DataHubSectionPreview level={2} data={{ sectionId: "unemployment", heading: "  ", introduction: "\n " }} />);
  expect(outlineSummary({ ...createBlock("data_hub_section", "blank"), data: { sectionId: "unemployment", heading: "  ", introduction: "" } })).toBe("Unemployment");
  expect(screen.getByRole("heading", { name: "Unemployment rate" })).toBeInTheDocument();
  expect(screen.getByText("Share of the New Jersey labor force unemployed in September 2026, seasonally adjusted.")).toBeInTheDocument();
});

it("previews staff text beside compiled values as inert text", () => {
  const { container } = render(<DataHubSectionPreview level={2} data={{ sectionId: "unemployment", heading: "<img src=x onerror=alert(1)>", introduction: "Staff context" }} />);
  expect(screen.getByRole("heading", { name: "<img src=x onerror=alert(1)>" })).toBeInTheDocument();
  expect(screen.getByText("Staff context")).toBeInTheDocument();
  expect(screen.getByText("4.2%")).toBeInTheDocument();
  expect(screen.getByText(/September 2026/)).toBeInTheDocument();
  expect(container.querySelector("img")).toBeNull();
});
