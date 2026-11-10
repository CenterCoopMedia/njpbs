import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandLockup } from "../src/components/BrandLockup";

describe("admin brand assets", () => {
  it("renders the official NJ PBS lockup instead of a drawn placeholder mark", () => {
    render(<BrandLockup />);

    expect(screen.getByRole("img", { name: "NJ PBS" })).toHaveAttribute(
      "src",
      "/brand/njpbs-horizontal-white.svg",
    );
    expect(screen.getByText("Boardwalk")).toBeInTheDocument();
    expect(document.querySelector(".brand-mark")).toBeNull();
  });

});
