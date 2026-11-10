// Fixed media records for local speed checks (media library phase 2). The same 60 records
// every run, so a before and an after sample on the emulator compare like with like. URLs
// use the reserved .invalid domain: images never load, and no request leaves the machine.

export const MEDIA_PERF_ASSET_COUNT = 60;
export const MEDIA_PERF_CATEGORY_IDS = Object.freeze(["general", "news", "programs", "education"]);
const TIMESTAMP_BASE = Date.parse("2026-09-01T12:00:00.000Z");
const ACTOR = "admin-e2e-super-admin";
const SUBJECTS = Object.freeze([
  "Statehouse dome at dusk", "Offshore wind turbines", "Classroom desk", "Hoboken storefronts",
  "Rowhouse framing", "Election desk map", "Studio camera", "Assembly chamber",
  "NJ Transit platform", "Budget briefing notes",
]);

export function mediaPerfAssets({ count = MEDIA_PERF_ASSET_COUNT } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    const id = `perf-media-${number}`;
    const document = index % 10 === 9;
    const category = MEDIA_PERF_CATEGORY_IDS[index % MEDIA_PERF_CATEGORY_IDS.length];
    const at = new Date(TIMESTAMP_BASE + index * 3_600_000).toISOString();
    return {
      id,
      data: {
        name: `${SUBJECTS[index % SUBJECTS.length]} ${number}`,
        originalName: `${id}.${document ? "pdf" : "jpg"}`,
        category,
        categories: [category],
        tags: ["speed-check", category],
        description: "Local speed-check record.",
        altText: document ? null : "Local speed-check image.",
        license: null,
        credit: "NJ PBS",
        mimeType: document ? "application/pdf" : "image/jpeg",
        kind: document ? "document" : "image",
        sizeBytes: 200_000 + index * 1_000,
        width: document ? null : 2400,
        height: document ? null : 1600,
        url: `https://media.invalid/perf/${id}.${document ? "pdf" : "jpg"}`,
        source: "upload",
        lifecycle: "active",
        version: 1,
        createdAt: at,
        createdBy: ACTOR,
        updatedAt: at,
        updatedBy: ACTOR,
      },
    };
  });
}

export function assertSeedPassword(value) {
  if (typeof value !== "string" || value === "") {
    throw new Error("Set MEDIA_PERF_SEED_PASSWORD in the environment; the seed never invents or prints one.");
  }
  if (value.length < 20) throw new Error("MEDIA_PERF_SEED_PASSWORD must be at least 20 characters.");
  return value;
}
