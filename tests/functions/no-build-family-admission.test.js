import { expect, it } from "vitest";
import familyAdmission from "../../functions/lib/no-build-family-admission.js";
import pilotAdmission from "../../functions/lib/no-build-post-admission.js";
import targets from "../../functions/lib/publication-target.js";

const record = { schemaVersion: 2, revision: 7, enabled: true,
  families: { posts: { mode: "all" } }, backgroundBucket: "private-fixture" };
const project = value => familyAdmission.projectNoBuildFamilyAdmission(value, {});
const development = targets.publicationTarget("development");

it("admits development Page selectors only with the matching target and bucket", () => {
  const value = { ...record, backgroundBucket: development.backgroundBucket,
    families: { posts: { mode: "ids", ids: ["first-post"] }, pages: { mode: "ids", ids: ["home"] } } };
  const admission = familyAdmission.projectNoBuildFamilyAdmission(value, {}, development);
  expect(admission.valid).toBe(true);
  expect(familyAdmission.admitsNoBuildPage(admission, "home")).toBe(true);
  expect(familyAdmission.admitsNoBuildPage(admission, "contact")).toBe(false);
  expect(familyAdmission.admitsNoBuildPost(admission, "first-post")).toBe(true);
  expect(familyAdmission.admitsNoBuildPost(admission, "home")).toBe(false);
  expect(project(value).valid).toBe(false);
  expect(familyAdmission.projectNoBuildFamilyAdmission(value, {}, targets.publicationTarget()).valid).toBe(false);
  expect(familyAdmission.projectNoBuildFamilyAdmission(value, {}, { ...development, projectId: "njpbs-site" }).valid).toBe(false);
  expect(familyAdmission.projectNoBuildFamilyAdmission({ ...value, backgroundBucket: "njpbs-public-artifacts" }, {}, development).valid).toBe(false);
  const paused = familyAdmission.projectNoBuildFamilyAdmission({ ...value, enabled: false }, {}, development);
  expect(familyAdmission.admitsNoBuildPage(paused, "home")).toBe(false);
  expect(familyAdmission.selectsNoBuildPage(paused, "home")).toBe(true);
});

it("admits production Pages and Home with the matching target and bucket while unsupported families stay closed", () => {
  const target = targets.publicationTarget("production");
  const value = { ...record, backgroundBucket: target.backgroundBucket,
    families: { posts: { mode: "ids", ids: ["first-post"] }, pages: { mode: "all" } } };
  const admission = familyAdmission.projectNoBuildFamilyAdmission(value, {}, target);
  expect(admission.valid).toBe(true);
  for (const id of ["home", "contact", "staff", "schedule", "live"]) expect(familyAdmission.admitsNoBuildPage(admission, id)).toBe(true);
  expect(familyAdmission.admitsNoBuildPost(admission, "home")).toBe(false);
  expect(familyAdmission.projectNoBuildFamilyAdmission({ ...value, backgroundBucket: development.backgroundBucket }, {}, target).valid).toBe(false);
  expect(familyAdmission.projectNoBuildFamilyAdmission(value, {}, { ...target, projectId: development.projectId }).valid).toBe(false);
  expect(familyAdmission.projectNoBuildFamilyAdmission({ ...value, families: { ...value.families, sponsors: { mode: "all" } } }, {}, target).valid).toBe(false);
});

