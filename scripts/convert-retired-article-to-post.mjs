import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import contentBlocks from "../functions/lib/content-blocks.js";
import contentDocumentContract from "../functions/lib/content-document-contract.js";
import contentMetadata from "../functions/lib/content-metadata.js";
import documentSize from "../functions/lib/document-size.js";
import editorSectionContract from "../functions/lib/editor-section-contract.js";
import mediaUsage from "../functions/lib/media-usage.js";
import storyCredits from "../functions/lib/story-credits.js";

const { isRichTextDoc, parseBlocks } = contentBlocks;
const {
  unsupportedContentFields,
  validateContentFieldValues,
} = contentDocumentContract;
const { validateKnownMetadata } = contentMetadata;
const { documentSizeError } = documentSize;
const { validateSection } = editorSectionContract;
const {
  collectWorkingMediaUsage,
  prepareMediaUsageWrite,
} = mediaUsage;
const { normalizeStoryCredits } = storyCredits;

export const PROJECT_ID = "njpbs-site";
export const COLLECTION = "cmsPosts";
export const SYSTEM_ACTOR = "system:article-to-post-migration";
export const SAFE_ARTICLE_STATUSES = Object.freeze(["draft", "archived"]);

const VERSION_HISTORY_COLLECTION = "cmsVersionHistory";
const AUDIT_COLLECTION = "admin_logs";
const AUDIT_SOURCE = "approved_operator_migration";
const MAX_DOCUMENT_ID_BYTES = 1_500;
const MAX_TITLE_BYTES = 500;
const MAX_AUTHOR_NAME_BYTES = 120;

function nonempty(value, maximum) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

function boundedDocumentId(value) {
  return (
    nonempty(value, MAX_DOCUMENT_ID_BYTES) &&
    value === value.trim() &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  );
}

function canonicalInstant(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function parseConversionPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The conversion plan must be an object.");
  }
  const { id, title, version, authorName } = value;
  if (
    !boundedDocumentId(id) ||
    !nonempty(title, MAX_TITLE_BYTES) ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new Error(
      "The conversion plan requires a bounded id and title plus a positive version.",
    );
  }
  if (
    authorName !== undefined &&
    !nonempty(authorName, MAX_AUTHOR_NAME_BYTES)
  ) {
    throw new Error(
      "authorName must be omitted or contain a bounded display name.",
    );
  }
  return Object.freeze({
    id,
    title,
    version,
    ...(authorName === undefined ? {} : { authorName }),
  });
}

function validCredentialShape(credential) {
  return (
    credential &&
    typeof credential === "object" &&
    !Array.isArray(credential) &&
    credential.type === "service_account" &&
    credential.project_id === PROJECT_ID &&
    nonempty(credential.client_email, 500) &&
    nonempty(credential.private_key_id, 500) &&
    nonempty(credential.private_key, 20_000)
  );
}

export function validateMigrationEnvironment({
  env = process.env,
  readCredentialFile = readFileSync,
} = {}) {
  if (
    typeof env.FIRESTORE_EMULATOR_HOST === "string" &&
    env.FIRESTORE_EMULATOR_HOST.trim() !== ""
  ) {
    throw new Error(
      "Firestore emulator routing is not allowed for the production Article-to-Post migration.",
    );
  }

  const credentialPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (typeof credentialPath !== "string" || credentialPath.trim() === "") {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS is required for the production Article-to-Post migration.",
    );
  }

  let credential;
  try {
    credential = JSON.parse(readCredentialFile(credentialPath, "utf8"));
  } catch {
    throw new Error("The approved ADC file could not be validated.");
  }
  if (!validCredentialShape(credential)) {
    throw new Error(
      "The ADC credential must be the approved service account for the required production project.",
    );
  }

  for (const key of [
    "FIREBASE_PROJECT_ID",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT",
  ]) {
    // config-input: FIREBASE_PROJECT_ID, GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT
    const configured = env[key];
    if (
      typeof configured === "string" &&
      configured.trim() !== "" &&
      configured !== PROJECT_ID
    ) {
      throw new Error(
        "A configured project does not match the required production project.",
      );
    }
  }
}

function convertedCredits(plan) {
  const normalized = normalizeStoryCredits(
    plan.authorName === undefined
      ? []
      : [{ kind: "custom", name: plan.authorName }],
  );
  if (!normalized.ok) {
    throw new Error(
      `The approved byline is invalid: ${normalized.errors[0]}`,
    );
  }
  return normalized.credits;
}

