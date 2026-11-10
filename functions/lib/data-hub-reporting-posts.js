"use strict";
const { Filter } = require("firebase-admin/firestore");
const { projectReportingPost } = require("./data-hub-reporting-sources");
/** Same published/legacy visibility query as other build-free Post aggregates. */
async function readReportingPosts({firestore, transaction, now = new Date()}) {
  const query = firestore.collection("cmsPosts").where("published.metadata.type", "==", "post")
    .where(Filter.or(Filter.where("publiclyVisible", "==", true), Filter.where("status", "==", "published"))).limit(1001);
  const rows = transaction ? await transaction.get(query) : await query.get();
  if (rows.size >= 1001) return { failed: true, stories: [] };
  const stories = rows.docs.flatMap(row => {
    const story = projectReportingPost(row.id,row.data(),now.getTime()); return story ? [story] : [];
  });
  const counts = new Map();
  stories.forEach(story => counts.set(story.href,(counts.get(story.href) ?? 0)+1));
  return { failed: false, stories: stories.filter(story => counts.get(story.href) === 1) };
}
module.exports = { readReportingPosts };
