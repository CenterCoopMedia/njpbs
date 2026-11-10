import { describe, expect, it } from "vitest";
import { extractPartnerPlayerSrc } from "../../packages/content-core/src/partner-player";

describe("PBS Partner Player source validation", () => {
  it("resolves the protocol-relative, single-quoted iframe shape from #3499 as HTTPS", () => {
    const playerCode = "<iframe width='512' height='288' src='//player.pbs.org/partnerplayer/3114511752/?start=0&end=0&topbar=false&endscreen=true&autoplay=false&muted=true&tracking=discard' frameborder='0' allowfullscreen></iframe>";
    expect(extractPartnerPlayerSrc(playerCode)).toBe(
      "https://player.pbs.org/partnerplayer/3114511752/?start=0&end=0&topbar=false&endscreen=true&autoplay=false&muted=true",
    );
  });

  it.each([
    "//evil.example/partnerplayer/x/",
    "//player.pbs.org.evil.example/partnerplayer/x/",
    "http://player.pbs.org/partnerplayer/x/",
    `//fixture-user:fixture-password@${"player.pbs.org"}/partnerplayer/x/`,
    "//player.pbs.org:8443/partnerplayer/x/",
    "//player.pbs.org/partnerplayer/bad%22id/",
  ])("rejects an unapproved source: %s", source => {
    expect(extractPartnerPlayerSrc(source)).toBeNull();
    expect(extractPartnerPlayerSrc(`<iframe src='${source}'></iframe>`)).toBeNull();
  });
});
