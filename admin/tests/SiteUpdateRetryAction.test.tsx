import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SiteUpdateRetryAction } from "../src/components/SiteUpdateRetryAction";
import type { SiteUpdateRetryResult } from "../src/lib/site-update-retry";

it("keeps retry pending, blocks repeated activation and reports acceptance without claiming completion", async () => {
  let resolve!: (value: SiteUpdateRetryResult) => void;
  const retry = vi.fn(() => new Promise<SiteUpdateRetryResult>(done => { resolve = done; }));
  render(<SiteUpdateRetryAction available onRetry={retry} />);
  const button = screen.getByRole("button", { name: "Retry site update" });
  fireEvent.click(button); fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(1);
  // The shared pending control stays focusable and uses aria-disabled.
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toHaveAttribute("aria-busy", "true");
  await act(async () => resolve({ success: true, queueId: "G".repeat(20), status: "pending", message: "Retrying the accepted site update." }));
  expect(await screen.findByText("Retrying the accepted site update.")).toBeVisible();
  expect(screen.queryByText(/complete/i)).not.toBeInTheDocument();
});

it("keeps a refused or failed retry recoverable and shows its inline error", async () => {
  const retry = vi.fn().mockRejectedValueOnce(new Error("This update changed. Refresh Publish activity."))
    .mockResolvedValueOnce({ success: true, status: "pending", queueId: "G".repeat(20), message: "Retry accepted." });
  render(<SiteUpdateRetryAction available onRetry={retry} />);
  const button = screen.getByRole("button", { name: "Retry site update" });
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("This update changed. Refresh Publish activity.");
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByText("Retry accepted.")).toBeVisible();
  expect(retry).toHaveBeenCalledTimes(2);
});

it("disables a stale active job before it can be retried", () => {
  const retry = vi.fn();
  render(<SiteUpdateRetryAction available={false} onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry site update" }));
  expect(retry).not.toHaveBeenCalled();
});
