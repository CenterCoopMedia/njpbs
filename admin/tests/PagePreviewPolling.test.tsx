// The first queue read is intentionally synchronous with request acceptance;
// only subsequent reads use the adaptive cadence below.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PagePreview } from "../src/components/PagePreview";
import type {
  PreviewRequestResponse,
  PreviewStatusResponse,
} from "../src/lib/functions";

const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function request(
  overrides: Partial<PreviewRequestResponse> = {},
): PreviewRequestResponse {
  return {
    success: true,
    queueId: "queue123",
    pageId: "contact",
    sourceVersion: 7,
    dispatched: true,
    status: "building",
    ...overrides,
  };
}

function status(
  overrides: Partial<PreviewStatusResponse> = {},
): PreviewStatusResponse {
  return {
    success: true,
    queueId: "queue123",
    status: "building",
    pageId: "contact",
    sourceVersion: 7,
    previewUrl: null,
    error: null,
    requestedAt: "2026-09-01T12:00:00.000Z",
    completedAt: null,
    expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    ...overrides,
  };
}

async function startPreview() {
  fireEvent.click(screen.getByRole("button", { name: "Build preview" }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PagePreview polling cadence", () => {
  it("checks an accepted queue immediately instead of waiting for the follow-up interval", async () => {
    vi.useFakeTimers();
    const requestPreview = vi.fn().mockResolvedValue(request());
    const loadPreviewStatus = vi.fn().mockResolvedValue(status());

    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={60_000}
      />,
    );

    await startPreview();

    expect(requestPreview).toHaveBeenCalledWith("contact");
    expect(loadPreviewStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(1);
  });

  it("backs off quickly to a bounded four-second polling ceiling", async () => {
    vi.useFakeTimers();
    const loadPreviewStatus = vi.fn().mockResolvedValue(status());

    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={vi.fn().mockResolvedValue(request())}
        loadPreviewStatus={loadPreviewStatus}
      />,
    );

    await startPreview();
    expect(loadPreviewStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(749);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_499);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_999);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(6);
  });

  it("returns to the fastest cadence when the queue advances from pending to building", async () => {
    vi.useFakeTimers();
    const loadPreviewStatus = vi
      .fn()
      .mockResolvedValueOnce(status({ status: "pending" }))
      .mockResolvedValue(status({ status: "building" }));

    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={vi.fn().mockResolvedValue(request({ status: "pending" }))}
        loadPreviewStatus={loadPreviewStatus}
      />,
    );

    await startPreview();
    expect(loadPreviewStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(749);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loadPreviewStatus).toHaveBeenCalledTimes(3);
  });
});
