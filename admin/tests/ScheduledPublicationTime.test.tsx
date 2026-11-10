import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ScheduledPublicationTime } from "../src/components/ScheduledPublicationTime";

it("shows the stored scheduled instant in Eastern time and hides missing, invalid or inactive schedules", () => {
  const { container, rerender } = render(<ScheduledPublicationTime status="scheduled" publishAt="2026-10-14T10:00:00.000Z" />);
  expect(container.querySelector("time")).toHaveTextContent("Scheduled: Oct 14, 2026, 6:00 AM EDT");
  expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-10-14T10:00:00.000Z");
  rerender(<ScheduledPublicationTime status="scheduled" publishAt="2026-11-01T06:30:00.000Z" />);
  expect(container.querySelector("time")).toHaveTextContent("Scheduled: Nov 1, 2026, 1:30 AM EST");
  for (const props of [
    { status: "draft", publishAt: "2026-10-14T10:00:00.000Z" },
    { status: "published", publishAt: "2026-10-14T10:00:00.000Z" },
    { status: "scheduled", publishAt: "invalid" },
    { status: "scheduled" },
  ]) {
    rerender(<ScheduledPublicationTime {...props} />);
    expect(container).toBeEmptyDOMElement();
  }
});
