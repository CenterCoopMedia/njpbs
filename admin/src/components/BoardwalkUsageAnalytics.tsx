import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { useShell } from "../routes/ShellContext";
import { auth } from "../lib/firebase";
import { boardwalkUsageConfig, startUsageAnalytics } from "../lib/boardwalk-usage";

export function BoardwalkUsageAnalytics() {
  const { user, getIdToken } = useShell();
  const { pathname } = useLocation();
  const currentPath = useRef(pathname);
  currentPath.current = pathname;
  const collector = useRef<ReturnType<typeof startUsageAnalytics> | null>(null);
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (!boardwalkUsageConfig.analyticsEnabled || !getIdToken) return;
    const uid = user.uid;
    const active = startUsageAnalytics({
      enabled: true,
      pathname: currentPath.current,
      send: async (batch, signal) => {
        if (auth.currentUser?.uid !== uid || signal.aborted) return;
        const token = await getIdToken();
        if (auth.currentUser?.uid !== uid || signal.aborted) return;
        const { postFunction } = await import("../lib/functions");
        return postFunction("cmsCollectBoardwalkUsage", token, batch, {}, { appCheck: true, signal });
      },
    });
    collector.current = active;
    lastPath.current = currentPath.current;
    return () => { active.stop(); collector.current = null; };
  }, [getIdToken, user.uid]);
  // The initial path is collected by start; only later path changes create a view.
  useEffect(() => {
    if (lastPath.current !== pathname) collector.current?.navigate(pathname);
    lastPath.current = pathname;
  }, [pathname]);
  return null;
}
