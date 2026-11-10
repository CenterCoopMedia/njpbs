import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const INVENTORY_PROJECT_ID = "njpbs-site";
export const INVENTORY_COLLECTION = "cmsPosts";
export const INVENTORY_PROJECTION = Object.freeze([
  "title",
  "status",
  "version",
  "deleted",
]);
export const ARTICLE_FETCH_CAP = 10;
export const DUPLICATE_POST_FETCH_CAP = 5;

const MAX_DOCUMENT_ID_BYTES = 1_500;
const MAX_TITLE_BYTES = 500;
const MAX_STATUS_BYTES = 64;
const GENERIC_FAILURE = "The read-only Article and Post inventory failed.";

class InventoryRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "InventoryRefusal";
  }
}

function boundedNonemptyString(value, maxBytes) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function boundedRecord(document) {
  const data = document?.data?.();
  if (
    !boundedNonemptyString(document?.id, MAX_DOCUMENT_ID_BYTES) ||
    !data ||
    typeof data !== "object" ||
    !boundedNonemptyString(data.title, MAX_TITLE_BYTES) ||
    !boundedNonemptyString(data.status, MAX_STATUS_BYTES) ||
    !Number.isSafeInteger(data.version) ||
    data.version < 1 ||
    (data.deleted !== undefined && typeof data.deleted !== "boolean")
  ) {
    throw new InventoryRefusal(
      "A projected record has invalid bounded inventory fields.",
    );
  }
  return {
    id: document.id,
    title: data.title,
    status: data.status,
    version: data.version,
    deleted: data.deleted === true,
  };
}

function aggregateCount(snapshot) {
  const count = snapshot?.data?.()?.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new InventoryRefusal("A content count response was invalid.");
  }
  return count;
}

async function exactTypeCount(reader, collection, type) {
  const snapshot = await reader.get(
    collection.where("type", "==", type).count(),
  );
  return aggregateCount(snapshot);
}

async function exactTitlePostDuplicates(reader, collection, article) {
  const snapshot = await reader.get(
    collection
      .where("type", "==", "post")
      .where("title", "==", article.title)
      .select(...INVENTORY_PROJECTION)
      .limit(DUPLICATE_POST_FETCH_CAP + 1),
  );
  if (!Array.isArray(snapshot?.docs)) {
    throw new InventoryRefusal("An exact-title Post query response was invalid.");
  }
  if (snapshot.docs.length > DUPLICATE_POST_FETCH_CAP) {
    throw new InventoryRefusal(
      "An exact-title Post duplicate count exceeds the read-only inventory cap.",
    );
  }
  const duplicates = snapshot.docs.map(boundedRecord);
  if (duplicates.some((duplicate) => duplicate.title !== article.title)) {
    throw new InventoryRefusal("An exact-title Post query response was invalid.");
  }
  return duplicates.sort((left, right) => left.id.localeCompare(right.id));
}

export async function collectArticlePostInventory({
  firestore,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    throw new InventoryRefusal("A Firestore read client is required.");
  }
  if (
    typeof generatedAt !== "string" ||
    !Number.isFinite(Date.parse(generatedAt)) ||
    new Date(generatedAt).toISOString() !== generatedAt
  ) {
    throw new InventoryRefusal("The inventory timestamp must be a canonical ISO instant.");
  }

  return firestore.runTransaction(async (reader) => {
    if (!reader || typeof reader.get !== "function") {
      throw new InventoryRefusal("A Firestore transaction reader is required.");
    }

    const collection = firestore.collection(INVENTORY_COLLECTION);
    const articleCount = await exactTypeCount(reader, collection, "article");
    const postCount = await exactTypeCount(reader, collection, "post");
    if (articleCount > ARTICLE_FETCH_CAP) {
      throw new InventoryRefusal(
        "The Article count exceeds the read-only inventory cap.",
      );
    }

    const articleSnapshot = await reader.get(
      collection
        .where("type", "==", "article")
        .select(...INVENTORY_PROJECTION)
        .limit(ARTICLE_FETCH_CAP + 1),
    );
    if (!Array.isArray(articleSnapshot?.docs)) {
      throw new InventoryRefusal("The Article projection response was invalid.");
    }
    if (articleSnapshot.docs.length > ARTICLE_FETCH_CAP) {
      throw new InventoryRefusal(
        "The Article projection exceeds the read-only inventory cap.",
      );
    }
    if (articleSnapshot.docs.length !== articleCount) {
      throw new InventoryRefusal(
        "The Article count and projection disagree. Run the inventory again before planning a migration.",
      );
    }

    const articles = articleSnapshot.docs
      .map(boundedRecord)
      .sort((left, right) => left.id.localeCompare(right.id));
    const articlesWithDuplicates = [];
    for (const article of articles) {
      articlesWithDuplicates.push({
        ...article,
        exactTitlePostDuplicates: await exactTitlePostDuplicates(
          reader,
          collection,
          article,
        ),
      });
    }

    return {
      schemaVersion: 1,
      readOnly: true,
      projectId: INVENTORY_PROJECT_ID,
      collection: INVENTORY_COLLECTION,
      generatedAt,
      limits: {
        articles: ARTICLE_FETCH_CAP,
        exactTitlePostDuplicatesPerArticle: DUPLICATE_POST_FETCH_CAP,
      },
      counts: { article: articleCount, post: postCount },
      articles: articlesWithDuplicates,
    };
  }, { readOnly: true });
}

