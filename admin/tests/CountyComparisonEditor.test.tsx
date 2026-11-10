import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CountyComparisonEditor } from "../src/components/CountyComparisonEditor";
import { createBlock } from "../src/lib/block-factory";
import { isCountyComparisonData } from "../../packages/content-core/src/county-comparison";

describe("county comparison editor", () => {
  it("starts with a valid reviewed dataset and edits only the editorial text", () => {
    const block = createBlock("county_comparison", "county-test");
    const onChange = vi.fn();
    expect(isCountyComparisonData(block.data)).toBe(true);
    render(<CountyComparisonEditor block={block} onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "County election history" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...block.data, heading: "County election history" });
    fireEvent.change(screen.getByRole("textbox", { name: "Introduction" }), { target: { value: "Compare both elections." } });
    expect(onChange).toHaveBeenLastCalledWith({ ...block.data, intro: "Compare both elections." });
    fireEvent.change(screen.getByRole("textbox", { name: "Source line" }), { target: { value: "Official election results" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...block.data, source: "Official election results" });
  });

  it("keeps the reviewed table available and editorial fields disabled in read-only mode", () => {
    const onChange = vi.fn();
    const { container } = render(<CountyComparisonEditor block={createBlock("county_comparison", "read-only")} onChange={onChange} readOnly />);
    expect(screen.getByRole("textbox", { name: "Heading" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "Forbidden" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(42);
  });
});
