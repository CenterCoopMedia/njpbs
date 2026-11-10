import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS, RATE_POLICIES } from "../src/config";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";

afterEach(() => vi.restoreAllMocks());

function limiter(name: string) {
  return env.RATE_LIMITERS.getByName(name);
}

describe("source multipart rate policy", () => {
  it("keeps video starts on the existing upload budget", () => {
    expect(ENDPOINTS.cmsStartSourceMediaUpload.rateClass).toBe("upload");
    expect(RATE_POLICIES.upload).toEqual({
      actor: { capacity: 8, refillPerSecond: 1 / 30 },
      ip: { capacity: 32, refillPerSecond: 4 / 30 },
    });
  });

  it("gives image uploads a batch budget separate from video starts", () => {
    expect(ENDPOINTS.cmsUploadMedia.rateClass).toBe("imageUpload");
    expect(RATE_POLICIES.imageUpload).toEqual({
      actor: { capacity: 40, refillPerSecond: 1 / 3 },
      ip: { capacity: 160, refillPerSecond: 4 / 3 },
    });
  });

  it("routes transfer controls through their own budget", () => {
    for (const endpoint of [
      "cmsSignSourceMediaUploadParts",
      "cmsResumeSourceMediaUpload",
      "cmsCompleteSourceMediaUpload",
      "cmsCancelSourceMediaUpload",
    ] as const) {
      expect(ENDPOINTS[endpoint].rateClass).toBe("multipartControl");
    }
  });

  it("admits two concurrent 256 MiB upload streams without exhausting either actor bucket", async () => {
    const started = await Promise.all(
      Array.from({ length: 2 }, () =>
        limiter("two-stream-starts").consume({
          ...RATE_POLICIES.upload.actor,
          nowMs: 1_000,
        }),
      ),
    );
    // Each 256 MiB upload has 16 parts in six client batches, plus Resume and Complete.
    const controlled = await Promise.all(
      Array.from({ length: 2 * (6 + 2) }, () =>
        limiter("two-stream-controls").consume({
          ...RATE_POLICIES.multipartControl.actor,
          nowMs: 1_000,
        }),
      ),
    );

    expect(started.every((result) => result.allowed)).toBe(true);
    expect(controlled.every((result) => result.allowed)).toBe(true);
  });

  it("sustains four part-sign batches per second", async () => {
    const results = [];
    for (let second = 0; second < 60; second += 1) {
      results.push(...await Promise.all(
        Array.from({ length: 4 }, () =>
          limiter("sustained-part-signing").consume({
            ...RATE_POLICIES.multipartControl.actor,
            nowMs: 10_000 + second * 1_000,
          }),
        ),
      ));
    }

    expect(results.every((result) => result.allowed)).toBe(true);
  }, 20_000);
});

describe("image byte admission through the Worker and real limiter", () => {
  it("does not earn refill twice when an older upload resumes after a newer request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let now = 0;
    const worker = createCmsApiHandler({ now: () => now,
      verifyToken: async () => ({ uid: "interleaved-image-uploads" }),
      fetchOrigin: async () => Response.json({ success: true }),
    });
    const environment = { ...env, FIREBASE_PROJECT_ID: "demo-njpbs",
      FUNCTIONS_ORIGIN: "https://origin.example.test", CMS_EDGE_ORIGIN_SECRET: "synthetic-edge",
    } as unknown as CmsApiEnv;
    function request(body: BodyInit) {
      return new Request("https://cms-api.njpbs.org/cmsUploadMedia", {
        method: "POST", body, headers: { authorization: "Bearer synthetic-token",
          "cf-connecting-ip": "203.0.113.93", "content-type": "multipart/form-data; boundary=fixture" },
      });
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void;
    const firstRead = new Promise<void>(resolve => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; controller.enqueue(new Uint8Array(2 * 1024 * 1024)); },
      pull() { reading(); },
    });
    const older = worker.fetch(request(body), environment);
    await firstRead;
    now = 3000;
    expect((await worker.fetch(request("small"), environment)).status).toBe(200);
    controller.enqueue(new Uint8Array(2 * 1024 * 1024));
    controller.close();
    expect((await older).status).toBe(200);
    const outcomes = [];
    for (let index = 0; index < 39; index += 1) {
      outcomes.push((await worker.fetch(request("small"), environment)).status);
    }
    // 40 initial units + one refill - two units for A - one for B = 38.
    expect(outcomes.filter(status => status === 200)).toHaveLength(38);
    expect(outcomes.at(-1)).toBe(429);
  });

  it.each(["cmsUploadMedia", "cmsReplaceMediaBinary"])(
    "bounds chunked %s before forwarding and preserves a small photo batch",
    async endpoint => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const fetchOrigin = vi.fn<typeof fetch>(async (_url, init) =>
        Response.json({ received: (init?.body as ArrayBuffer).byteLength }));
      let now = 1_000;
      const worker = createCmsApiHandler({ fetchOrigin, now: () => now,
        verifyToken: async () => ({ uid: `byte-admission-${endpoint}` }) });
      const environment = { ...env, FIREBASE_PROJECT_ID: "demo-njpbs",
        FUNCTIONS_ORIGIN: "https://origin.example.test", CMS_EDGE_ORIGIN_SECRET: "synthetic-edge",
      } as unknown as CmsApiEnv;
      let cancelled = false;
      function request(bytes: number) {
        let remaining = bytes;
        return new Request(`https://cms-api.njpbs.org/${endpoint}`, {
          method: "POST",
          headers: { authorization: "Bearer synthetic-token",
            "cf-connecting-ip": endpoint === "cmsUploadMedia" ? "203.0.113.91" : "203.0.113.92",
            "content-type": "multipart/form-data; boundary=fixture" },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!remaining) { controller.close(); return; }
              const size = Math.min(remaining, 1024 * 1024);
              controller.enqueue(new Uint8Array(size));
              remaining -= size;
            },
            cancel() { cancelled = true; },
          }),
        });
      }
      // Each small photo still costs one request, preserving the 20-file form.
      for (let index = 0; index < 20; index += 1) {
        expect((await worker.fetch(request(16), environment)).status).toBe(200);
      }
      const large = await worker.fetch(request(19 * 1024 * 1024), environment);
      expect(large.status).toBe(200);
      expect(await large.json()).toEqual({ received: 19 * 1024 * 1024 });
      expect((await worker.fetch(request(18 * 1024 * 1024), environment)).status).toBe(200);
      const refused = await worker.fetch(request(5 * 1024 * 1024), environment);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("39");
      expect(refused.headers.get("x-rate-limit-scope")).toBe("actor");
      expect(cancelled).toBe(true);
      expect(fetchOrigin).toHaveBeenCalledTimes(22);
      now += Number(refused.headers.get("retry-after")) * 1000;
      expect((await worker.fetch(request(25 * 1024 * 1024), environment)).status).toBe(200);
    },
  );
});
