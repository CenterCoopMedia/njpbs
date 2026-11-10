import { describe, expect, it } from "vitest";
import { parsePremiereConnectionCode } from "../src/lib/premiere-connection-code";

describe("Premiere connection query code", () => {
  it.each([
    ["?code=KXQR-7M2P", "KXQR-7M2P"],
    ["?code=KXQR7M2P", "KXQR-7M2P"],
    ["?code=kxqr-7m2p", "KXQR-7M2P"],
    ["?code=kxqr7m2p", "KXQR-7M2P"],
    ["?view=connect&code=ABCD-2345", "ABCD-2345"],
  ])("prefills a valid code from %s", (search, expected) => {
    expect(parsePremiereConnectionCode(search)).toBe(expected);
  });

  it.each([
    "", "?code=", "?code=garbage", "?code=KXQR-7M2", "?code=KXQR-7M2PP",
    `?code=${"A".repeat(1024)}`, "?code=IOL1-2345", "?code=KX-QR7M2P",
    "?code=KXQR--7M2P", "?code=%20KXQR-7M2P%20", "?code=%00KXQR7M2P",
    "?code=KXQR7M2P%0A", "?code=KXQR-7M2P%0D", "?code=KXQR-7M2P%0D%0A",
    "?code=%3Cscript%3Ealert(1)%3C%2Fscript%3E", "?code=%E0%A4%A",
    "?code=KXQR-7M2P&code=ABCD-2345",
  ])("ignores invalid or ambiguous input %s", search => {
    expect(parsePremiereConnectionCode(search)).toBe("");
  });
});
