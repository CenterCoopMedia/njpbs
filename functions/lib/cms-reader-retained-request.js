"use strict";

// Called only by explicitly constructed retained mounts after each original
// endpoint's authorization. Ordinary routes have no retained source binding.
async function retainedReaderReply({ firestore, body, feature, now = Date.now }) {
  const { retained, ...request } = body;
  const result = await firestore.runTransaction(transaction => require("./cms-reader-retained-replies")
    .readRetainedReplyInTransaction({ firestore, transaction, binding: retained, feature, body: request, now }), { readOnly: true });
  return result.value;
}

module.exports = { retainedReaderReply };
