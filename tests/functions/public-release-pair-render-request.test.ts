import { expect, it } from "vitest";
import { parsePublicReleasePairRenderRequest } from "../../site/scripts/public-release-pair-render-request";
const route = { path: "/", method: "GET" as const, renderer: "page" as const, inputFile: "read.json",
  dependencies: [{ name: "home.json", digest: "a".repeat(64) }, { name: "image.json", digest: "b".repeat(64) }] };
const request = () => ({ schemaVersion: 1, read: { kind: "published-page" }, homeSourcesFile: "home.json", resources: [
  { url: "https://media.example.test/image.png", file: "image.json", contentType: "image/png" }] });
it("permits only named frozen provider and resource files", () => {
  expect(parsePublicReleasePairRenderRequest(request(), route)).toEqual(request());
});
it.each(["unknown", "schema", "home", "resource-file", "duplicate", "credentials", "http", "unknown-resource"])("refuses %s", mode => {
  const value = request();
  if (mode === "unknown") Object.assign(value, { latest: true });
  if (mode === "schema") value.schemaVersion = 2;
  if (mode === "home") value.homeSourcesFile = "missing.json";
  if (mode === "resource-file") value.resources[0].file = "missing.json";
  if (mode === "duplicate") value.resources.push({ ...value.resources[0] });
  if (mode === "credentials") value.resources[0].url = "https://name:pass@media.example.test/image.png";
  if (mode === "http") value.resources[0].url = "http://media.example.test/image.png";
  if (mode === "unknown-resource") Object.assign(value.resources[0], { fallback: true });
  expect(() => parsePublicReleasePairRenderRequest(value, route)).toThrow();
});
