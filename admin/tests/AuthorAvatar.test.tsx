import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthorAvatar } from "../src/components/ui/AuthorAvatar";

// The avatar's fallback rule: a photograph that cannot be fetched falls back to
// initials, and that fallback is remembered against the URL that failed rather
// than as a permanent flag. A sticky flag meant one unreachable file turned a
// person into initials for the rest of the session -- saving a working
// replacement changed nothing on screen until the surface happened to remount.

function photo(url: string) {
  return { url, focalX: 0.5, focalY: 0.2 };
}

function avatarImage(): HTMLImageElement | undefined {
  return screen
    .queryAllByRole("presentation", { hidden: true })
    .find((node) => node.tagName === "IMG") as HTMLImageElement | undefined;
}

describe("author avatar", () => {
  it("falls back to initials when the photograph cannot be loaded", () => {
    render(<AuthorAvatar displayName="Sam Morgan" photo={photo("https://media.njpbs.org/gone.jpg")} />);

    fireEvent.error(avatarImage() as HTMLImageElement);

    expect(screen.getByText("SM")).toBeInTheDocument();
    expect(avatarImage()).toBeUndefined();
  });

  it("draws a replacement photograph after an earlier one failed", () => {
    const { rerender } = render(
      <AuthorAvatar displayName="Sam Morgan" photo={photo("https://media.njpbs.org/gone.jpg")} />,
    );
    fireEvent.error(avatarImage() as HTMLImageElement);
    expect(screen.getByText("SM")).toBeInTheDocument();

    rerender(
      <AuthorAvatar displayName="Sam Morgan" photo={photo("https://media.njpbs.org/fixed.jpg")} />,
    );

    expect(avatarImage()?.getAttribute("src")).toBe("https://media.njpbs.org/fixed.jpg");
    expect(screen.queryByText("SM")).not.toBeInTheDocument();
  });

});
