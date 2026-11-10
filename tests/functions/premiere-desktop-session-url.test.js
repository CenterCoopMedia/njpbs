import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("returns the server-owned complete approval URL with the displayed connection code", async () => {
  const filename = new URL("../../functions/lib/premiere-desktop-session.js", import.meta.url);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  // Substitute only the random boundary; the expected code and URL are literal spec fixtures.
  runInNewContext(readFileSync(filename, "utf8"), { module, require: name => name === "node:crypto"
    ? { ...crypto, randomBytes: size => size === 8 ? Buffer.from([9, 21, 14, 15, 29, 11, 24, 13]) : Buffer.alloc(size, 0) }
    : realRequire(name) });
  const batch = { create: vi.fn(), commit: vi.fn(async () => {}) };
  const firestore = { collection: () => ({ doc: id => ({ id }) }), batch: () => batch };
  const sessions = module.exports.createDesktopSessions({ firestore, auth: {}, now: () => 1_000_000 });
  const response = await sessions.start({ deviceName: "Editing bay", hostVersion: "26.5.2" });
  expect(response.userCode).toBe("KXQR-7M2P");
  expect(response.verificationUri).toBe("https://admin.njpbs.org/premiere/connect");
  expect(response.verificationUriComplete).toBe("https://admin.njpbs.org/premiere/connect?code=KXQR-7M2P");
  expect(batch.commit).toHaveBeenCalledOnce();
});
