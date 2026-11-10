#!/usr/bin/env node
// Seed the local emulator for media speed checks: the Admin E2E identities (a super admin
// among them), their sections, the media categories and 60 fixed media records. Emulator
// only: it refuses production credentials and any project but demo-njpbs, and it resets
// Auth and Firestore first, so it runs only with --reset.
//
//   npm run emulators:start                       # terminal 1
//   GCLOUD_PROJECT=demo-njpbs \
//   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
//   MEDIA_PERF_SEED_PASSWORD=... npm run --silent media:perf:seed -- --reset   # terminal 2
//
// Sign in as super-admin@admin-e2e.njpbs.invalid with the same password. The password comes
// only from the environment and is never printed or written.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertEmulatorEnvironment } from "./lib/admin-e2e-guard.mjs";
import {
  ADMIN_E2E_IDENTITIES,
  closeFixtureClients,
  createFixtureClients,
  resetFixtureProject,
  seedFixtureProject,
} from "./lib/admin-e2e-fixtures.mjs";
import { assertSeedPassword, mediaPerfAssets } from "./lib/media-perf-fixtures.mjs";
import { seedMediaCategories } from "./seed-media-categories.mjs";

export async function seedMediaPerfFixtures({ env = process.env, argv = process.argv.slice(2) } = {}) {
  if (!argv.includes("--reset")) {
    throw new Error("This seed clears the emulator's Auth and Firestore data. Run it with --reset.");
  }
  assertEmulatorEnvironment(env);
  const password = assertSeedPassword(env.MEDIA_PERF_SEED_PASSWORD);
  const clients = createFixtureClients();
  try {
    await resetFixtureProject();
    await seedFixtureProject({ auth: clients.auth, firestore: clients.firestore, password });
    const assets = mediaPerfAssets();
    const batch = clients.firestore.batch();
    for (const { id, data } of assets) batch.set(clients.firestore.collection("media_assets").doc(id), data);
    await batch.commit();
    const categories = await seedMediaCategories({ firestore: clients.firestore });
    const superAdmin = ADMIN_E2E_IDENTITIES.find((identity) => identity.id === "superAdmin");
    return { assets: assets.length, categories: categories.created + categories.verified, email: superAdmin.email };
  } finally {
    await closeFixtureClients(clients);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  seedMediaPerfFixtures()
    .then(({ assets, categories, email }) => {
      console.log(`Seeded ${assets} media records and ${categories} categories. Sign in as ${email}.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
