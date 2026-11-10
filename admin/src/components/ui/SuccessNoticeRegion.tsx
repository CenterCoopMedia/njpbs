import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./Primitives";

export const SUCCESS_NOTICE_TIMEOUT_MS = 6_000;

interface SuccessNoticeAction {
  label: string;
  onClick: () => void;
}

interface SuccessNotice {
  id: number;
  message: string;
  tone: "success" | "error";
  action?: SuccessNoticeAction;
}

interface SuccessNoticeOptions {
  preserveOnNextRoute?: boolean;
  tone?: "error";
  action?: SuccessNoticeAction;
}

interface SuccessNoticeController {
  available: boolean;
  isCurrent: () => boolean;
  show: (message: string, options?: SuccessNoticeOptions) => void;
}

const unavailableController: SuccessNoticeController = {
  available: false,
  isCurrent: () => false,
  show: () => {},
};

const SuccessNoticeContext = createContext<SuccessNoticeController>(
  unavailableController,
);

export function useSuccessNotice(): SuccessNoticeController {
  return useContext(SuccessNoticeContext);
}

export function SuccessNoticeProvider({
  children,
  routeKey,
}: {
  children: ReactNode;
  routeKey: string;
}) {
  const messageId = useId();
  const nextId = useRef(0);
  const activeId = useRef<number | null>(null);
  const latestId = useRef<number | null>(null);
  const remainingMs = useRef(SUCCESS_NOTICE_TIMEOUT_MS);
  const currentRouteKey = useRef(routeKey);
  const previousRouteKey = useRef(routeKey);
  const preserveFromRouteKey = useRef<string | null>(null);
  const announcementTimer = useRef<number | null>(null);
  const [notice, setNotice] = useState<SuccessNotice | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  currentRouteKey.current = routeKey;

  const clearAnnouncementTimer = useCallback(() => {
    if (announcementTimer.current !== null) {
      window.clearTimeout(announcementTimer.current);
      announcementTimer.current = null;
    }
  }, []);
  const clearNotice = useCallback(() => {
    clearAnnouncementTimer();
    activeId.current = null;
    latestId.current = null;
    remainingMs.current = SUCCESS_NOTICE_TIMEOUT_MS;
    preserveFromRouteKey.current = null;
    setAnnouncement("");
    setNotice(null);
    setHovered(false);
    setFocused(false);
  }, [clearAnnouncementTimer]);

  const show = useCallback(
    (
      message: string,
      options?: SuccessNoticeOptions,
    ) => {
      // A caller keeps the controller from the route where its request began. Refuse a late
      // completion after that route has gone away, so old work cannot report success on the
      // screen that replaced it.
      if (currentRouteKey.current !== routeKey) return;
      const trimmed = message.trim();
      if (!trimmed) return;
      nextId.current += 1;
      const id = nextId.current;
      latestId.current = id;
      const tone = options?.tone ?? "success";
      preserveFromRouteKey.current = tone === "success" && options?.preserveOnNextRoute
        ? routeKey
        : null;
      clearAnnouncementTimer();
      // Clear and restore the live text so the same message is announced on repeated saves.
      setAnnouncement("");
      setNotice({ id, message: trimmed, tone, action: options?.action });
      announcementTimer.current = window.setTimeout(() => {
        announcementTimer.current = null;
        if (latestId.current === id) setAnnouncement(trimmed);
      }, 0);
    },
    [clearAnnouncementTimer, routeKey],
  );

  useEffect(() => {
    const previous = previousRouteKey.current;
    if (previous === routeKey) return;
    previousRouteKey.current = routeKey;
    if (preserveFromRouteKey.current === previous) {
      preserveFromRouteKey.current = null;
      return;
    }
    clearNotice();
  }, [clearNotice, routeKey]);

  useEffect(
    () => () => {
      clearAnnouncementTimer();
    },
    [clearAnnouncementTimer],
  );

  useEffect(() => {
    if (!notice) return;
    if (activeId.current !== notice.id) {
      activeId.current = notice.id;
      remainingMs.current = SUCCESS_NOTICE_TIMEOUT_MS;
    }
    if (notice.tone === "error") return;
    if (hovered || focused) return;

    const startedAt = Date.now();
    const duration = remainingMs.current;
    const timer = window.setTimeout(() => {
      if (latestId.current === notice.id) clearNotice();
    }, duration);
    return () => {
      window.clearTimeout(timer);
      if (activeId.current === notice.id) {
        remainingMs.current = Math.max(
          0,
          duration - (Date.now() - startedAt),
        );
      }
    };
  }, [clearNotice, focused, hovered, notice]);

  const controller = useMemo<SuccessNoticeController>(
    () => ({ available: true, isCurrent: () => currentRouteKey.current === routeKey, show }),
    [routeKey, show],
  );

  return (
    <SuccessNoticeContext.Provider value={controller}>
      {children}
      <div
        aria-label="Notifications"
        className="success-notice-region"
        role="region"
      >
        {/* Keep one live node mounted, but clear and restore its text for each event. */}
        <span
          aria-atomic="true"
          aria-live={notice?.tone === "error" ? "assertive" : "polite"}
          className="success-notice-announcer sr-only"
        >
          {announcement}
        </span>
        {notice ? (
          <div
            className="success-notice"
            data-tone={notice.tone}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setFocused(false);
              }
            }}
            onFocus={() => setFocused(true)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <span
              aria-hidden={notice.action ? undefined : true}
              id={notice.action ? messageId : undefined}
            >
              {notice.message}
            </span>
            {notice.action ? (
              <div className="toolbar">
                <Button
                  aria-describedby={messageId}
                  onClick={notice.action.onClick}
                  type="button"
                >
                  {notice.action.label}
                </Button>
                <Button onClick={clearNotice} type="button" variant="ghost">
                  Dismiss
                </Button>
              </div>
            ) : (
              <Button onClick={clearNotice} type="button" variant="ghost">
                Dismiss
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </SuccessNoticeContext.Provider>
  );
}