it.each(["development", "production"])("selects Program/Event families only for the exact %s target", environment => {
  const target = targets.publicationTarget(environment);
  const value = { ...record, backgroundBucket: target.backgroundBucket, families: {
    posts: { mode: "ids", ids: ["post-one"] }, pages: { mode: "ids", ids: ["home"] },
    programs: { mode: "ids", ids: ["program-one"] }, events: { mode: "all" },
  } };
  const admission = familyAdmission.projectNoBuildFamilyAdmission(value, {}, target);
  expect(admission.valid).toBe(true);
  expect(familyAdmission.admitsNoBuildRecord(admission, "programs", "program-one")).toBe(true);
  expect(familyAdmission.admitsNoBuildRecord(admission, "programs", "program-two")).toBe(false);
  expect(familyAdmission.admitsNoBuildRecord(admission, "events", "event-one")).toBe(true);
  expect(familyAdmission.admitsNoBuildPost(admission, "program-one")).toBe(false);
  expect(familyAdmission.admitsNoBuildPage(admission, "home")).toBe(true);
  for (const family of ["posts", "pages", "sponsors", "newsletters", "__proto__"]) {
    expect(familyAdmission.admitsNoBuildRecord(admission, family, "program-one")).toBe(false);
  }
  const paused = familyAdmission.projectNoBuildFamilyAdmission({ ...value, enabled: false }, {}, target);
  expect(familyAdmission.selectsNoBuildRecord(paused, "programs", "program-one")).toBe(true);
  expect(familyAdmission.admitsNoBuildRecord(paused, "programs", "program-one")).toBe(false);
  for (const family of ["programs", "events"]) {
    const onlyFamily = { ...value, families: { [family]: { mode: "all" } } };
    expect(familyAdmission.projectNoBuildFamilyAdmission(onlyFamily, {}, target).valid).toBe(true);
    expect(familyAdmission.projectNoBuildFamilyAdmission({ ...onlyFamily, backgroundBucket: "foreign-bucket" }, {}, target).valid).toBe(false);
    expect(familyAdmission.projectNoBuildFamilyAdmission(onlyFamily, {}, { ...target, workerName: "foreign-worker" }).valid).toBe(false);
    for (const ids of [[], ["same", "same"], ["*"], ["cmsPosts/id"], Array(1), Array.from({ length: 101 }, (_, n) => `id-${n}`)]) {
      expect(familyAdmission.projectNoBuildFamilyAdmission({ ...value,
        families: { [family]: { mode: "ids", ids } } }, {}, target).valid).toBe(false);
    }
  }
  expect(familyAdmission.projectNoBuildFamilyAdmission({ ...value, backgroundBucket: "foreign-bucket" }, {}, target).valid).toBe(false);
  expect(familyAdmission.projectNoBuildFamilyAdmission(value, {}, { ...target, workerName: "foreign-worker" }).valid).toBe(false);
  for (const id of [undefined, "", "*", "cmsPosts/id", "a".repeat(129)]) {
    expect(familyAdmission.admitsNoBuildRecord(admission, "events", id)).toBe(false);
  }
});

it("selects only registered or minted Page IDs, including under all selection", () => {
  const admission = familyAdmission.projectNoBuildFamilyAdmission({ ...record,
    backgroundBucket: development.backgroundBucket, families: { pages: { mode: "all" } } }, {}, development);
  for (const id of ["home", "contact", "public-meetings", `page-${"a".repeat(32)}`]) {
    expect(familyAdmission.admitsNoBuildPage(admission, id)).toBe(true);
  }
  for (const id of ["unknown", "cmsPages/home", "/", "*", "__proto__", "page-short", undefined]) {
    expect(familyAdmission.admitsNoBuildPage(admission, id)).toBe(false);
  }
});

it.each([{ mode: "ids", ids: ["unknown"] }, { mode: "ids", ids: ["home", "home"] },
  { mode: "ids", ids: [] }, { mode: "ids", ids: Array(1) }, { mode: "all", ids: ["home"] },
  { mode: "ids", ids: ["cmsPages/home"] }, { mode: "all", extra: true }, null])(
  "closes malformed development Page selectors %j", pages => {
    expect(familyAdmission.projectNoBuildFamilyAdmission({ ...record,
      backgroundBucket: development.backgroundBucket, families: { pages } }, {}, development).valid).toBe(false);
  });

