import { createHash } from "node:crypto";
import input from "../../functions/lib/public-release-pair-input.js";
import { expect, it } from "vitest";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { parsePublicReleasePairRenderPlan } from "../../site/scripts/public-release-pair-render-plan";

function fixture() {
  const captured = capturedPairInput(releasePair());
  const root = { ...captured.root, entryFiles: ["render-plan.json", "snapshot.json"], files: [
    ...captured.root.files, { name: "render-plan.json", digest: "d".repeat(64), bytes: 1024,
      objectKey: "fixture", dependencies: ["context.json", "snapshot.json"] },
  ].sort((a, b) => a.name < b.name ? -1 : 1) };
  const plan = { schemaVersion: 1, pairDigest: root.pairDigest, snapshotDigest: root.scope.snapshotDigest,
    renderedAt: "2026-10-28T04:00:00.000Z", routes: [{ path: "/posts/story/", method: "GET", renderer: "post",
      inputFile: "context.json", dependencies: captured.root.files.map(file => ({ name: file.name, digest: file.digest })) }],
    expectedOutputs: [{ path: "/posts/story/", status: 200, contentType: "text/html; charset=utf-8" }] };
  return { plan, root };
}
it("binds the exact source, snapshot, frozen time, dependency closure and complete output set", () => {
  const { plan, root } = fixture();
  const parsed = parsePublicReleasePairRenderPlan(plan, root);
  expect(parsed).toEqual(plan);
  plan.routes[0].dependencies[0].digest = "f".repeat(64);
  expect(parsed.routes[0].dependencies[0].digest).toBe(root.files[0].digest);
  expect(Object.isFrozen(parsed.routes[0].dependencies)).toBe(true);
});
it.each(["unknown-plan", "unknown-route", "unknown-dependency", "unknown-output", "method", "time", "pair", "snapshot",
  "missing-file", "wrong-digest", "missing-snapshot", "duplicate-dependency", "missing-transitive", "implicit-input",
  "missing-plan-entry", "self-input", "missing-output", "wrong-output", "wrong-status", "wrong-content-type", "path", "empty", "renderer-array", "status-array"])(
  "refuses %s without falling back to defaults", mode => {
    const { plan, root } = fixture();
    const route = plan.routes[0];
    if (mode === "renderer-array") Object.assign(route, { renderer: ["post"] });
    if (mode === "status-array") Object.assign(plan.expectedOutputs[0], { status: [200] });
    if (mode === "unknown-plan") Object.assign(plan, { source: "latest" });
    if (mode === "unknown-route") Object.assign(route, { url: "https://latest.test" });
    if (mode === "unknown-dependency") Object.assign(route.dependencies[0], { optional: true });
    if (mode === "unknown-output") Object.assign(plan.expectedOutputs[0], { headers: {} });
    if (mode === "method") route.method = "POST";
    if (mode === "time") plan.renderedAt = "2026-10-28";
    if (mode === "pair") plan.pairDigest = "e".repeat(64);
    if (mode === "snapshot") plan.snapshotDigest = "e".repeat(64);
    if (mode === "missing-file") route.inputFile = "missing.json";
    if (mode === "wrong-digest") route.dependencies[0].digest = "e".repeat(64);
    if (mode === "missing-snapshot") route.dependencies.pop();
    if (mode === "duplicate-dependency") route.dependencies.push(route.dependencies[0]);
    if (mode === "missing-transitive") { route.inputFile = "snapshot.json"; route.dependencies.shift(); }
    if (mode === "implicit-input") root.files.find(file => file.name === "render-plan.json")!.dependencies.pop();
    if (mode === "missing-plan-entry") root.entryFiles.shift();
    if (mode === "self-input") route.inputFile = "render-plan.json";
    if (mode === "missing-output") plan.expectedOutputs.pop();
    if (mode === "wrong-output") plan.expectedOutputs[0].path = "/another/";
    if (mode === "wrong-status") plan.expectedOutputs[0].status = 410;
    if (mode === "wrong-content-type") plan.expectedOutputs[0].contentType = "text/plain";
    if (mode === "path") route.path = "/../";
    if (mode === "empty") { plan.routes = []; plan.expectedOutputs = []; }
    expect(() => parsePublicReleasePairRenderPlan(plan, root)).toThrow();
  });
