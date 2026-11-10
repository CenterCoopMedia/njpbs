// Pure routing for configured shared mailbox groups.

/** Placeholder recipients for local development; configure Worker destination groups before use. */
export const DEFAULT_DESTINATIONS = [
  "editor-a@example.org",
  "njpbs@montclair.edu",
  "editor-b@example.org",
  "editor-c@example.org",
] as const;

/** Placeholder membership for the configured info alias. */
const INFO_DESTINATIONS = [...DEFAULT_DESTINATIONS, "editor-d@example.org"] as const;

/** Configurable destination groups. */
const PROGRAMMING_DESTINATIONS = [
  ...DEFAULT_DESTINATIONS.filter((address) => address !== "editor-b@example.org"),
  "producer-a@example.org",
  "producer-b@example.org",
  "producer-c@example.org",
  "engineer-a@example.org",
  "producer-d@example.org",
  "producer-e@example.org",
] as const;

/** Configurable destination groups. */
const DESK_DESTINATIONS = [
  ...DEFAULT_DESTINATIONS.filter(
    (address) => address !== "editor-a@example.org" && address !== "editor-b@example.org",
  ),
  "desk-a@example.org",
] as const;

/**
 * The shared addresses that serve the station generally.
 *
 * Which addresses actually reach this worker is set by the zone's Email Routing
 * rules, so this list cannot enforce anything. It is here to tell an expected
 * address from an unexpected one, which is the difference between the default
 * being the right answer and the default quietly covering a mistake.
 */
export const STATION_ADDRESSES: ReadonlySet<string> = new Set([
  "info",
  "support",
  "admin",
  "press",
  "news",
  "tips",
  "membership",
  "donate",
  "jobs",
  "careers",
  "social",
]);

/** Configurable destination groups. */
export const DEPARTMENT_DESTINATIONS: ReadonlyMap<string, readonly string[]> =
  new Map<string, readonly string[]>([
    ["info", INFO_DESTINATIONS],
    ["engineering", ["engineer-a@example.org", "engineer-b@example.org"]],
    ["programming", PROGRAMMING_DESTINATIONS],
    ["desk", DESK_DESTINATIONS],
  ]);

/**
 * The one zone whose address list this worker routes on. The same Cloudflare
 * account hosts other zones (newnjpbs.org, njnewswire.net), and a routing rule
 * in any of them could be pointed at this worker by mistake. Without a domain
 * check, an address like `engineering@newnjpbs.org` would match on its local
 * part and be silently forwarded to the njpbs.org destinations. Requiring the
 * domain makes an off-zone address unexpected, so it falls to the station
 * default and trips the index.ts warning instead of being trusted.
 */
export const ZONE = "njpbs.org";

/** Configurable destination groups. */
export const OFF_ZONE_ADDRESSES: ReadonlySet<string> = new Set([
  "info@newnjpbs.org",
]);

/**
 * The local part, normalized the way both lookups expect it: trimmed,
 * lowercased, and with any `+tag` subaddress removed.
 *
 * Cloudflare Email Routing accepts `engineering+vendor@` under the base
 * `engineering@` rule and hands the worker the address tag and all. Left on, the
 * lookup key is `engineering+vendor`, which matches no entry, so the message
 * falls back to the station-wide group instead of reaching the engineers. The `+tag`
 * is a sender-chosen detail, not part of the route, so it comes off before
 * either lookup.
 */
export function localPartOf(recipient: string): string {
  const local = recipient.trim().toLowerCase().split("@")[0] ?? "";
  return local.split("+")[0] ?? "";
}

/**
 * The domain, normalized like the local part: everything after the first `@`,
 * trimmed and lowercased. The first `@`, to stay consistent with localPartOf:
 * an address with more than one `@` yields a "domain" that matches no zone, so
 * a malformed recipient fails closed into the station default rather than
 * being routed on a guess. No `+tag` handling; tags live in the local part.
 */
export function domainOf(recipient: string): string {
  const normalized = recipient.trim().toLowerCase();
  const at = normalized.indexOf("@");
  return at === -1 ? "" : normalized.slice(at + 1);
}

/** Whether this address is one the worker is meant to serve. */
export function isKnownAddress(recipient: string): boolean {
  const domain = domainOf(recipient);
  if (domain !== ZONE) {
    return OFF_ZONE_ADDRESSES.has(`${localPartOf(recipient)}@${domain}`);
  }
  const local = localPartOf(recipient);
  return STATION_ADDRESSES.has(local) || DEPARTMENT_DESTINATIONS.has(local);
}

/**
 * Destinations for a recipient address, in delivery order.
 *
 * The handler attempts these destinations sequentially in this stable order.
 * Each rejection is isolated. Accepted forwards are recorded in a Durable
 * Object when a Message-ID is available, so later invocations skip those legs.
 * Only unfinished legs request another retry. This cannot provide exactly-once
 * delivery across SMTP acceptance and the separate durable receipt write.
 *
 * An address with no entry gets the station default rather than an empty list.
 * Only addresses with a routing rule reach this worker, so an unexpected one
 * means a rule was added without a matching entry here. Delivering it to the
 * station-wide group is the safe reading of that mistake; index.ts logs it so the
 * mistake is findable rather than only survivable.
 *
 * An off-zone address gets the same treatment before its local part is even
 * looked up: a department route is a decision about a njpbs.org address, and
 * extending it to `engineering@` on some other zone would forward a stranger
 * zone's mail to people who never agreed to receive it.
 */
export interface DestinationGroups {
  default: readonly string[];
  info: readonly string[];
  engineering: readonly string[];
  programming: readonly string[];
  desk: readonly string[];
}

export function configuredDestinations(raw?: string): DestinationGroups {
  if (!raw?.trim()) throw new Error("FANOUT_DESTINATIONS_JSON is required");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid destination configuration");
  for (const key of ["default", "info", "engineering", "programming", "desk"]) {
    const addresses = value[key];
    if (!Array.isArray(addresses) || addresses.length === 0 ||
      addresses.some(address => typeof address !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
      throw new Error("Invalid destination configuration");
    }
  }
  return value as unknown as DestinationGroups;
}

export function destinationsFor(recipient: string, groups?: DestinationGroups): readonly string[] {
  if (groups) {
    const local = localPartOf(recipient);
    return domainOf(recipient) === ZONE && DEPARTMENT_DESTINATIONS.has(local)
      ? groups[local as "info" | "engineering" | "programming" | "desk"] : groups.default;
  }
  if (domainOf(recipient) !== ZONE) return DEFAULT_DESTINATIONS;
  return (
    DEPARTMENT_DESTINATIONS.get(localPartOf(recipient)) ?? DEFAULT_DESTINATIONS
  );
}
