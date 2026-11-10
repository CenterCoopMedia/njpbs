import { expect, it } from "vitest";
import { assertPublicReleasePairAuthorAdapter } from "../../site/scripts/public-release-pair-aggregate-outputs";
it("admits only the exact derived canonical, alias and withdrawal fallbacks", () => {
  const paths = ["/authors/ada/index.html", "/authors/ada-old/index.html", "/authors/retired/index.html"];
  expect(() => assertPublicReleasePairAuthorAdapter(paths, new Set(["/authors/ada/", "/authors/ada-old/", "/authors/retired/"]))).not.toThrow();
  expect(() => assertPublicReleasePairAuthorAdapter(paths, new Set(["/authors/ada/", "/authors/ada-old/"])))
    .toThrowError(expect.objectContaining({ reason: "pair-author-adapter-unavailable" }));
});
it.each(["/authors/unknown/index.html", "/authors/ada/extra.html", "/authors/index.html"])("never grants author wildcard coverage for %s", path => {
  expect(() => assertPublicReleasePairAuthorAdapter([path], new Set(["/authors/ada/"])))
    .toThrowError(expect.objectContaining({ reason: "pair-author-adapter-unavailable" }));
});