it("requires unique sorted routes and exact withdrawal/JSON status contracts", () => {
  const { plan, root } = fixture();
  plan.routes.push({ ...plan.routes[0] }); plan.expectedOutputs.push({ ...plan.expectedOutputs[0] });
  expect(() => parsePublicReleasePairRenderPlan(plan, root)).toThrow();
  plan.routes.pop(); plan.expectedOutputs.pop();
  plan.routes[0].renderer = "withdrawal"; plan.expectedOutputs[0].status = 410;
  expect(parsePublicReleasePairRenderPlan(plan, root).expectedOutputs[0].status).toBe(410);
  plan.routes[0].renderer = "json"; plan.expectedOutputs[0].status = 200;
  plan.expectedOutputs[0].contentType = "application/json; charset=utf-8";
  expect(parsePublicReleasePairRenderPlan(plan, root).routes[0].renderer).toBe("json");
});

it.each(["snapshot", "transitive"])("checks each route's %s dependency even when another route covers the global union", mode => {
  const { plan, root } = fixture();
  plan.routes.push({ ...plan.routes[0], path: "/posts/second/", dependencies: [...plan.routes[0].dependencies] });
  plan.expectedOutputs.push({ ...plan.expectedOutputs[0], path: "/posts/second/" });
  // Keep the plan-file union unchanged through the first, complete route.
  if (mode === "snapshot") plan.routes[1].dependencies.pop();
  else { plan.routes[1].inputFile = "snapshot.json"; plan.routes[1].dependencies.shift(); }
  // Sort both descriptors by the public bytewise route order.
  plan.routes.sort((a, b) => a.path < b.path ? -1 : 1);
  plan.expectedOutputs.sort((a, b) => a.path < b.path ? -1 : 1);
  expect(() => parsePublicReleasePairRenderPlan(plan, root)).toThrow();
});
it("represents source-owned retained Post and Page aliases as explicit redirects", () => {
  const { plan, root } = fixture();
  plan.routes[0].renderer = "redirect";
  plan.expectedOutputs[0].status = 308;
  expect(parsePublicReleasePairRenderPlan(plan, root).expectedOutputs[0].status).toBe(308);
  plan.expectedOutputs[0].status = 200;
  expect(() => parsePublicReleasePairRenderPlan(plan, root)).toThrow();
});

it("accepts more than 256 frozen files through H's bounded dependency groups", () => {
  const { plan, root } = fixture(), pair = releasePair();
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const descriptor = (name: string, bytes: string, dependencies: string[]) => ({ name, digest: digest(bytes),
    bytes: Buffer.byteLength(bytes), objectKey: `release-pair-inputs/v2/${pair.pairId}/objects/${digest(bytes)}.json`, dependencies });
  const files = root.files.filter(file => file.name !== "render-plan.json");
  for (let index = 0; index < 257; index++) files.push(descriptor(`extra-${String(index).padStart(3, "0")}.json`, "{}", []));
  files.sort((a, b) => a.name < b.name ? -1 : 1);
  const names = files.map(file => file.name), groups: string[] = [];
  for (let index = 0; index < names.length; index += 128) {
    const name = `group-${index}.json`; groups.push(name);
    files.push(descriptor(name, "{}", names.slice(index, index + 128)));
  }
  files.sort((a, b) => a.name < b.name ? -1 : 1);
  plan.routes[0].dependencies = files.map(file => ({ name: file.name, digest: file.digest }));
  const planBytes = JSON.stringify(plan);
  files.push(descriptor("render-plan.json", planBytes, groups.sort()));
  files.sort((a, b) => a.name < b.name ? -1 : 1);
  const validated = input.parsePublicReleasePairInputRoot({ ...root, files }, pair);
  expect(validated.files.length).toBeGreaterThan(256);
  expect(parsePublicReleasePairRenderPlan(plan, validated).routes[0].dependencies.length).toBe(files.length - 1);
});

it("refuses the reserved private compiled graph as a rendered public route", () => {
  const { plan, root } = fixture();
  plan.routes[0].path = "/_pair-compiled/server/entry.mjs";
  plan.expectedOutputs[0].path = plan.routes[0].path;
  expect(() => parsePublicReleasePairRenderPlan(plan, root)).toThrow();
});
