import { Timestamp } from "firebase-admin/firestore";
import favoriteContract from "../../functions/lib/media-favorites.js";

const { canonicalFavoriteRef, favoriteDocumentId } = favoriteContract;

export const FIXTURE_CATEGORY = "brand";
export const FIXTURE_NOW = "2026-10-04T15:00:00.000Z";
export const FIXTURE_CREATED_AT = "2026-09-10T18:00:00.000Z";

function hashFor(index) {
  return (index + 1).toString(16).padStart(64, "0");
}

export function fixtureTake(index) {
  const familyNumber = index % 25 + 1;
  const familyId = `family-${String(familyNumber).padStart(2, "0")}`;
  const takeNumber = Math.floor(index / 25) + 1;
  const style = index % 2 === 0 ? "soft-spoken" : "masculine";
  const id = `${style}-${familyId}-${String(takeNumber).padStart(2, "0")}`;
  const serial = String(index + 1).padStart(3, "0");
  return {
    id,
    schemaVersion: 1,
    manifestVersion: 1,
    active: true,
    family_id: familyId,
    family: `Voiceover family ${familyNumber}`,
    take: takeNumber,
    style,
    performer_id: "jules-avery",
    text: `Voiceover script ${serial}.`,
    display_text: `Voiceover script ${serial}.`,
    complete: index !== 195,
    flags: index === 195 ? ["incomplete"] : [],
    ...(index === 0 ? { insert_note: "Use the station read." } : {}),
    duration_seconds: 1 + index / 100,
    order: index,
    objectKey: `takes/v1/${id}.wav`,
    sizeBytes: 10_000 + index,
    contentHash: hashFor(index),
    recordedByUid: "recorder-uid",
    recordedByName: "Recorder Name",
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: FIXTURE_CREATED_AT,
  };
}

function review(takeId, overrides = {}) {
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    takeId,
    favorite: false,
    moreLikeThis: false,
    notes: "",
    version: 1,
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:00:00.000Z",
    ...overrides,
  };
}

export async function seedVoiceoverMediaFixture(
  firestore,
  {
    category = FIXTURE_CATEGORY,
    categoryActive = true,
    mutateReview = (value) => value,
    mutateTake = (take) => take,
    takeCount = 196,
    seedExistingFavorite = true,
    seedReviews = true,
  } = {},
) {
  const takes = Array.from({ length: takeCount }, (_, index) =>
    mutateTake(fixtureTake(index), index));
  const batch = firestore.batch();
  batch.create(firestore.doc(`mediaCategories/${category}`), {
    id: category,
    label: "Brand",
    description: "Station brand media",
    order: 30,
    active: categoryActive,
    version: 1,
    createdAt: FIXTURE_NOW,
    createdBy: "fixture",
    updatedAt: FIXTURE_NOW,
    updatedBy: "fixture",
  });
  batch.create(firestore.doc("voiceoverLibrary/current"), {
    schemaVersion: 1,
    manifestVersion: 1,
    status: "review-ready",
    takeCount,
    performers: { "jules-avery": { name: "Jules Avery" } },
    styles: [
      { id: "soft-spoken", label: "Soft-spoken" },
      { id: "masculine", label: "Masculine" },
    ],
    families: Array.from({ length: 25 }, (_, index) => ({
      id: `family-${String(index + 1).padStart(2, "0")}`,
      label: `Voiceover family ${index + 1}`,
    })),
    importedByUid: "recorder-uid",
    importedAt: FIXTURE_CREATED_AT,
  });
  for (const take of takes) {
    batch.create(firestore.doc(`voiceoverTakes/${take.id}`), take);
  }

  const reviews = seedReviews
    ? [
      {
        uid: "reviewer-a",
        takeId: takes[0].id,
        value: review(takes[0].id, {
          favorite: true,
          notes: "Warm delivery.",
        }),
      },
      {
        uid: "reviewer-b",
        takeId: takes[1].id,
        value: review(takes[1].id, {
          favorite: true,
          moreLikeThis: true,
          notes: "Keep this pace.",
          version: 2,
          updatedAt: "2026-09-12T12:00:00.000Z",
        }),
      },
      {
        uid: "reviewer-c",
        takeId: takes[2].id,
        value: review(takes[2].id, { favorite: true }),
      },
      {
        uid: "reviewer-a",
        takeId: takes[3].id,
        value: review(takes[3].id, {
          favorite: false,
          moreLikeThis: true,
          notes: "Try another emphasis.",
        }),
      },
    ].map((item, index) => ({
      ...item,
      value: mutateReview(item.value, index),
    }))
    : [];
  for (const item of reviews) {
    batch.create(
      firestore.doc(`voiceoverReviews/${item.uid}/takes/${item.takeId}`),
      item.value,
    );
  }

  let existingFavoritePath = null;
  if (seedExistingFavorite && reviews.length > 0) {
    const existing = reviews[2];
    const ref = { backend: "r2", id: `voiceover-${existing.takeId}` };
    existingFavoritePath =
      `mediaFavorites/${existing.uid}/items/${favoriteDocumentId(ref)}`;
    batch.create(firestore.doc(existingFavoritePath), {
      ref,
      canonicalRef: canonicalFavoriteRef(ref),
      createdAt: Timestamp.fromDate(new Date("2026-09-13T12:00:00.000Z")),
    });
  }
  await batch.commit();
  return { category, takes, reviews, existingFavoritePath };
}