function credentialShapeIsValid(credential) {
  return (
    credential &&
    typeof credential === "object" &&
    !Array.isArray(credential) &&
    credential.type === "service_account" &&
    credential.project_id === INVENTORY_PROJECT_ID &&
    boundedNonemptyString(credential.client_email, 500) &&
    boundedNonemptyString(credential.private_key_id, 500) &&
    boundedNonemptyString(credential.private_key, 20_000)
  );
}

export function validateApprovedAdc({
  env = process.env,
  readCredentialFile = readFileSync,
} = {}) {
  const credentialPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (typeof credentialPath !== "string" || credentialPath.trim() === "") {
    throw new InventoryRefusal(
      "GOOGLE_APPLICATION_CREDENTIALS is required for the read-only production inventory.",
    );
  }
  if (
    typeof env.FIRESTORE_EMULATOR_HOST === "string" &&
    env.FIRESTORE_EMULATOR_HOST.trim() !== ""
  ) {
    throw new InventoryRefusal(
      "Firestore emulator routing is not allowed for the production inventory.",
    );
  }

  let credential;
  try {
    credential = JSON.parse(readCredentialFile(credentialPath, "utf8"));
  } catch {
    throw new InventoryRefusal("The approved ADC file could not be validated.");
  }
  if (!credentialShapeIsValid(credential)) {
    throw new InventoryRefusal(
      "The ADC credential must be the approved service account for the required production project.",
    );
  }

  for (const key of ["FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
    // config-input: FIREBASE_PROJECT_ID, GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT
    const configured = env[key];
    if (
      typeof configured === "string" &&
      configured.trim() !== "" &&
      configured !== INVENTORY_PROJECT_ID
    ) {
      throw new InventoryRefusal(
        "A configured project does not match the required production project.",
      );
    }
  }
}

async function openProductionFirestore() {
  const app = initializeApp(
    {
      credential: applicationDefault(),
      projectId: INVENTORY_PROJECT_ID,
    },
    `article-post-read-only-inventory-${process.pid}`,
  );
  return {
    firestore: getFirestore(app),
    close: () => deleteApp(app),
  };
}

const HELP = Object.freeze({
  name: "Read-only Article and Post inventory",
  readOnly: true,
  usage: "npm run --silent cms:inventory:article-posts:read-only",
  projectId: INVENTORY_PROJECT_ID,
  collection: INVENTORY_COLLECTION,
  reads: [
    "exact aggregate counts for Article and Post records",
    "bounded Article title, status, version, and deleted projections",
    "bounded exact-title Post duplicate projections for each Article",
  ],
  writes: [],
  limits: {
    articles: ARTICLE_FETCH_CAP,
    exactTitlePostDuplicatesPerArticle: DUPLICATE_POST_FETCH_CAP,
  },
});

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function runArticlePostInventoryCli({
  argv = process.argv.slice(2),
  env = process.env,
  readCredentialFile = readFileSync,
  openFirestore = openProductionFirestore,
  stdout = process.stdout,
  stderr = process.stderr,
  generatedAt,
} = {}) {
  if (argv.length === 1 && argv[0] === "--help") {
    writeJson(stdout, HELP);
    return 0;
  }

  try {
    if (argv.length !== 0) {
      throw new InventoryRefusal(
        "This read-only command accepts only --help. Its project and collection are fixed.",
      );
    }
    validateApprovedAdc({ env, readCredentialFile });
    const connection = await openFirestore();
    let inventory;
    try {
      inventory = await collectArticlePostInventory({
        firestore: connection?.firestore,
        ...(generatedAt === undefined ? {} : { generatedAt }),
      });
    } finally {
      if (typeof connection?.close === "function") await connection.close();
    }
    writeJson(stdout, inventory);
    return 0;
  } catch (error) {
    writeJson(stderr, {
      success: false,
      readOnly: true,
      error: error instanceof InventoryRefusal ? error.message : GENERIC_FAILURE,
    });
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runArticlePostInventoryCli();
}
