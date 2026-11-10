// Multi-role browser proof for section-scoped content enforcement (#845).
//
// Drives the real Admin app against the emulator suite as four different people and
// records what each one can actually see and do. Screenshots and an assertion transcript
// land beside this file. Run `node proof/seed.mjs` first, with the emulators and
// `cd admin && npm run dev` already running.

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const APP = "http://localhost:5173";
const FUNCTIONS = "http://127.0.0.1:5001/demo-njpbs/us-central1";
const PASSWORD = "proof-password-1";

const transcript = [];
let failures = 0;

function record(name, actual, expected, note) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  transcript.push(
    `${pass ? "PASS" : "FAIL"}  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}${note ? `\n        note:     ${note}` : ""}`,
  );
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
}

async function signIn(page, email) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await page.waitForSelector("nav[aria-label='Primary']", { timeout: 30000 });
}

async function signOut(page) {
  const out = page.getByRole("button", { name: "Sign out" }).first();
  if (await out.count()) {
    await out.click();
    await page.waitForSelector("text=Sign in to NJ PBS Admin", { timeout: 30000 });
  }
}

async function callAs(page, fn, body) {
  return page.evaluate(
    async ([base, name, payload]) => {
      const request = window.__njpbsProofToken;
      const response = await fetch(`${base}/${name}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${request}`,
          "X-NJPBS-CMS-Edge": "local-cms-edge-only",
        },
        body: JSON.stringify(payload),
      });
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
    [FUNCTIONS, fn, body],
  );
}

// The signed-in person's own ID token, taken from the app's live Firebase auth instance
// through the Vite dev server's module graph. This is the same token the app sends, so
// every assertion below is made as exactly this person rather than as a fabricated
// principal.
async function captureToken(page) {
  await page.waitForFunction(
    async () => {
      const { auth } = await import("/src/lib/firebase.ts");
      if (!auth.currentUser) return false;
      window.__njpbsProofToken = await auth.currentUser.getIdToken();
      return true;
    },
    null,
    { timeout: 30000, polling: 500 },
  );
}

const browser = await chromium.launch({ channel: "chrome",
  chromiumSandbox: true,
});

async function withPerson(email, label, run) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await signIn(page, email);
    await captureToken(page);
    await run(page, label);
  } finally {
    await signOut(page).catch(() => {});
    await context.close();
  }
}

const shot = (page, name) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

