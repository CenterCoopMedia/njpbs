"use strict";
const { STORY_CTAS_SETTINGS_ID, projectPublishedCmsSettings } = require("./cms-settings-contract");
const { shapeJoinedRecord, readLibraryHistory, joinedRecordIds } = require("./joined-records");

function storyCtaNewsletterIds(document) {
  let snapshot;
  try { snapshot = projectPublishedCmsSettings({ documentId: STORY_CTAS_SETTINGS_ID, document }); }
  catch { return []; }
  return joinedRecordIds((snapshot?.values.rules ?? [])
    .filter(rule => rule.enabled && rule.content.type === "newsletter_signup")
    .map((rule, order) => ({ id: rule.id, type: "newsletter_signup", visible: true, order, data: rule.content.data })));
}

/** Global CTAs are optional text/link cards. They cannot add media fences or
 * consume the authored body's dependency budget. Missing approvals stay hidden. */
async function readStoryCtaCards({ firestore, transaction, settings, bodyIds }) {
  const ids = storyCtaNewsletterIds(settings).filter(id => !bodyIds.includes(id));
  if (!ids.length) return [];
  try {
    const rows = await transaction.getAll(...ids.map(id => firestore.doc(`cmsPosts/${id}`)));
    const newsletters = rows.filter(row => row.exists && row.data()?.type === "newsletter");
    const history = await readLibraryHistory(firestore, transaction, newsletters.map(row => row.id));
    return newsletters.flatMap(row => {
      const record = shapeJoinedRecord(row.id, row.data(), history.get(row.id) ?? []);
      if (!record) return [];
      const card = { ...record.approvedLibraryVersion };
      delete card.imageAssetId;
      delete card.imageAlt;
      delete card.imageDecorative;
      return [{ ...record, approvedLibraryVersion: card }];
    });
  } catch { return []; }
}
module.exports = { storyCtaNewsletterIds, readStoryCtaCards };
