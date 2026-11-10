import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import {
  seedContentSections,
  verifyContentSectionsRegistered,
} from "../../scripts/seed-content-sections.mjs";
import {
  backfillRecordSections,
  parseSectionMapping,
} from "../../scripts/backfill-record-sections.mjs";
import { PUBLIC_PAGE_IDS } from "../../packages/content-core/src/public-pages";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const NOW = "2026-08-21T02:00:00.000Z";

let db;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("content-section-seed.test.js");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

async function auditActions() {
  const snapshot = await db.collection("admin_logs").get();
  return snapshot.docs.map((doc) => doc.data());
}

describe("content section registry seed", () => {
  it("creates the five seeded areas with an audit row each", async () => {
    await expect(
      seedContentSections({ firestore: db, nowIso: NOW }),
    ).resolves.toMatchObject({
      sectionsCreated: 5,
      sectionsVerified: 0,
      pagesStamped: 0,
      pagesVerified: 0,
      pagesAbsent: PUBLIC_PAGE_IDS.length,
    });

    const registry = await db.collection("sections").get();
    expect(registry.docs.map((doc) => doc.id).sort()).toEqual([
      "compliance",
      "news",
      "station",
      "support",
      "watch",
    ]);
    expect(registry.docs.find((doc) => doc.id === "watch").data()).toMatchObject({
      id: "watch",
      label: "Watch",
      order: 1,
      createdAt: NOW,
      createdBy: "system:content-section-seed",
    });

    const logs = await auditActions();
    expect(logs).toHaveLength(5);
    expect(logs.every((entry) => entry.action === "section.registry_seed")).toBe(true);
    expect(logs.every((entry) => entry.actorUid === "system:content-section-seed")).toBe(
      true,
    );
  });

  it("is idempotent: a second run verifies instead of rewriting", async () => {
    await seedContentSections({ firestore: db, nowIso: NOW });
    await expect(
      seedContentSections({ firestore: db, nowIso: NOW }),
    ).resolves.toMatchObject({ sectionsCreated: 0, sectionsVerified: 5 });
    expect(await auditActions()).toHaveLength(5);
  });

  it("stamps a stored canonical page with its public-page area, not its template", async () => {
    // give and faq share the programLanding/genericPage templates with pages in other
    // desks, so a template-derived section would put them in the wrong place.
    await db.collection("cmsPages").doc("give").set({ id: "give", title: "Give" });
    await db.collection("cmsPages").doc("faq").set({ id: "faq", title: "FAQ" });
    await db.collection("cmsPages").doc("eeo").set({ id: "eeo", title: "EEO" });

    const result = await seedContentSections({ firestore: db, nowIso: NOW });
    expect(result).toMatchObject({
      pagesStamped: 3,
      pagesVerified: 0,
      pagesAbsent: PUBLIC_PAGE_IDS.length - 3,
    });

    const give = (await db.collection("cmsPages").doc("give").get()).data();
    const faq = (await db.collection("cmsPages").doc("faq").get()).data();
    const eeo = (await db.collection("cmsPages").doc("eeo").get()).data();
    expect(give.section).toBe("support");
    expect(faq.section).toBe("support");
    expect(eeo.section).toBe("compliance");
    expect(give.updatedBy).toBe("system:content-section-seed");

    const backfills = (await auditActions()).filter(
      (entry) => entry.action === "content.section_backfill",
    );
    expect(backfills).toHaveLength(3);
    expect(backfills.map((entry) => entry.target).sort()).toEqual([
      "cmsPages/eeo",
      "cmsPages/faq",
      "cmsPages/give",
    ]);
  });

  it("verifies an already-stamped page and refuses one stored in a different desk", async () => {
    await db.collection("cmsPages").doc("give").set({ id: "give", section: "support" });
    await expect(
      seedContentSections({ firestore: db, nowIso: NOW }),
    ).resolves.toMatchObject({ pagesStamped: 0, pagesVerified: 1 });

    await db.collection("cmsPages").doc("about").set({ id: "about", section: "watch" });
    await expect(seedContentSections({ firestore: db, nowIso: NOW })).rejects.toThrow(
      /Page about is stored in section watch, not station/,
    );
  });

  it("leaves legacy template singletons unsectioned", async () => {
    // programLanding is a template id, not a public page id, so the seed never touches it.
    await db
      .collection("cmsPages")
      .doc("programLanding")
      .set({ id: "programLanding", title: "Legacy template seed" });

    await seedContentSections({ firestore: db, nowIso: NOW });

    const legacy = (await db.collection("cmsPages").doc("programLanding").get()).data();
    expect(legacy.section).toBeUndefined();
  });

  it("verifies the registry is readable after the seed commits", async () => {
    // The deploy step needs this second fact, not just a committed write: a record create
    // fails closed against the live collection, so functions activated over an empty
    // registry refuse every create and reject every scoped grant.
    await seedContentSections({ firestore: db, nowIso: NOW });

    await expect(
      verifyContentSectionsRegistered({ firestore: db }),
    ).resolves.toEqual({ registered: 5 });
  });

  it("fails loudly when the registry is empty or a desk is missing", async () => {
    await expect(
      verifyContentSectionsRegistered({ firestore: db }),
    ).rejects.toThrow(/missing watch, support, station, compliance/);

    await seedContentSections({ firestore: db, nowIso: NOW });
    await db.collection("sections").doc("compliance").delete();

    await expect(
      verifyContentSectionsRegistered({ firestore: db }),
    ).rejects.toThrow(/missing compliance/);
  });

  it("refuses a bad client or timestamp before touching Firestore", async () => {
    await expect(seedContentSections({ firestore: null })).rejects.toThrow(
      /Firestore Admin client is required/,
    );
    await expect(
      seedContentSections({ firestore: db, nowIso: "not-a-date" }),
    ).rejects.toThrow(/timestamp is invalid/);
  });
});