it("reads Page admission freshly in the caller's transaction and checks the database target", async () => {
  let value = { ...record, backgroundBucket: development.backgroundBucket, families: { pages: { mode: "all" } } };
  const paths = [];
  const firestore = { projectId: development.projectId, doc: path => ({ path }) };
  const transaction = { get: async ref => { paths.push(ref.path); return { data: () => value }; } };
  expect((await familyAdmission.readNoBuildFamilyAdmission({ firestore, transaction, env: {} })).valid).toBe(true);
  value = { ...value, enabled: false, revision: 8 };
  expect(await familyAdmission.readNoBuildFamilyAdmission({ firestore, transaction, env: {} }))
    .toMatchObject({ enabled: false, admissionRevision: 8 });
  expect(paths).toEqual([pilotAdmission.ADMISSION_PATH, pilotAdmission.ADMISSION_PATH]);
  expect((await familyAdmission.readNoBuildFamilyAdmission({
    firestore: { ...firestore, projectId: "njpbs-site" }, transaction, env: {},
  })).valid).toBe(false);
});

it("selects all valid Post IDs from the strict runtime family contract", () => {
  const admission = project(record);
  expect(admission).toEqual({ valid: true, enabled: true, families: { posts: { mode: "all" } },
    backgroundBucket: "private-fixture", admissionRevision: 7 });
  for (const id of ["first-post", "second_post", "third123", "a".repeat(128)]) {
    expect(familyAdmission.admitsNoBuildPost(admission, id)).toBe(true);
  }
  for (const id of [undefined, 123, "", "*", "cmsPosts/first-post", "a".repeat(129)]) {
    expect(familyAdmission.admitsNoBuildPost(admission, id)).toBe(false);
  }
});

it("selects only the operator's exact IDs and preserves a paused selection", () => {
  const families = { posts: { mode: "ids", ids: ["first-post", "second-post"] } };
  const admission = project({ ...record, families });
  expect(familyAdmission.admitsNoBuildPost(admission, "first-post")).toBe(true);
  expect(familyAdmission.admitsNoBuildPost(admission, "second-post")).toBe(true);
  expect(familyAdmission.admitsNoBuildPost(admission, "other-post")).toBe(false);
  const paused = project({ ...record, families, enabled: false, revision: 8 });
  expect(paused).toMatchObject({ valid: true, enabled: false, families, admissionRevision: 8 });
  expect(familyAdmission.admitsNoBuildPost(paused, "first-post")).toBe(false);
  expect(familyAdmission.admitsNoBuildPost(project({ ...record, families: {} }), "first-post")).toBe(false);
});

it("projects the retained schema-1 pilot without broadening its selection", () => {
  const pilot = { schemaVersion: 1, revision: 3, enabled: true, postId: "pilot-post", backgroundBucket: "private-fixture" };
  const admission = project(pilot);
  expect(admission).toEqual({ valid: true, enabled: true, families: { posts: { mode: "ids", ids: ["pilot-post"] } },
    backgroundBucket: "private-fixture", admissionRevision: 3 });
  expect(familyAdmission.admitsNoBuildPost(admission, "pilot-post")).toBe(true);
  expect(familyAdmission.admitsNoBuildPost(admission, "other-post")).toBe(false);
  expect(project({ ...pilot, enabled: false })).toMatchObject({ valid: true, enabled: false });
  for (const value of [undefined, null, {}, { ...pilot, extra: true }, { ...pilot, revision: 0 },
    { ...pilot, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...pilot, revision: "7" },
    { ...pilot, postId: "*" }, { ...pilot, postId: 123 }, { ...pilot, postId: "one/two" },
    { ...pilot, enabled: "true" }, { ...pilot, backgroundBucket: "https://private.example" },
    { ...pilot, backgroundBucket: 123 }, { ...pilot, schemaVersion: 2 }]) {
    expect(project(value)).toEqual({ valid: false, enabled: false, families: {},
      backgroundBucket: "", admissionRevision: null });
  }
  expect(pilotAdmission.projectNoBuildAdmission(record, {})).toEqual({ valid: false, enabled: false,
    postId: "", backgroundBucket: "", admissionRevision: null });
});

it("accepts the explicit selector bound and copies operator IDs", () => {
  const ids = Array.from({ length: 100 }, (_, n) => `post-${n}`);
  const admission = project({ ...record, families: { posts: { mode: "ids", ids } } });
  expect(familyAdmission.admitsNoBuildPost(admission, "post-99")).toBe(true);
  ids[99] = "changed-post";
  expect(familyAdmission.admitsNoBuildPost(admission, "post-99")).toBe(true);
  expect(familyAdmission.admitsNoBuildPost(admission, "changed-post")).toBe(false);
});