// --- 1. Super admin: the whole library, every desk -------------------------------------
await withPerson("super@njpbs.test", "super admin", async (page) => {
  const list = await callAs(page, "cmsListContent", { query: "v=1" });
  const ids = (list.body?.records ?? []).map((row) => row.id).sort();
  record("super admin lists every record, in every desk and none", ids, [
    "proof-legacy-1",
    "proof-own-in-desk",
    "proof-own-out-of-desk",
    "proof-station-1",
    "proof-watch-1",
  ]);
  await page.goto(`${APP}/content/library`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await shot(page, "01-super-admin-library");
});

// --- 2. Site-wide editor: unchanged by section enforcement -----------------------------
await withPerson("sitewide@njpbs.test", "site-wide editor", async (page) => {
  const list = await callAs(page, "cmsListContent", { query: "v=1" });
  const ids = (list.body?.records ?? []).map((row) => row.id).sort();
  record("site-wide editor still lists every record, sectioned or not", ids, [
    "proof-legacy-1",
    "proof-own-in-desk",
    "proof-own-out-of-desk",
    "proof-station-1",
    "proof-watch-1",
  ]);

  const readStation = await callAs(page, "cmsGetContent", {
    collection: "cmsPosts",
    id: "proof-station-1",
  });
  record("site-wide editor reads a station record", readStation.status, 200);

  const readLegacy = await callAs(page, "cmsGetContent", {
    collection: "cmsPosts",
    id: "proof-legacy-1",
  });
  record("site-wide editor reads an unsectioned record", readLegacy.status, 200);

  // Authorization passes for a site-wide grant, so the create requirement itself is what
  // refuses a record that names no desk.
  const createNoDesk = await callAs(page, "cmsSaveContent", {
    collection: "cmsPosts",
    document: { type: "post", title: "Should never exist", date: "2026-08-21", tags: [], blocks: [] },
  });
  record("a create naming no desk is refused even site-wide", createNoDesk.status, 400);
  record(
    "and it says why",
    createNoDesk.body?.error,
    "A new record requires a section",
  );

  await page.goto(`${APP}/content/library`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await shot(page, "02-sitewide-editor-library");
});

// --- 3. Watch-scoped editor: their desk and nothing else -------------------------------
await withPerson("watch@njpbs.test", "watch-scoped editor", async (page) => {
  const list = await callAs(page, "cmsListContent", { query: "v=1" });
  const ids = (list.body?.records ?? []).map((row) => row.id).sort();
  record(
    "watch-scoped editor lists only watch-desk records",
    ids,
    ["proof-own-in-desk", "proof-watch-1"],
    "station and unsectioned records are absent, including one owned by somebody else",
  );

  record("watch-scoped editor reads a watch record", (
    await callAs(page, "cmsGetContent", { collection: "cmsPosts", id: "proof-watch-1" })
  ).status, 200);

  record("watch-scoped editor is refused a station record", (
    await callAs(page, "cmsGetContent", { collection: "cmsPosts", id: "proof-station-1" })
  ).status, 403);

  record("watch-scoped editor is refused an unsectioned record", (
    await callAs(page, "cmsGetContent", { collection: "cmsPosts", id: "proof-legacy-1" })
  ).status, 403);

  // Writes follow the same desk.
  const editWatch = await callAs(page, "cmsSaveContent", {
    collection: "cmsPosts",
    id: "proof-watch-1",
    baseVersion: 1,
    document: { title: "Watch desk draft, edited by the watch editor" },
  });
  record("watch-scoped editor saves a watch record", editWatch.status, 200);

  const editStation = await callAs(page, "cmsSaveContent", {
    collection: "cmsPosts",
    id: "proof-station-1",
    baseVersion: 1,
    document: { title: "Should never land" },
  });
  record("watch-scoped editor is refused a station save", editStation.status, 403);

  const editLegacy = await callAs(page, "cmsSaveContent", {
    collection: "cmsPosts",
    id: "proof-legacy-1",
    baseVersion: 1,
    document: { title: "Should never land" },
  });
  record("watch-scoped editor is refused an unsectioned save", editLegacy.status, 403);

  // Revisions follow the record.
  record("watch-scoped editor lists a watch record's history", (
    await callAs(page, "cmsListRevisions", { collection: "cmsPosts", id: "proof-watch-1" })
  ).status, 200);
  record("watch-scoped editor is refused a station record's history", (
    await callAs(page, "cmsListRevisions", { collection: "cmsPosts", id: "proof-station-1" })
  ).status, 403);

  // Pages take their desk from the public area.
  record("watch-scoped editor reads the /watch/ page", (
    await callAs(page, "cmsGetContent", { collection: "cmsPages", id: "watch" })
  ).status, 200);
  record("watch-scoped editor is refused the /support/ page", (
    await callAs(page, "cmsGetContent", { collection: "cmsPages", id: "support" })
  ).status, 403);

  // Creates name a desk, and only one they hold.
  const createWatch = await callAs(page, "cmsSaveContent", {
    collection: "cmsPosts",
    section: "watch",
    document: { type: "post", title: "Created by the watch editor", date: "2026-08-21", tags: [], blocks: [] },
  });
  record("watch-scoped editor creates into their own desk", createWatch.status, 200);
  record(
    "the created record carries that desk",
    createWatch.body?.document?.section,
    "watch",
  );

  const createStation = await callAs(page, "cmsSaveContent", {
    collection: "cmsPosts",
    section: "station",
    document: { type: "post", title: "Should never exist", date: "2026-08-21", tags: [], blocks: [] },
  });
  record("watch-scoped editor cannot create into another desk", createStation.status, 403);

  const createNoDesk = await callAs(page, "cmsSaveContent", {
    collection: "cmsPosts",
    document: { type: "post", title: "Should never exist", date: "2026-08-21", tags: [], blocks: [] },
  });
  record(
    "a scoped create naming no desk is refused at authorization",
    createNoDesk.status,
    403,
    "the resource states no section, so the scoped grant matches nothing; the create requirement never has to fire",
  );

  // The browser surfaces.
  await page.goto(`${APP}/content/library`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await shot(page, "03-watch-editor-library");

  await page.goto(`${APP}/content/post/+`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("select#record-post-section", { timeout: 30000 });
  const options = await page.$$eval("select#record-post-section option", (nodes) =>
    nodes.map((node) => node.value),
  );
  record(
    "the create form offers the registry desks with an unchosen default",
    options,
    ["", "watch", "support", "station", "compliance", "newsroom"],
    "newsroom is registered only in Firestore and appears in no seed table, so the picker " +
      "can only offer it by reading the live registry",
  );
  await shot(page, "04-watch-editor-create-form-section-picker");

  await page.goto(`${APP}/content/post/proof-station-1/edit`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(3000);
  await shot(page, "05-watch-editor-refused-station-record");

  await page.goto(`${APP}/content/post/proof-watch-1/edit`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(3000);
  await shot(page, "06-watch-editor-opens-watch-record");
});

// --- 4. Watch-scoped contributor: their own work, inside their desk --------------------
await withPerson("contributor@njpbs.test", "watch-scoped contributor", async (page) => {
  const list = await callAs(page, "cmsListContent", { query: "v=1" });
  const ids = (list.body?.records ?? []).map((row) => row.id).sort();
  record(
    "watch-scoped contributor lists only their own watch-desk work",
    ids,
    ["proof-own-in-desk"],
    "their own station draft is excluded: ownership does not punch through the scope",
  );

  record("contributor is refused their own out-of-desk draft", (
    await callAs(page, "cmsGetContent", {
      collection: "cmsPosts",
      id: "proof-own-out-of-desk",
    })
  ).status, 403);

  record("contributor reads their own in-desk draft", (
    await callAs(page, "cmsGetContent", { collection: "cmsPosts", id: "proof-own-in-desk" })
  ).status, 200);

  record("contributor is refused a watch record they do not own", (
    await callAs(page, "cmsGetContent", { collection: "cmsPosts", id: "proof-watch-1" })
  ).status, 403);

  await page.goto(`${APP}/content/library`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await shot(page, "07-watch-contributor-library");
});

await browser.close();

const header = [
  "Section-scoped content enforcement (#845) -- multi-role emulator proof",
  `run at ${new Date().toISOString()}`,
  "",
  "Four people signed in to the real Admin app against the Firebase emulator suite.",
  "Each assertion below was made with that person's own signed-in ID token against the",
  "same authenticated function boundary the app calls.",
  "",
];
const footer = ["", `${transcript.length} assertions, ${failures} failed.`];
writeFileSync(
  join(HERE, "assertions.txt"),
  [...header, ...transcript, ...footer].join("\n") + "\n",
);
console.log(`\n${transcript.length} assertions, ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