function completePostError(post) {
  const unsupported = unsupportedContentFields(COLLECTION, "post", post);
  if (unsupported.length > 0) {
    return `The converted Post contains unsupported fields: ${unsupported
      .sort()
      .join(", ")}`;
  }

  const fieldError = validateContentFieldValues(
    COLLECTION,
    "post",
    post,
    {
      complete: true,
      validateTypes: true,
      validateAccessibility: true,
    },
  );
  if (fieldError) return fieldError;

  return validateKnownMetadata(post, { descriptionIsString: false });
}

export function articleAsPost(article, planInput, nowIso) {
  const plan = parseConversionPlan(planInput);
  if (
    !article ||
    article.type !== "article" ||
    article.title !== plan.title ||
    article.version !== plan.version
  ) {
    throw new Error(
      "The stored Article does not match the approved conversion plan.",
    );
  }
  if (article.id !== undefined && article.id !== plan.id) {
    throw new Error(
      "The stored Article id does not match the approved conversion plan.",
    );
  }
  if (
    article.published !== undefined ||
    article.publiclyVisible === true ||
    article.status === "published"
  ) {
    throw new Error(
      "A public or published Article requires a separately reviewed public-snapshot migration.",
    );
  }
  if (!SAFE_ARTICLE_STATUSES.includes(article.status)) {
    throw new Error(
      "Only draft or archived Articles can be converted. Cancel scheduling or leave the current workflow state before conversion.",
    );
  }
  if (!isRichTextDoc(article.body)) {
    throw new Error(
      "The stored Article body is not valid for conversion.",
    );
  }

  const legacyBlocks =
    article.blocks === undefined ? [] : article.blocks;
  if (!Array.isArray(legacyBlocks)) {
    throw new Error(
      "The stored Article blocks field must be absent or contain an array.",
    );
  }
  if (
    article.author !== undefined &&
    typeof article.author !== "string"
  ) {
    throw new Error("The stored Article byline is invalid.");
  }
  if (
    typeof article.author === "string" &&
    article.author.trim() !== "" &&
    plan.authorName === undefined
  ) {
    throw new Error(
      "The Article has a byline; the approved plan must provide its display name.",
    );
  }
  if (!canonicalInstant(nowIso)) {
    throw new Error(
      "The conversion timestamp must be a canonical ISO instant.",
    );
  }

  const migratedBodyId = `article-body-${plan.id}`;
  if (legacyBlocks.some((block) => block?.id === migratedBodyId)) {
    throw new Error(
      "The generated Article body block id already exists.",
    );
  }

  const post = structuredClone(article);
  delete post.body;
  delete post.dek;
  delete post.author;
  // Article hero art was an opaque PBS Media Manager string. A Post lead image
  // must be a station media asset with matching accessibility fields, so the
  // legacy value cannot be reinterpreted safely. The full before-state remains
  // in version history for a later, explicit media selection.
  delete post.heroImage;
  delete post.heroImageAlt;
  delete post.heroImageDecorative;

  post.id = plan.id;
  post.type = "post";
  if (article.dek !== undefined) post.summary = article.dek;
  post.tags = article.tags ?? [];
  post.credits = convertedCredits(plan);
  post.blocks = [
    {
      id: migratedBodyId,
      type: "prose",
      order: 0,
      visible: true,
      data: { content: article.body },
    },
    ...legacyBlocks.map((block, index) => ({
      ...block,
      order: index + 1,
    })),
  ];

  const parsedBlocks = parseBlocks(post.blocks);
  if (!parsedBlocks.ok) {
    throw new Error(
      `The converted Post blocks are invalid: ${parsedBlocks.error}`,
    );
  }
  const sectionError = validateSection("post", parsedBlocks.blocks);
  if (sectionError) {
    throw new Error(
      `The converted Post section is invalid: ${sectionError.reason}`,
    );
  }
  post.blocks = parsedBlocks.blocks;
  post.version = article.version + 1;
  post.updatedAt = nowIso;
  post.updatedBy = SYSTEM_ACTOR;

  const contractError = completePostError(post);
  if (contractError) {
    throw new Error(
      `The converted Post is invalid: ${contractError}`,
    );
  }
  return post;
}

function historyEntry({ article, post, plan, nowIso }) {
  return {
    collection: COLLECTION,
    documentId: plan.id,
    action: "article-to-post",
    before: article,
    after: post,
    userId: SYSTEM_ACTOR,
    userEmail: null,
    source: AUDIT_SOURCE,
    timestamp: FieldValue.serverTimestamp(),
    at: nowIso,
  };
}

