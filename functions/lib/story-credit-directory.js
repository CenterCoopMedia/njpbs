"use strict";

// Reading author identities for the byline contract (issue #1040).
//
// `lib/story-credits.js` is pure: it knows the shape of a credit and nothing
// about who exists. This module is the Firestore half — the two questions the
// server must actually answer before a byline is stored or published:
//
// 1. At SAVE time: does this authorId name a real, active author identity? A
//    credit that names nobody would publish as a blank byline; a credit newly
//    added for a deactivated account would put a departed staffer's name on new
//    work.
// 2. At PUBLISH time: what is this author's display name and public slug RIGHT
//    NOW? Those are frozen into the snapshot so the page keeps reading correctly
//    after a rename, a withdrawal, or a deactivation.
//
// Both are the same read, so they are one function. `active` comes from the
// working profile lifecycle, plus the `cmsStaffRecords` linkage status when an
// account is linked. An unlinked manager-created profile can be active; a linked
// profile fails closed unless its account linkage is active. The profile supplies
// the name, and the slug is offered only while the
// profile is actually published, because a withdrawn profile has no page to link
// to.

const {
  AUTHOR_PROFILE_COLLECTIONS,
  isAuthorId,
} = require("./author-profile-contract");
const {
  freezeStoryCredits,
  registeredCreditsError,
  registeredAuthorIds,
  resolveStoryCredits,
} = require("./story-credits");
const { freezeLiveBlogData, prepareLiveBlogDraft, parseLiveBlogDraft, LiveBlogDraftError } = require("./live-blog");

/** Live-blog bylines use the same per-entry active-author rule as a Post byline. */
async function prepareLiveBlogDraftInTransaction({ firestore, tx, value, previous, published, mintId,
  readIdentities = readAuthorIdentities }) {
  const draft = prepareLiveBlogDraft(value, { previous, published, mintId });
  const added = new Set();
  const creditEntries = blog => (blog?.updates ?? []).flatMap(entry => [
    { id: entry.id, credits: entry.credits },
    ...(entry.followUps ?? []).map(item => ({ id: `${entry.id}/${item.id}`, credits: item.credits })),
  ]);
  const previousAuthors = new Map(creditEntries(previous).map(entry => [entry.id, new Set(registeredAuthorIds(entry.credits))]));
  for (const entry of creditEntries(draft)) {
    for (const id of registeredAuthorIds(entry.credits)) if (!previousAuthors.get(entry.id)?.has(id)) added.add(id);
  }
  const identities = await readIdentities({ firestore, tx, authorIds: [...added] });
  for (const entry of creditEntries(draft)) {
    const error = registeredCreditsError(entry.credits, identities, previousAuthors.get(entry.id) ?? new Set());
    if (error) throw new LiveBlogDraftError(error);
  }
  return draft;
}

/** Called by the whole-Post publisher; untouched entries retain their frozen names. */
async function freezeLiveBlogForPublish({ firestore, tx = null, document, at, preview = false }) {
  if (document.liveBlog === undefined) return undefined;
  const draft = parseLiveBlogDraft(document.liveBlog);
  const identities = await readAuthorIdentities({ firestore, tx,
    authorIds: draft.updates.flatMap(entry => [entry, ...(entry.followUps ?? [])].flatMap(item => registeredAuthorIds(item.credits))) });
  return freezeLiveBlogData(draft, { previous: document.published?.metadata?.liveBlog, at, preview,
    freezeCredits: credits => freezeStoryCredits(credits, id => identities.get(id) ?? null) });
}

/**
 * Read the named author identities. Works inside a Firestore transaction (pass
 * `tx`) or outside one. Unknown ids are simply absent from the returned map, so a
 * caller distinguishes "not found" from "found but inactive".
 */