describe("record section backfill", () => {
  async function storeRecords(ids) {
    await Promise.all(
      ids.map((id) =>
        db.collection("cmsPosts").doc(id).set({ id, type: "article", title: id }),
      ),
    );
  }

  it("stamps records only from the explicit mapping", async () => {
    await seedContentSections({ firestore: db, nowIso: NOW });
    await storeRecords(["story-1", "story-2"]);

    const mapping = parseSectionMapping({ "story-1": "watch", "story-2": "compliance" });
    await expect(
      backfillRecordSections({ firestore: db, mapping, nowIso: NOW }),
    ).resolves.toEqual({ stamped: 2, verified: 0 });

    expect((await db.collection("cmsPosts").doc("story-1").get()).data().section).toBe(
      "watch",
    );
    expect((await db.collection("cmsPosts").doc("story-2").get()).data().section).toBe(
      "compliance",
    );
    const logs = (await auditActions()).filter(
      (entry) => entry.action === "content.section_backfill",
    );
    expect(logs.map((entry) => entry.target).sort()).toEqual([
      "cmsPosts/story-1",
      "cmsPosts/story-2",
    ]);
  });

  it("fails loudly and writes nothing when a stored record is unmapped", async () => {
    await seedContentSections({ firestore: db, nowIso: NOW });
    await storeRecords(["story-1", "story-2", "story-3"]);

    const mapping = parseSectionMapping({ "story-1": "watch" });
    await expect(
      backfillRecordSections({ firestore: db, mapping, nowIso: NOW }),
    ).rejects.toThrow(/missing 2 stored record\(s\): story-2, story-3/);

    // The refusal is the whole point: a partial migration that guessed for the rest
    // would be worse than not running.
    expect((await db.collection("cmsPosts").doc("story-1").get()).data().section).toBeUndefined();
  });

  it("refuses a mapping that names a section outside the registry", async () => {
    await seedContentSections({ firestore: db, nowIso: NOW });
    await storeRecords(["story-1"]);

    const mapping = parseSectionMapping({ "story-1": "unregistered" });
    await expect(
      backfillRecordSections({ firestore: db, mapping, nowIso: NOW }),
    ).rejects.toThrow(/not in the registry: unregistered/);
  });

  it("verifies a record already in its mapped desk and refuses a silent move", async () => {
    await seedContentSections({ firestore: db, nowIso: NOW });
    await db
      .collection("cmsPosts")
      .doc("story-1")
      .set({ id: "story-1", type: "article", section: "watch" });

    await expect(
      backfillRecordSections({
        firestore: db,
        mapping: parseSectionMapping({ "story-1": "watch" }),
        nowIso: NOW,
      }),
    ).resolves.toEqual({ stamped: 0, verified: 1 });

    await expect(
      backfillRecordSections({
        firestore: db,
        mapping: parseSectionMapping({ "story-1": "support" }),
        nowIso: NOW,
      }),
    ).rejects.toThrow(/story-1 \(stored watch, mapped support\)/);
  });

  it("rejects a malformed mapping file before it reaches Firestore", () => {
    expect(() => parseSectionMapping(null)).toThrow(/must be an object/);
    expect(() => parseSectionMapping([])).toThrow(/must be an object/);
    expect(() => parseSectionMapping({ "story-1": "" })).toThrow(/invalid section id/);
    expect(() => parseSectionMapping({ "story-1": " watch" })).toThrow(
      /invalid section id/,
    );
    expect(() => parseSectionMapping({ "story-1": 5 })).toThrow(/invalid section id/);
  });
});