function auditEntry({ article, post, plan, nowIso }) {
  return {
    actorUid: SYSTEM_ACTOR,
    actorEmail: null,
    action: "content.article_converted_to_post",
    target: `${COLLECTION}/${plan.id}`,
    before: {
      type: "article",
      status: article.status ?? null,
      version: article.version,
    },
    after: {
      type: "post",
      status: post.status,
      version: post.version,
      legacyHeroImageRemoved: article.heroImage !== undefined,
    },
    source: AUDIT_SOURCE,
    timestamp: FieldValue.serverTimestamp(),
    at: nowIso,
  };
}

function assertDocumentFits(documentSizeErrorFn, document, path, label) {
  const sizeError = documentSizeErrorFn(document, path, { label });
  if (sizeError) throw new Error(sizeError.reason);
}

export async function convertRetiredArticle({
  firestore,
  plan: planInput,
  nowIso = new Date().toISOString(),
  articleAsPostFn = articleAsPost,
  collectWorkingMediaUsageFn = collectWorkingMediaUsage,
  prepareMediaUsageWriteFn = prepareMediaUsageWrite,
  documentSizeErrorFn = documentSizeError,
} = {}) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    throw new Error("A Firestore Admin client is required.");
  }
  const plan = parseConversionPlan(planInput);

  return firestore.runTransaction(async (transaction) => {
    if (
      !transaction ||
      typeof transaction.get !== "function" ||
      typeof transaction.set !== "function" ||
      typeof transaction.create !== "function"
    ) {
      throw new Error("A Firestore transaction writer is required.");
    }

    const ref = firestore.collection(COLLECTION).doc(plan.id);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw new Error("The planned Article does not exist.");
    }
    const article = snapshot.data();
    const duplicates = await transaction.get(
      firestore
        .collection(COLLECTION)
        .where("type", "==", "post")
        .where("title", "==", plan.title)
        .limit(1),
    );
    if (
      !Array.isArray(duplicates.docs) ||
      duplicates.docs.length !== 0
    ) {
      throw new Error(
        "A Post with the Article title already exists; no conversion was made.",
      );
    }

    const post = articleAsPostFn(article, plan, nowIso);
    const historyRef = firestore
      .collection(VERSION_HISTORY_COLLECTION)
      .doc();
    const history = historyEntry({
      article,
      post,
      plan,
      nowIso,
    });
    assertDocumentFits(
      documentSizeErrorFn,
      post,
      ref.path,
      "the converted Post",
    );
    assertDocumentFits(
      documentSizeErrorFn,
      history,
      historyRef.path,
      "the Article-to-Post version-history row",
    );

    const workingUsage = collectWorkingMediaUsageFn({
      collection: COLLECTION,
      documentId: plan.id,
      document: post,
    });
    const workingMediaUsageWrite =
      await prepareMediaUsageWriteFn({
        firestore,
        transaction,
        collection: COLLECTION,
        documentId: plan.id,
        state: "working",
        sourceVersion: post.version,
        usage: workingUsage,
      });

    // All reads, including media lifecycle validation, finish before any write.
    // The content mutation, revision, media receipt, and audit evidence then
    // commit together or not at all.
    transaction.set(ref, post);
    transaction.create(historyRef, history);
    transaction.set(
      workingMediaUsageWrite.ref,
      workingMediaUsageWrite.document,
    );
    transaction.create(
      firestore.collection(AUDIT_COLLECTION).doc(),
      auditEntry({ article, post, plan, nowIso }),
    );

    return {
      id: plan.id,
      fromVersion: article.version,
      toVersion: post.version,
    };
  });
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error(
      "Usage: convert-retired-article-to-post.mjs <approved-plan.json>",
    );
  }
  validateMigrationEnvironment();
  const plan = parseConversionPlan(
    JSON.parse(readFileSync(resolve(process.argv[2]), "utf8")),
  );
  const app = initializeApp(
    {
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    },
    `article-conversion-${process.pid}`,
  );
  try {
    const result = await convertRetiredArticle({
      firestore: getFirestore(app),
      plan,
    });
    process.stdout.write(
      `${JSON.stringify({ converted: true, ...result })}\n`,
    );
  } finally {
    await deleteApp(app);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        converted: false,
        error:
          error instanceof Error
            ? error.message
            : "Conversion failed.",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
