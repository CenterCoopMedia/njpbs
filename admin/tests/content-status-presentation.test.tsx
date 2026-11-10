import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { contentStatusPresentation } from "../src/lib/content-status";
import { PublishedVersionStatus } from "../src/components/PublishedVersionStatus";

describe("one record status (#3432)", () => {
  it.each([
    { name: "live with a newer content draft", status: "draft", publicState: "live" as const,
      contentVersion: 3, liveContentVersion: 2, savedVersion: 12,
      label: "Version 2 live", tone: "success", newerDraft: true },
    { name: "live only", status: "published", publicState: "live" as const,
      contentVersion: 2, liveContentVersion: 2, savedVersion: 8,
      label: "Version 2 live", tone: "success", newerDraft: false },
    { name: "later Page lifecycle transaction with unchanged content", status: "approved", publicState: "live" as const,
      contentVersion: 2, liveContentVersion: 2, savedVersion: 44,
      label: "Version 2 live", tone: "success", newerDraft: false },
    { name: "draft only", status: "draft", publicState: "not-live" as const,
      label: "Draft", tone: "draft", newerDraft: false },
    { name: "scheduled before first publication", status: "scheduled", publicState: "not-live" as const,
      label: "Scheduled", tone: "publishing", newerDraft: false },
    { name: "withdrawn", status: "draft", publicState: "not-live" as const, withdrawn: true,
      label: "Not live", tone: "cancelled", newerDraft: false },
    { name: "withdrawn then submitted for review", status: "in_review", publicState: "not-live" as const, withdrawn: true,
      label: "In review", tone: "pending", newerDraft: false },
    { name: "withdrawn then approved", status: "approved", publicState: "not-live" as const, withdrawn: true,
      label: "Approved", tone: "brand", newerDraft: false },
    { name: "withdrawn then scheduled again", status: "scheduled", publicState: "not-live" as const, withdrawn: true,
      label: "Scheduled", tone: "publishing", newerDraft: false },
    { name: "deleted while public removal is pending", status: "archived", publicState: "live" as const,
      contentVersion: 3, liveContentVersion: 2,
      label: "Deleted", tone: "deleted", newerDraft: false },
    { name: "old response missing the working editorial counter", status: "draft", publicState: "live" as const,
      liveContentVersion: 2, savedVersion: 44,
      label: "Version 2 live", tone: "success", newerDraft: false },
    { name: "old response missing the published editorial counter", status: "draft", publicState: "live" as const,
      contentVersion: 3, savedVersion: 44,
      label: "Version 2 live", tone: "success", newerDraft: false },
  ])("$name", ({ label, tone, newerDraft, name: _name, ...record }) => {
    expect(contentStatusPresentation({ ...record, liveLabel: "Version 2 live" }))
      .toEqual({ label, tone, newerDraft });
  });

  it("identifies Contact's saved draft separately from an unsaved site-code Page", () => {
    const contact = { status: "draft", publicState: "live" as const,
      liveLabel: "Site content live", siteContentLive: true };
    expect(contentStatusPresentation({ ...contact, savedVersion: 3 }))
      .toEqual({ label: "Site content live", tone: "success", newerDraft: true });
    expect(contentStatusPresentation(contact))
      .toEqual({ label: "Site content live", tone: "success", newerDraft: false });
  });

  it("renders no empty publication-details container and restores real progress", () => {
    const props = { collection: "cmsPages" as const, documentId: "contact", workingStatus: "draft",
      workingVersion: 12, contentVersion: 3, liveSourceVersion: 8, pendingSourceVersion: 8,
      publishedContentVersion: 2, pageReceipt: { operationId: "A".repeat(20), sourceVersion: 8, visible: true },
      loadPublicationMetadata: false, watchPublicReceipts: false, compact: true, detailsOnly: true,
      "aria-live": "polite" as const };
    const view = render(<PublishedVersionStatus {...props} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<PublishedVersionStatus {...props} publicUpdatePending publicBuildQueueId="queue-next"
      pendingSourceVersion={12} />);
    const progress = screen.getByText("Checking publication status.");
    expect(progress).toBeVisible();
    expect(progress.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it("does not claim an unconfirmed published record is live", () => {
    expect(contentStatusPresentation({ status: "published", publicState: "unknown",
      liveLabel: "Public status unavailable", contentVersion: 3, liveContentVersion: 2 }))
      .toEqual({ label: "Public status unavailable", tone: "unknown", newerDraft: false });
  });

  it("attaches an icon-only segment whose explanation works with focus, touch and Escape", () => {
    render(<PublishedVersionStatus collection="cmsPages" documentId="contact"
      pageReceipt={{ operationId: "A".repeat(20), sourceVersion: 8, visible: true }}
      recordTitle="Contact" workingStatus="draft" workingVersion={12}
      liveSourceVersion={8} pendingSourceVersion={8} contentVersion={3} publishedContentVersion={2}
      loadPublicationMetadata={false} watchPublicReceipts={false} compact />);
    expect(screen.getByText("Version 2 live")).toBeVisible();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.queryByText(/Working version .* is newer/)).not.toBeInTheDocument();
    const pencil = screen.getByRole("button", { name: "Draft status for Contact" });
    expect(pencil.textContent).toBe("");
    expect(pencil).toHaveAccessibleDescription("Newer draft available");
    expect(pencil.closest(".status-badge")).toHaveTextContent("Version 2 live");
    act(() => pencil.focus());
    expect(pencil).toHaveFocus();
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("Newer draft available");
    fireEvent.keyDown(pencil, { key: "Escape" });
    expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument();
    fireEvent.click(pencil);
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("Newer draft available");
  });

  it("keeps transaction-only changes and missing deployment-window counters free of a pencil", () => {
    const view = render(<PublishedVersionStatus collection="cmsPages" documentId="contact"
      pageReceipt={{ operationId: "A".repeat(20), sourceVersion: 8, visible: true }}
      workingStatus="draft" workingVersion={44}
      liveSourceVersion={8} pendingSourceVersion={8} contentVersion={2} publishedContentVersion={2}
      loadPublicationMetadata={false} watchPublicReceipts={false} statusOnly />);
    expect(screen.getByText("Version 2 live")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Draft status for/ })).not.toBeInTheDocument();
    view.rerender(<PublishedVersionStatus collection="cmsPages" documentId="contact"
      pageReceipt={{ operationId: "A".repeat(20), sourceVersion: 8, visible: true }}
      workingStatus="draft" workingVersion={44}
      liveSourceVersion={8} pendingSourceVersion={8}
      loadPublicationMetadata={false} watchPublicReceipts={false} statusOnly />);
    expect(screen.getByText("Published copy live")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Draft status for/ })).not.toBeInTheDocument();
  });

  it("keeps deletion visible alongside retained live evidence until removal is confirmed", () => {
    render(<PublishedVersionStatus collection="cmsPages" documentId="contact"
      pageReceipt={{ operationId: "A".repeat(20), sourceVersion: 8, visible: true }}
      workingStatus="archived" workingVersion={12} liveSourceVersion={8} pendingSourceVersion={8}
      contentVersion={3} publishedContentVersion={2}
      loadPublicationMetadata={false} watchPublicReceipts={false} compact />);
    expect(screen.getByText("Deleted")).toBeVisible();
    expect(screen.getByText("Version 2 live")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Draft status for/ })).not.toBeInTheDocument();
  });

  it("names repeated draft controls for their records without repeating the explanation", () => {
    render(<>{["Contact", "About"].map(title => <PublishedVersionStatus key={title}
      collection="cmsPages" documentId={title.toLowerCase()} recordTitle={title}
      pageReceipt={{ operationId: "A".repeat(20), sourceVersion: 8, visible: true }}
      workingStatus="draft" workingVersion={12} liveSourceVersion={8} pendingSourceVersion={8}
      contentVersion={3} publishedContentVersion={2}
      loadPublicationMetadata={false} watchPublicReceipts={false} compact />)}</>);
    for (const title of ["Contact", "About"]) {
      const pencil = screen.getByRole("button", { name: `Draft status for ${title}` });
      expect(pencil).toHaveAccessibleDescription("Newer draft available");
      expect(pencil.textContent).toBe("");
    }
  });
});
