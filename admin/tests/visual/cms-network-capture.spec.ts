import { test, expect } from "./fixtures";
import { createCmsNetworkCapture } from "../../../scripts/lib/cms-network-capture.cjs";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

for (const startInCapture of [false, true]) {
  test(`separates a response started in ${startInCapture ? "an earlier capture" : "preparation"}`, async ({
    page,
  }) => {
    await page.route("https://api.example.org/fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Network fixture</title>",
      }),
    );
    await page.goto("https://api.example.org/fixture");
    const network = createCmsNetworkCapture(page);
    if (startInCapture) network.start();
    const held = deferred();
    const arrived = deferred();
    await page.route("**/cmsListMedia", async (route) => {
      arrived.resolve();
      await held.promise;
      await route.fulfill({ contentType: "application/json", body: "{}" });
    });
    await page.evaluate(() => {
      void fetch("/cmsListMedia");
    });
    await arrived.promise;
    if (startInCapture) await network.finish();
    network.start();
    const completed = page.waitForEvent(
      "requestfinished",
      (request) => new URL(request.url()).pathname === "/cmsListMedia",
    );
    held.resolve();
    await completed;
    const result = await network.finish();
    expect(result.captureEpoch).toBe(startInCapture ? 2 : 1);
    expect(result.calls).toEqual([]);
    expect(result.carryInCalls).toEqual([
      expect.objectContaining({
        endpoint: "/cmsListMedia",
        requestEpoch: startInCapture ? 1 : 0,
        status: 200,
        serverTiming: null,
      }),
    ]);
  });
}

test("records a current request and numeric server timing without descriptions", async ({
  page,
}) => {
  await page.route("https://api.example.org/fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Network fixture</title>",
    }),
  );
  await page.goto("https://api.example.org/fixture");
  const network = createCmsNetworkCapture(page);
  await page.route("**/cmsListMedia", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: "{}",
      headers: {
        "server-timing":
          'query;desc="discard , injected;dur=999";DuR=12.5, auth;desc="discard; this";dur="2"',
      },
    }),
  );
  network.start();
  const completed = page.waitForEvent(
    "requestfinished",
    (request) => new URL(request.url()).pathname === "/cmsListMedia",
  );
  await page.evaluate(async () => {
    await (await fetch("/cmsListMedia")).text();
  });
  await completed;
  const result = await network.finish();
  expect(result.captureEpoch).toBe(1);
  expect(result.carryInCalls).toEqual([]);
  expect(result.calls).toEqual([
    expect.objectContaining({
      endpoint: "/cmsListMedia",
      requestEpoch: 1,
      status: 200,
      serverTiming: [
        { name: "query", durationMs: 12.5 },
        { name: "auth", durationMs: 2 },
      ],
    }),
  ]);
});
