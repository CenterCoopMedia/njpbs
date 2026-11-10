import { useEffect, useRef, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router";
import type { Principal } from "../../../packages/content-core/src/rbac";
import {
  adminDestinationStorage,
  canOpenAdminPath,
  destinationPathname,
  destinationToRestore,
  forgetDestination,
  readRememberedDestination,
  rememberDestination,
} from "../lib/route-memory";

// Keeps the tab's current Admin destination on record and, once per load, restores it when the
// address did not survive (#1031). The decisions live in lib/route-memory; this is only the
// wiring that gives them a router.
//
// Order matters in one place. The remembered value is read during the first render, before the
// recording effect can overwrite it with wherever this load actually landed, so the boot read
// always sees the previous session's destination rather than the one this load is about to
// record.
//
// The restore is an ordinary replace navigation, so it goes through the same focus and
// announcement contract as any other route change (#587): the destination heading takes focus
// and its label is announced. That is the right outcome here — the route did change under the
// person after the initial paint, and a screen-reader user has to hear where they landed.
export function useDestinationMemory(principal: Principal, uid: string): void {
  const location = useLocation();
  const navigate = useNavigate();
  let search = location.search;
  if (matchPath("/premiere/connect", location.pathname)) {
    const params = new URLSearchParams(search);
    if (params.has("code")) {
      // The shell's first recording effect can run before the route's replace settles.
      params.delete("code");
      search = params.size ? `?${params}` : "";
    }
  }
  const here = `${location.pathname}${search}${location.hash}`;

  const [rememberedAtBoot] = useState(() =>
    readRememberedDestination(adminDestinationStorage(), uid),
  );
  const restored = useRef(false);
  // The principal read at restore time, held in a ref so a later capability change cannot
  // re-trigger a boot-time decision.
  const principalRef = useRef(principal);
  principalRef.current = principal;
  const hereRef = useRef(here);
  hereRef.current = here;

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;

    const target = destinationToRestore(hereRef.current, rememberedAtBoot);
    if (!target) return;

    // Authorization is re-derived from this load's principal, never carried in the stored
    // value. A remembered route this account cannot open is dropped and the person stays on
    // the default destination, with no access notice: they did not ask for that route now.
    if (!canOpenAdminPath(principalRef.current, destinationPathname(target))) {
      forgetDestination(adminDestinationStorage());
      return;
    }

    navigate(target, { replace: true });
  }, [navigate, rememberedAtBoot]);

  useEffect(() => {
    rememberDestination(adminDestinationStorage(), uid, here);
  }, [here, uid]);
}

// Drop the memory when the session ends, so the next person to sign in on this tab starts at
// the default destination rather than the last one someone else was using.
export function forgetAdminDestination(): void {
  forgetDestination(adminDestinationStorage());
}
