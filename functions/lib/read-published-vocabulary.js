"use strict";

const { authorizeContentRead, contentResource } = require("./content-authorization");
const { publishedVocabulary } = require("./published-vocabulary");

// One projected read per Post editor session, with the same scan ceiling as content search.
const MAX_VOCABULARY_POSTS = 5000;

async function readPublishedVocabulary(firestore, principal) {
  const snapshot = await firestore.collection("cmsPosts").where("type", "==", "post")
    .select("type", "status", "deleted", "publiclyVisible", "publishBuildPending", "publicSourceVersion",
      "createdBy", "section", "published.sourceVersion", "published.metadata.tags", "published.metadata.categories")
    .limit(MAX_VOCABULARY_POSTS + 1).get();
  if (snapshot.docs.length > MAX_VOCABULARY_POSTS) {
    throw Object.assign(new Error("Published suggestions are unavailable because the Post library is too large."), { status: 413 });
  }
  const records = snapshot.docs.flatMap(doc => {
    const stored = doc.data();
    const resource = contentResource({ collection: "cmsPosts", documentId: doc.id, stored });
    return authorizeContentRead(principal, { exists: true, resource }).allowed ? [stored] : [];
  });
  return publishedVocabulary(records);
}

module.exports = { MAX_VOCABULARY_POSTS, readPublishedVocabulary };
