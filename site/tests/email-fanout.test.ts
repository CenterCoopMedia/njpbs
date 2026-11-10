// @vitest-environment node
// The Email Worker needs no DOM and no Workers runtime: fanout.ts is a pure
// routing decision and index.ts is a thin loop over it, so a fake message object
// covers both. These verify that station and department addresses reach their
// configured destination groups, preserve group order, and never route an
// address outside the njpbs.org zone on its local part.
import { afterEach, describe, expect, it, vi } from "vitest";
import deployedWorker from "../worker-fanout/index";
import {
  DEFAULT_DESTINATIONS,
  ZONE,
  STATION_ADDRESSES,
  destinationsFor,
  isKnownAddress,
} from "../worker-fanout/fanout";

afterEach(() => vi.restoreAllMocks());

const STATION_LOCALS = [...STATION_ADDRESSES];
const STATION_MAILBOXES = [
  "editor-a@example.org",
  "njpbs@montclair.edu",
  "editor-b@example.org",
  "editor-c@example.org",
];
const INFO_MAILBOXES = [...STATION_MAILBOXES, "editor-d@example.org"];
const GENERIC_STATION_LOCALS = STATION_LOCALS.filter((local) => local !== "info");
const ENGINEERS = ["engineer-a@example.org", "engineer-b@example.org"];
const PROGRAMMING_MAILBOXES = [
  "editor-a@example.org",
  "njpbs@montclair.edu",
  "editor-c@example.org",
  "producer-a@example.org",
  "producer-b@example.org",
  "producer-c@example.org",
  "engineer-a@example.org",
  "producer-d@example.org",
  "producer-e@example.org",
];
const DESK_MAILBOXES = [
  "njpbs@montclair.edu",
  "editor-c@example.org",
  "desk-a@example.org",
];

const worker: typeof deployedWorker = {
  email(message, env) {
    return deployedWorker.email(message, { FANOUT_DESTINATIONS_JSON: JSON.stringify({
      default: STATION_MAILBOXES, info: INFO_MAILBOXES, engineering: ENGINEERS,
      programming: PROGRAMMING_MAILBOXES, desk: DESK_MAILBOXES,
    }), ...env });
  },
};

/** A message that records each attempt and successful forward, in order. */
function fakeMessage(
  to: string,
  onForward?: (rcpt: string) => void | Promise<void>,
) {
  const attempted: string[] = [];
  const forwarded: string[] = [];
  return {
    attempted,
    forwarded,
    message: {
      to,
      async forward(rcptTo: string): Promise<void> {
        attempted.push(rcptTo);
        await onForward?.(rcptTo);
        forwarded.push(rcptTo);
      },
    },
  };
}