async function readAuthorIdentities({ firestore, tx = null, authorIds }) {
  const wanted = [...new Set(authorIds.filter(isAuthorId))];
  const identities = new Map();
  if (wanted.length === 0) return identities;

  // One batched read per hop rather than a fan-out of individual gets: inside a
  // transaction that keeps every read in a single round trip, which is both faster
  // and the shape the Firestore transaction API is specified for.
  const readAll = (refsToRead) =>
    refsToRead.length === 0
      ? Promise.resolve([])
      : tx
        ? tx.getAll(...refsToRead)
        : firestore.getAll(...refsToRead);
  const profilesCollection = firestore.collection(
    AUTHOR_PROFILE_COLLECTIONS.workingProfiles,
  );
  const staffCollection = firestore.collection(
    AUTHOR_PROFILE_COLLECTIONS.staffRecords,
  );

  const profileSnapshots = await readAll(
    wanted.map((authorId) => profilesCollection.doc(authorId)),
  );
  const found = [];
  for (let index = 0; index < wanted.length; index += 1) {
    const snapshot = profileSnapshots[index];
    if (!snapshot.exists) continue;
    found.push({ authorId: wanted[index], profile: snapshot.data() });
  }
  if (found.length === 0) return identities;

  // Only linked profiles need an account-status hop. Manager-created profiles
  // intentionally have no uid until an approved CMS user is linked later.
  const linkedUids = [
    ...new Set(
      found
        .map(({ profile }) => profile.uid)
        .filter((uid) => typeof uid === "string" && uid.length > 0),
    ),
  ];
  const staffSnapshots = await readAll(
    linkedUids.map((uid) => staffCollection.doc(uid)),
  );
  const staffByUid = new Map();
  linkedUids.forEach((uid, index) => {
    const snapshot = staffSnapshots[index];
    if (snapshot && snapshot.exists) staffByUid.set(uid, snapshot.data());
  });

  found.forEach(({ authorId, profile }) => {
    const linked = typeof profile.uid === "string" && profile.uid.length > 0;
    const staff = linked ? staffByUid.get(profile.uid) ?? null : null;
    const lifecycle = profile.lifecycle === "archived" ? "archived" : "active";
    identities.set(authorId, {
      authorId,
      displayName:
        typeof profile.displayName === "string" ? profile.displayName : "",
      active: lifecycle === "active" && (!linked || staff?.status === "active"),
      // A private or withdrawn profile has no public page, so the frozen credit
      // gets a name and no link. Deactivation withdraws the profile upstream, so
      // it reaches the same state through the same field rather than a second rule.
      slug:
        profile.visibility === "published" &&
        typeof profile.slug === "string" &&
        profile.slug.length > 0
          ? profile.slug
          : null,
    });
  });
  return identities;
}

/**
 * The byline to freeze into a published snapshot: this document's credits with
 * each registered author's current display name and public slug written in.
 *
 * Reads the document through `resolveStoryCredits`, so a post that still carries
 * only the pre-#1040 free-text `author` publishes its byline as one custom credit
 * rather than losing it.
 */
async function freezeCreditsForPublish({ firestore, tx = null, document }) {
  const credits = resolveStoryCredits(document);
  if (credits.length === 0) return [];
  const identities = await readAuthorIdentities({
    firestore,
    tx,
    authorIds: registeredAuthorIds(credits),
  });
  return freezeStoryCredits(credits, (authorId) => identities.get(authorId) ?? null);
}

/**
 * The same document with its byline frozen, ready to hand to
 * `createPublishedSnapshot`. Returns the document untouched only when it has no
 * byline at all, so a page (which has no credits) passes through unchanged.
 *
 * The shortcut has to be "no byline", not "nothing to freeze". A document whose
 * every registered credit is unresolvable -- deleted profiles, a corrupted
 * linkage -- freezes to an empty list, and handing back the original there would
 * publish the raw stored credits instead: bare `{kind, authorId}` entries with no
 * display name, which is precisely the byline the freeze exists to prevent going
 * public. An unresolvable byline publishes as no byline.
 */
async function withFrozenCredits({ firestore, tx = null, document, at, preview = false }) {
  // The shortcut asks the document, not the freeze. `resolveStoryCredits` is pure
  // and reads no Firestore, so asking it first costs nothing and gets the question
  // right.
  const hasCredits = resolveStoryCredits(document).length !== 0;
  const hasLiveBlog = document.type === "post" && document.liveBlog !== undefined;
  if (!hasCredits && !hasLiveBlog) return document;
  const credits = hasCredits ? await freezeCreditsForPublish({ firestore, tx, document }) : undefined;
  const liveBlog = !hasLiveBlog ? undefined :
    await freezeLiveBlogForPublish({ firestore, tx, document, at, preview });
  return { ...document, ...(credits === undefined ? {} : { credits }),
    ...(liveBlog === undefined ? {} : { liveBlog }) };
}

module.exports = {
  prepareLiveBlogDraftInTransaction,
  freezeLiveBlogForPublish,
  freezeCreditsForPublish,
  readAuthorIdentities,
  withFrozenCredits,
};
