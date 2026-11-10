import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUCCESS_NOTICE_TIMEOUT_MS,
  SuccessNoticeProvider,
  useSuccessNotice,
} from "../src/components/ui/SuccessNoticeRegion";

function NoticeTrigger({
  message = "Draft saved.",
  preserveOnNextRoute = false,
  tone,
  action,
}: {
  message?: string;
  preserveOnNextRoute?: boolean;
  tone?: "error";
  action?: () => void;
}) {
  const notice = useSuccessNotice();
  return (
    <button
      onClick={() => notice.show(message, {
        preserveOnNextRoute,
        tone,
        ...(action ? { action: { label: "Review fields", onClick: action } } : {}),
      })}
    >
      Show notice
    </button>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SuccessNoticeProvider", () => {
  it("announces the latest notice once and dismisses it without moving content", async () => {
    const view = render(
      <SuccessNoticeProvider routeKey="first">
        <NoticeTrigger />
      </SuccessNoticeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show notice" }));
    const region = screen.getByRole("region", { name: "Notifications" });
    const announcer = region.querySelector(".success-notice-announcer");
    expect(announcer).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(announcer).toHaveTextContent("Draft saved."));
    expect(view.container.querySelector(".success-notice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(announcer).toBeEmptyDOMElement();
    expect(view.container.querySelector(".success-notice")).toBeNull();
    expect(view.container.querySelector(".success-notice-region")).toBeTruthy();
  });

  it("clears and restores a repeated message so it is announced again", () => {
    vi.useFakeTimers();
    render(
      <SuccessNoticeProvider routeKey="first">
        <NoticeTrigger />
      </SuccessNoticeProvider>,
    );
    const show = screen.getByRole("button", { name: "Show notice" });
    const announcer = document.querySelector(".success-notice-announcer");

    fireEvent.click(show);
    act(() => vi.advanceTimersByTime(0));
    expect(announcer).toHaveTextContent("Draft saved.");

    fireEvent.click(show);
    expect(announcer).toBeEmptyDOMElement();
    act(() => vi.advanceTimersByTime(0));
    expect(announcer).toHaveTextContent("Draft saved.");
  });

  it("keeps an error until dismissal and exposes its action without moving focus", () => {
    vi.useFakeTimers();
    const action = vi.fn();
    render(
      <SuccessNoticeProvider routeKey="first">
        <NoticeTrigger message="Fix the highlighted fields." tone="error" action={action} />
      </SuccessNoticeProvider>,
    );
    const show = screen.getByRole("button", { name: "Show notice" });
    show.focus();
    fireEvent.click(show);
    act(() => vi.advanceTimersByTime(0));

    const notice = document.querySelector(".success-notice");
    const announcer = document.querySelector(".success-notice-announcer");
    expect(document.activeElement).toBe(show);
    expect(notice).toHaveAttribute("data-tone", "error");
    expect(announcer).toHaveAttribute("aria-live", "assertive");
    expect(announcer).toHaveTextContent("Fix the highlighted fields.");
    const review = screen.getByRole("button", { name: "Review fields" });
    expect(review).toHaveAccessibleDescription("Fix the highlighted fields.");

    act(() => vi.advanceTimersByTime(SUCCESS_NOTICE_TIMEOUT_MS * 2));
    expect(notice).toBeVisible();
    fireEvent.click(review);
    expect(action).toHaveBeenCalledTimes(1);
    expect(notice).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector(".success-notice")).toBeNull();
  });

  it("clears an error on a route change even if preservation was requested", () => {
    const view = render(
      <SuccessNoticeProvider routeKey="first">
        <NoticeTrigger message="Fix the highlighted fields." tone="error" preserveOnNextRoute />
      </SuccessNoticeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show notice" }));

    view.rerender(
      <SuccessNoticeProvider routeKey="second">
        <NoticeTrigger />
      </SuccessNoticeProvider>,
    );
    expect(view.container.querySelector(".success-notice")).toBeNull();
  });

  it("pauses its remaining timeout for hover and focus", () => {
    vi.useFakeTimers();
    render(
      <SuccessNoticeProvider routeKey="first">
        <NoticeTrigger />
      </SuccessNoticeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show notice" }));
    const notice = document.querySelector(".success-notice");
    expect(notice).toBeTruthy();

    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.mouseEnter(notice!);
    act(() => vi.advanceTimersByTime(SUCCESS_NOTICE_TIMEOUT_MS));
    expect(document.querySelector(".success-notice")).toBeVisible();

    fireEvent.mouseLeave(notice!);
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    fireEvent.focus(dismiss);
    act(() => vi.advanceTimersByTime(SUCCESS_NOTICE_TIMEOUT_MS));
    expect(document.querySelector(".success-notice")).toBeVisible();

    fireEvent.blur(dismiss, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(SUCCESS_NOTICE_TIMEOUT_MS - 2_001));
    expect(document.querySelector(".success-notice")).toBeVisible();
    act(() => vi.advanceTimersByTime(2));
    expect(document.querySelector(".success-notice")).toBeNull();
  });

  it("clears a notice when the route entry changes", () => {
    const view = render(
      <SuccessNoticeProvider routeKey="first">
        <NoticeTrigger />
      </SuccessNoticeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show notice" }));
    expect(view.container.querySelector(".success-notice")).toBeVisible();

    view.rerender(
      <SuccessNoticeProvider routeKey="second">
        <NoticeTrigger />
      </SuccessNoticeProvider>,
    );

    expect(view.container.querySelector(".success-notice")).toBeNull();
    expect(
      view.container.querySelector(".success-notice-announcer"),
    ).toBeEmptyDOMElement();
  });

  it("ignores a late completion from a route that is no longer active", () => {
    let staleShow: ReturnType<typeof useSuccessNotice>["show"] = () => {};
    let staleIsCurrent: ReturnType<typeof useSuccessNotice>["isCurrent"] = () => false;
    function CaptureController() {
      const notice = useSuccessNotice();
      staleShow = notice.show;
      staleIsCurrent = notice.isCurrent;
      return null;
    }
    const view = render(
      <SuccessNoticeProvider routeKey="first">
        <CaptureController />
      </SuccessNoticeProvider>,
    );

    view.rerender(
      <SuccessNoticeProvider routeKey="second">
        <CaptureController />
      </SuccessNoticeProvider>,
    );
    const oldRouteShow = staleShow;
    const oldRouteIsCurrent = staleIsCurrent;
    view.rerender(
      <SuccessNoticeProvider routeKey="third">
        <CaptureController />
      </SuccessNoticeProvider>,
    );
    act(() => oldRouteShow("Old route saved."));

    expect(oldRouteIsCurrent()).toBe(false);
    expect(view.container.querySelector(".success-notice")).toBeNull();
  });

  it("keeps a create confirmation through only its canonical route change", () => {
    const view = render(
      <SuccessNoticeProvider routeKey="create">
        <NoticeTrigger preserveOnNextRoute />
      </SuccessNoticeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show notice" }));

    view.rerender(
      <SuccessNoticeProvider routeKey="stored-record">
        <NoticeTrigger />
      </SuccessNoticeProvider>,
    );
    expect(view.container.querySelector(".success-notice")).toHaveTextContent(
      "Draft saved.",
    );

    view.rerender(
      <SuccessNoticeProvider routeKey="another-route">
        <NoticeTrigger />
      </SuccessNoticeProvider>,
    );
    expect(view.container.querySelector(".success-notice")).toBeNull();
  });

  it("keeps a replacement notice paused while the notice is in use", () => {
    vi.useFakeTimers();
    const view = render(
      <SuccessNoticeProvider routeKey="first">
        <NoticeTrigger message="First saved." />
      </SuccessNoticeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show notice" }));
    const notice = view.container.querySelector(".success-notice");
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    fireEvent.mouseEnter(notice!);
    fireEvent.focus(dismiss);

    view.rerender(
      <SuccessNoticeProvider routeKey="first">
        <NoticeTrigger message="Second saved." />
      </SuccessNoticeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show notice" }));
    act(() => vi.advanceTimersByTime(SUCCESS_NOTICE_TIMEOUT_MS));
    expect(view.container.querySelector(".success-notice")).toHaveTextContent(
      "Second saved.",
    );

    fireEvent.mouseLeave(notice!);
    fireEvent.blur(dismiss, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(SUCCESS_NOTICE_TIMEOUT_MS - 1));
    expect(view.container.querySelector(".success-notice")).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(view.container.querySelector(".success-notice")).toBeNull();
  });
});