describe("destinationsFor", () => {
  it("still covers all eleven station-wide addresses", () => {
    // A guard on the list itself. Dropping one here would not fail any routing
    // assertion below, since an address with no entry gets the same default.
    expect(STATION_LOCALS).toHaveLength(11);
  });

  it.each(GENERIC_STATION_LOCALS)("routes %s to the configured station group", (local) => {
    expect(destinationsFor(`${local}@njpbs.org`)).toEqual(STATION_MAILBOXES);
  });

  it("uses the extra configured membership for info only", () => {
    expect(destinationsFor(`info@${ZONE}`)).toEqual(INFO_MAILBOXES);
    expect(destinationsFor(`Info+question@${ZONE}`)).toEqual(INFO_MAILBOXES);
    expect(destinationsFor(`support@${ZONE}`)).toEqual(STATION_MAILBOXES);
    expect(destinationsFor("info@newnjpbs.org")).toEqual(STATION_MAILBOXES);
  });

  it(`routes engineering@${ZONE} to the two engineers only`, () => {
    // Adam asked for these two recipients (2026-07-16). The station inbox is
    // deliberately absent: a department address is not station-wide mail.
    expect(destinationsFor(`engineering@${ZONE}`)).toEqual(ENGINEERS);
  });

  it(
    "uses the configured programming group",
    () => {
      expect(destinationsFor(`programming@${ZONE}`)).toEqual(
        PROGRAMMING_MAILBOXES,
      );
    },
  );

  it(`routes desk@${ZONE} to the configured desk group`, () => {
    // Preserve the desk group's own recipient order.
    expect(destinationsFor(`desk@${ZONE}`)).toEqual(DESK_MAILBOXES);
    expect(destinationsFor(`Desk+night@${ZONE}`)).toEqual(DESK_MAILBOXES);
  });

  it("does not give desk@ on another domain the desk group", () => {
    // Same domain check as the other routes. A lookalike local part on another
    // zone falls to the station default. The handler warns because it is unknown.
    expect(destinationsFor("desk@newnjpbs.org")).toEqual(STATION_MAILBOXES);
    expect(isKnownAddress("desk@newnjpbs.org")).toBe(false);
  });

  it("keeps the configured station delivery order", () => {
    // Forward attempts are sequential and Worker telemetry follows this order.
    expect(DEFAULT_DESTINATIONS[0]).toBe("editor-a@example.org");
  });

  it("matches the local part case-insensitively", () => {
    expect(destinationsFor(`Engineering@${ZONE}`)).toEqual(ENGINEERS);
  });

  it("ignores surrounding whitespace", () => {
    expect(destinationsFor(`  engineering@${ZONE}  `)).toEqual(ENGINEERS);
  });

  it("strips a +tag subaddress before the route lookup", () => {
    // Cloudflare accepts engineering+vendor@ under the base engineering@ rule and
    // hands the worker the tag intact. The +vendor is a sender-chosen detail, not
    // part of the route, so it must come off or the mail misses the engineers and
    // falls back to the station-wide group. A station address subaddresses the same way.
    expect(destinationsFor(`engineering+vendor@${ZONE}`)).toEqual(ENGINEERS);
    expect(destinationsFor(`press+newsletter@${ZONE}`)).toEqual(STATION_MAILBOXES);
  });

  it("falls back to the station-wide group for an address with no entry", () => {
    // Only addresses with a routing rule reach the worker, so an unknown one
    // means a rule was added without a matching entry. Deliver it rather than
    // drop it silently.
    expect(destinationsFor(`fixture-unknown@${ZONE}`)).toEqual(STATION_MAILBOXES);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "falls back for %s@, which an object literal would answer with a function",
    (local) => {
      // The lookup is a Map for exactly this. Held as an object, these local
      // parts resolve to inherited properties, the ?? fallback never fires, and
      // the handler's for...of throws on a non-iterable instead of delivering.
      expect(destinationsFor(`${local}@njpbs.org`)).toEqual(STATION_MAILBOXES);
    },
  );

  it("does not route a department address on another zone to its people", () => {
    // Department routes belong only to the configured zone. Off-zone lookalikes
    // use the station default and are reported as unknown aliases.
    expect(destinationsFor("engineering@newnjpbs.org")).toEqual(STATION_MAILBOXES);
    expect(destinationsFor("press@njnewswire.net")).toEqual(STATION_MAILBOXES);
  });

  it("does not treat a subdomain as the zone", () => {
    expect(destinationsFor(`engineering@mail.${ZONE}`)).toEqual(STATION_MAILBOXES);
  });
});

describe("isKnownAddress", () => {
  it.each(STATION_LOCALS)("knows %s@", (local) => {
    expect(isKnownAddress(`${local}@njpbs.org`)).toBe(true);
  });

  it("knows engineering@", () => {
    expect(isKnownAddress(`engineering@${ZONE}`)).toBe(true);
  });

  it("knows programming@", () => {
    expect(isKnownAddress(`programming@${ZONE}`)).toBe(true);
  });

  it("knows desk@", () => {
    expect(isKnownAddress(`desk@${ZONE}`)).toBe(true);
  });

  it("does not know an address nobody added", () => {
    expect(isKnownAddress(`fixture-unknown@${ZONE}`)).toBe(false);
  });

  it("knows a +tag subaddress of a served address", () => {
    expect(isKnownAddress(`engineering+vendor@${ZONE}`)).toBe(true);
  });

  it("does not know a served local part on another zone", () => {
    // The issue's named case (#605): a matching local part is not enough. The
    // domain decides whether the address is one of ours at all.
    expect(isKnownAddress("engineering@newnjpbs.org")).toBe(false);
    expect(isKnownAddress("press@njnewswire.net")).toBe(false);
  });

  it("knows the one documented off-zone address, tag and all", () => {
    // info@newnjpbs.org is deliberately routed through this worker
    // (wiki/web/newnjpbs-org.md), so it is expected traffic and must not read
    // as a misconfiguration. Its +tag subaddresses normalize the same way the
    // zone's own addresses do.
    expect(isKnownAddress("info@newnjpbs.org")).toBe(true);
    expect(isKnownAddress("Info+renewal@NewNJPBS.org")).toBe(true);
    // Only that address: its zone's other locals are still unexpected.
    expect(isKnownAddress("press@newnjpbs.org")).toBe(false);
  });

  it("still knows the zone regardless of case and whitespace", () => {
    expect(isKnownAddress(` Press@${ZONE.toUpperCase()} `)).toBe(true);
  });

  it("fails closed on a recipient with no domain or a mangled one", () => {
    // Missing domains and multiple @ separators never match the configured zone.
    expect(isKnownAddress("press")).toBe(false);
    expect(isKnownAddress(`press@bad@${ZONE}`)).toBe(false);
    expect(destinationsFor("press")).toEqual(STATION_MAILBOXES);
    expect(isKnownAddress(`engineering@${ZONE}@evil.example`)).toBe(false);
    expect(destinationsFor(`engineering@${ZONE}@evil.example`)).toEqual(STATION_MAILBOXES);
  });
});

describe("the email handler", () => {
  it("forwards a station address to the configured station group in order", async () => {
    const { forwarded, message } = fakeMessage(`press@${ZONE}`);
    await worker.email(message);
    expect(forwarded).toEqual(STATION_MAILBOXES);
  });

  it("forwards info mail to its configured group", async () => {
    const { forwarded, message } = fakeMessage(`info@${ZONE}`);
    await worker.email(message);
    expect(forwarded).toEqual(INFO_MAILBOXES);
  });

  it("forwards engineering mail to the engineers only", async () => {
    const { forwarded, message } = fakeMessage(`engineering@${ZONE}`);
    await worker.email(message);
    expect(forwarded).toEqual(ENGINEERS);
  });

  it("forwards programming mail to the configured programming group", async () => {
    const { forwarded, message } = fakeMessage(`programming@${ZONE}`);
    await worker.email(message);
    expect(forwarded).toEqual(PROGRAMMING_MAILBOXES);
  });

  it("forwards desk mail to the configured desk group", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { forwarded, message } = fakeMessage(`desk@${ZONE}`);
    try {
      await worker.email(message);
      expect(forwarded).toEqual(DESK_MAILBOXES);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("delivers desk@ on another domain to the station default and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { forwarded, message } = fakeMessage("desk@newnjpbs.org");
    try {
      await worker.email(message);
      expect(forwarded).toEqual(STATION_MAILBOXES);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("alias=unknown"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("attempts later destinations after a failed leg", async () => {
    const providerError = new Error(
      "550 rejected sensitive-person@example.com",
    );
    const { attempted, forwarded, message } = fakeMessage(
      `press@${ZONE}`,
      async (rcpt) => {
        if (rcpt === STATION_MAILBOXES[0]) throw providerError;
      },
    );

    const error = await worker.email(message).catch((reason: unknown) => reason);

    expect(attempted).toEqual(STATION_MAILBOXES);
    expect(forwarded).toEqual(STATION_MAILBOXES.slice(1));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "njpbs-fanout: forwarding failed for 1 destination(s).",
    );
    expect((error as Error).message).not.toContain(
      "sensitive-person@example.com",
    );
  });

  it(
    "reports the number of failures only after every leg is attempted",
    async () => {
      const { attempted, forwarded, message } = fakeMessage(
        `press@${ZONE}`,
        async (rcpt) => {
          if (rcpt === STATION_MAILBOXES[1]) throw new Error("mailbox full");
          if (rcpt === STATION_MAILBOXES[3]) throw new Error("rate limited");
        },
      );

      await expect(worker.email(message)).rejects.toThrow(
        "njpbs-fanout: forwarding failed for 2 destination(s).",
      );
      expect(attempted).toEqual(STATION_MAILBOXES);
      expect(forwarded).toEqual([STATION_MAILBOXES[0], STATION_MAILBOXES[2]]);
    },
  );

  it("does not log provider errors during a partial failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { message } = fakeMessage(`press@${ZONE}`, async (rcpt) => {
      if (rcpt === STATION_MAILBOXES[0]) {
        throw new Error("private provider response");
      }
    });

    try {
      await expect(worker.email(message)).rejects.toThrow(
        "njpbs-fanout: forwarding failed for 1 destination(s).",
      );
      expect(warn).not.toHaveBeenCalled();
      expect(error.mock.calls).toEqual([
        [`njpbs-fanout: alias=press@${ZONE} destination=1/4 category=forward-error`],
      ]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("warns without exposing an unknown recipient when a rule has no entry", async () => {
    // The mail is fine, which is the problem: it arrives somewhere reasonable and
    // nobody finds out the rule and the code disagree. Say so without personal data.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { forwarded, message } = fakeMessage(`fixture-unknown@${ZONE}`);
    await worker.email(message);
    expect(forwarded).toEqual(STATION_MAILBOXES);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("alias=unknown"));
    warn.mockRestore();
  });

  it("delivers info@newnjpbs.org to the station-wide group without a warning", async () => {
    // The redirect domain's supported address has a configured route,
    // same destinations it gets today. A warning here would bury the real
    // misconfiguration warnings under every renewal notice.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { forwarded, message } = fakeMessage("info@newnjpbs.org");
    await worker.email(message);
    expect(forwarded).toEqual(STATION_MAILBOXES);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("delivers off-zone mail to the station-wide group and warns without the address", async () => {
    // An off-zone rule pointed here is a misconfiguration, but the mail is still
    // real and someone sent it. Deliver it where a human will see it, and log the
    // misconfiguration category without exposing an arbitrary address.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { forwarded, message } = fakeMessage("engineering@newnjpbs.org");
    await worker.email(message);
    expect(forwarded).toEqual(STATION_MAILBOXES);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("alias=unknown"));
    warn.mockRestore();
  });

  it("stays quiet for an address it is meant to serve", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await worker.email(fakeMessage(`press@${ZONE}`).message);
    await worker.email(fakeMessage(`engineering@${ZONE}`).message);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("configured recipient groups", () => {
  const groups = { default: ["station@example.org"], info: ["info-recipient@example.org"], engineering: ["engineer@example.org"],
    programming: ["producer@example.org"], desk: ["desk@example.org"] };

  it("uses Worker bindings for department recipients and keeps off-zone mail on the default group", async () => {
    for (const [recipient, expected] of [[`info@${ZONE}`, groups.info], [`Info+question@${ZONE}`, groups.info],
      ["info@other.example.org", groups.default], [`engineering@${ZONE}`, groups.engineering],
      ["desk@other.example.org", groups.default], [`support@${ZONE}`, groups.default]] as const) {
      const message = fakeMessage(recipient);
      await worker.email(message.message, { FANOUT_DESTINATIONS_JSON: JSON.stringify(groups) });
      expect(message.forwarded).toEqual(expected);
    }
  });

  it("fails before forwarding when a configured group is empty or malformed", async () => {
    for (const invalid of [{ ...groups, info: undefined }, { ...groups, info: [] },
      { ...groups, info: ["invalid"] }, { ...groups, desk: [] }, { ...groups, engineering: ["invalid"] }, null]) {
      const message = fakeMessage(`desk@${ZONE}`);
      await expect(worker.email(message.message, { FANOUT_DESTINATIONS_JSON: JSON.stringify(invalid) })).rejects.toThrow();
      expect(message.attempted).toEqual([]);
    }
  });
});

it.each([undefined, "", " "])("rejects a missing destination binding before forwarding (%s)", async raw => {
  const message = fakeMessage(`desk@${ZONE}`);
  await expect(deployedWorker.email(message.message, { FANOUT_DESTINATIONS_JSON: raw }))
    .rejects.toThrow("FANOUT_DESTINATIONS_JSON is required");
  expect(message.attempted).toEqual([]);
});
