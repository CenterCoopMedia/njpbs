// Pure donation handoff policy. A reachable signal selects the PBS form; an
// outage selects a temporarily unavailable state with a station contact path.
// The fallback never relinks the failing donation host. The caller owns the
// reachability observation; this module performs no network, DOM or clock work.

/**
 * How the live call to the PBS donation form failed, as the same non-ok taxonomy
 * the schedule and gate surfaces collapse an upstream failure into
 * ({@link import("./member-gated-playback").GatedFetchFailure}). The `forbidden`
 * case is a service-side refusal: a 403 is never retried; the rest are transient.
 */
export type DonatePortalFailure =
  | "timeout" // upstream did not answer in time, or the network is down
  | "forbidden" // 403: the donation endpoint rejected the request and will not self-heal
  | "rateLimited" // 429: over the rate limit, retry later
  | "error"; // any other upstream failure (4xx or 5xx)

/**
 * The outcome of checking the PBS donation form, as a closed set so a caller cannot
 * invent a third. Exactly one is fed to {@link resolveDonateCta}:
 *
 *   - `reachable`: the PBS donation form answered; route the CTA to it.
 *   - `outage`: the form failed with `status`; degrade the CTA to the honest
 *     unavailable state and do not re-link the failing host.
 */
export type DonatePortalSignal =
  | { readonly kind: "reachable" }
  | { readonly kind: "outage"; readonly status: DonatePortalFailure };

/**
 * What the donate CTA renders, as a closed set. Neither is a broken state: `donate`
 * routes to the PBS form, and `unavailable` is an honest fallback that keeps a
 * CCM-controlled way to reach the station in front of the donor instead of a dead
 * link. The caller maps `donate` to `donateUrl` and `unavailable` to the /contact/
 * reach path; the policy decides the mode and copy, not the concrete hrefs, the
 * same split member-gated-playback.ts uses.
 */
export type DonateCtaRender =
  /** The PBS donation form is reachable: route the CTA to it. */
  | { readonly mode: "donate" }
  /**
   * The PBS donation form is failing: show an honest temporarily-unavailable state.
   * Never re-links the failing host; the caller points its action at the /contact/
   * reach path, which is PBS-free and survives the outage.
   */
  | { readonly mode: "unavailable"; readonly notice: string };

export interface DonateCtaResult {
  readonly render: DonateCtaRender;
  /**
   * Whether the caller should retry the donation-form check. Only an outage is ever
   * retryable, and a `forbidden` (403) is not: it will not self-heal, so retrying
   * only hammers a rejecting endpoint. A reachable form is a settled answer with
   * nothing to retry.
   */
  readonly retryable: boolean;
}

/**
 * Shown when the donation form is down with a transient failure (timeout, 429, or a
 * generic upstream error). Names the situation honestly, keeps a CCM-controlled way
 * to give in front of the donor, and invites a retry, which is honest only for a
 * transient failure. A 403 lapse uses {@link DONATE_LAPSED_NOTICE} instead.
 */
export const DONATE_UNAVAILABLE_NOTICE =
  "Online donations through PBS are temporarily unavailable, so a gift can't be completed here right now. Contact NJ PBS to give another way, or try again shortly.";

/**
 * Shown for a 403 from the donation endpoint. A forbidden is a service-side rejection,
 * not a slow network, so it does not self-heal and `retryable` is false. The copy must
 * not promise "try again shortly" the way the transient notice does, since that would
 * invite a retry that will not clear; it points at the CCM reach path and says access
 * is being restored, staying honest without the futile retry.
 */
export const DONATE_LAPSED_NOTICE =
  "Online donations through PBS are temporarily unavailable, so a gift can't be completed here right now. Contact NJ PBS to give another way while online donations are restored.";

/**
 * The honest unavailable notice for an outage, chosen by whether it was a transient
 * blip or a 403 lapse. A 403 does not self-heal (`retryable` is false), so it gets a
 * notice that does not invite a retry.
 */
function unavailableNotice(status: DonatePortalFailure): string {
  return status === "forbidden"
    ? DONATE_LAPSED_NOTICE
    : DONATE_UNAVAILABLE_NOTICE;
}

/** A failed check worth retrying: any transport failure except a 403 lapse, which
 *  does not self-heal. Mirrors member-gated-playback.ts and schedule-availability.ts. */
function isRetryableFailure(status: DonatePortalFailure): boolean {
  return status !== "forbidden";
}

/**
 * Resolve what the donate CTA renders and whether to retry, from the outcome of the
 * donation-form check.
 *
 * Total and pure: it returns a render for every signal, never throws, and never
 * mutates its input. A reachable form routes to the PBS donation page; every outage
 * degrades to the honest unavailable state and never re-links the failing host, so a
 * donor always meets a CCM-controlled way to reach the station rather than a dead
 * link.
 */
export function resolveDonateCta(signal: DonatePortalSignal): DonateCtaResult {
  switch (signal.kind) {
    case "reachable":
      return { render: { mode: "donate" }, retryable: false };
    case "outage":
      return {
        render: {
          mode: "unavailable",
          notice: unavailableNotice(signal.status),
        },
        retryable: isRetryableFailure(signal.status),
      };
  }
}
