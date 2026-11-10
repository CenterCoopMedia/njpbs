import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssetImage } from "../src/components/ui/AssetImage";

describe("AssetImage", () => {
  it("shows the caller's fallback instead of a broken-image glyph when the source fails", () => {
    render(
      <AssetImage
        alt=""
        data-testid="picture"
        fallback={<span>No image available</span>}
        src="https://media.example.org/missing.jpg"
      />,
    );
    fireEvent.error(screen.getByTestId("picture"));
    expect(screen.getByText("No image available")).toBeInTheDocument();
    expect(screen.queryByTestId("picture")).toBeNull();
  });

  it("tries again when the source changes", () => {
    const { rerender } = render(
      <AssetImage
        alt=""
        data-testid="picture"
        fallback={<span>No image available</span>}
        src="https://media.example.org/missing.jpg"
      />,
    );
    fireEvent.error(screen.getByTestId("picture"));
    expect(screen.getByText("No image available")).toBeInTheDocument();

    rerender(
      <AssetImage
        alt=""
        data-testid="picture"
        fallback={<span>No image available</span>}
        src="https://media.example.org/present.jpg"
      />,
    );
    expect(screen.getByTestId("picture")).toHaveAttribute(
      "src",
      "https://media.example.org/present.jpg",
    );
    expect(screen.queryByText("No image available")).toBeNull();
  });
});
