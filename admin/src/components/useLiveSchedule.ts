import { useCallback, useEffect, useRef, useState } from "react";
import { loadScheduleSourceSnapshot } from "../lib/schedule-source-snapshot";
import type { ScheduleSourceSnapshot } from "../../../packages/content-core/src/schedule-source-snapshot";
import { millisecondsToNextMinute, renderScheduleNowNext } from "../../../packages/content-core/src/schedule-now-next-dom";
import { scheduleDateKey } from "../../../packages/content-core/src/schedule-clock";

type Source = { status: "loading" } | { status: "error" } |
  { status: "ready"; value: ScheduleSourceSnapshot };

export function useLiveSchedule(enabled: boolean) {
  const [source, setSource] = useState<Source>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let current = true;
    setSource({ status: "loading" });
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    void loadScheduleSourceSnapshot(controller.signal).then(value => {
      if (current) setSource({ status: "ready", value });
    }).catch(() => {
      if (current) setSource({ status: "error" });
    }).finally(() => window.clearTimeout(timer));
    return () => { current = false; controller.abort(); window.clearTimeout(timer); };
  }, [enabled, attempt]);

  const render = useCallback((element: HTMLElement) => {
    root.current = element;
    const strip = element.querySelector<HTMLElement>("[data-now-next]");
    if (!strip) return;
    if (source.status === "ready") {
      const at = new Date();
      renderScheduleNowNext(strip, source.value.days, at);
      if (!source.value.days.some(day => day.date === scheduleDateKey(at))) {
        const message = strip.querySelector("[data-now-next-fallback-message]");
        if (message) message.textContent = "The published schedule has no listings for today. Reload the schedule above to check for an update.";
      }
      return;
    }
    const message = strip.querySelector("[data-now-next-fallback-message]");
    if (message) message.textContent = source.status === "loading"
      ? "Loading the published schedule…"
      : "The published schedule is unavailable. Use Reload schedule above to try again.";
  }, [source]);

  useEffect(() => {
    if (!enabled) return;
    let interval: number | undefined;
    const update = () => { if (root.current?.isConnected) render(root.current); };
    const timer = window.setTimeout(() => {
      update();
      interval = window.setInterval(update, 60_000);
    }, millisecondsToNextMinute(Date.now()));
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
  }, [enabled, render]);
  return { source, render, retry: () => setAttempt(value => value + 1) };
}