it("accepts a plain map with no prototype", () => {
  const families = Object.assign(Object.create(null), { posts: { mode: "all" } });
  expect(familyAdmission.admitsNoBuildPost(project({ ...record, families }), "first-post")).toBe(true);
});

it.each([undefined, null, [], {}, { ...record, schemaVersion: 3 }, { ...record, revision: 0 },
  { ...record, revision: 1.5 }, { ...record, revision: "7" }, { ...record, revision: Number.MAX_SAFE_INTEGER + 1 },
  { ...record, enabled: "true" }, { ...record, extra: true }, { ...record, postId: "pilot-post" },
  { ...record, backgroundBucket: "https://private.example.test" }, { ...record, backgroundBucket: 123 },
  { ...record, families: null }, { ...record, families: [] }, { ...record, families: Buffer.alloc(0) },
  { ...record, families: new Date("2026-10-11T00:00:00Z") }, { ...record, families: new Map() },
  { ...record, families: new Set() }, { ...record, families: { pages: { mode: "all" } } },
  { ...record, families: { posts: { mode: "all", ids: ["first-post"] } } },
  { ...record, families: { posts: { mode: "ids", ids: [] } } },
  { ...record, families: { posts: { mode: "ids", ids: ["first-post", "first-post"] } } },
  { ...record, families: { posts: { mode: "ids", ids: ["*"] } } },
  { ...record, families: { posts: { mode: "ids", ids: "first-post" } } },
  { ...record, families: { posts: { mode: "ids", ids: [123] } } },
  { ...record, families: { posts: { mode: "ids", ids: Array(1) } } },
  { ...record, families: { posts: { mode: "ids", ids: Array.from({ length: 101 }, (_, n) => `post-${n}`) } } },
  { ...record, families: { posts: { mode: "unknown" } } },
  { ...record, families: { posts: { mode: "all", extra: true } } },
  { ...record, families: { posts: null } }])("closes malformed family admission %j", value => {
  const admission = project(value);
  expect(admission).toEqual({ valid: false, enabled: false, families: {}, backgroundBucket: "", admissionRevision: null });
  expect(familyAdmission.admitsNoBuildPost(admission, "first-post")).toBe(false);
});

it.each(["NO_BUILD_POST_ENABLED", "NO_BUILD_POST_ID", "NO_BUILD_POST_BACKGROUND_BUCKET"])(
  "requires removal of legacy %s before schema 2 and preserves the schema-1 fence", name => {
    const value = { NO_BUILD_POST_ENABLED: "true", NO_BUILD_POST_ID: "pilot-post", NO_BUILD_POST_BACKGROUND_BUCKET: "private-fixture" }[name];
    expect(familyAdmission.projectNoBuildFamilyAdmission(record, { [name]: value }).valid).toBe(false);
    expect(familyAdmission.projectNoBuildFamilyAdmission(record, { [name]: "" }).valid).toBe(false);
    const pilot = { schemaVersion: 1, revision: 3, enabled: true, postId: "pilot-post", backgroundBucket: "private-fixture" };
    expect(familyAdmission.projectNoBuildFamilyAdmission(pilot, { [name]: value }).valid).toBe(true);
    expect(familyAdmission.projectNoBuildFamilyAdmission(pilot, { [name]: "wrong" }).valid).toBe(false);
    const legacy = { NO_BUILD_POST_ENABLED: "true", NO_BUILD_POST_ID: "pilot-post", NO_BUILD_POST_BACKGROUND_BUCKET: "private-fixture" };
    expect(pilotAdmission.projectNoBuildAdmission(pilot, legacy).valid).toBe(true);
    expect(pilotAdmission.projectNoBuildAdmission(pilot, { ...legacy, [name]: "" }))
      .toMatchObject({ valid: false, enabled: false });
  });
