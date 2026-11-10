import { expect, it } from "vitest";
import { RESET_VALUE } from "firebase-functions/v2/options";
import authorProfilesPkg from "../../functions/author-profiles.js";
import settingsPkg from "../../functions/settings.js";
import listMediaPkg from "../../functions/list-media.js";
import mediaCategoriesPkg from "../../functions/media-categories.js";
import mediaCollectionsPkg from "../../functions/media-collections.js";
import mediaFavoritesPkg from "../../functions/media-favorites.js";
import mediaFeedbackPkg from "../../functions/media-feedback.js";
import sourceMediaPkg from "../../functions/source-media.js";
import staffProfilePkg from "../../functions/staff-profile.js";
import voiceoverReviewPkg from "../../functions/voiceover-review.js";
import publishedPostReaderPkg from "../../functions/published-post-reader.js";

const { cmsListBylineAuthors } = authorProfilesPkg;
const { cmsGetSettings, cmsSaveSettings } = settingsPkg;
const { registerStaffProfile } = staffProfilePkg;
const { cmsVoiceoverReview } = voiceoverReviewPkg;
const { cmsGetPublishedPost } = publishedPostReaderPkg;
const { cmsListMedia } = listMediaPkg;
const { cmsListMediaCategories } = mediaCategoriesPkg;
const { cmsListMediaCollections, cmsListMediaCollectionItems } = mediaCollectionsPkg;
const { cmsListMediaFavorites } = mediaFavoritesPkg;
const { cmsGetMediaReview, cmsListMediaComments } = mediaFeedbackPkg;
const { cmsCreateSourceMediaRead, cmsListMediaSources, cmsListSourceMedia } = sourceMediaPkg;

it("keeps the approved deployed Function capacity plan", () => {
  for (const fn of [cmsSaveSettings, cmsListBylineAuthors, cmsListMedia, cmsListSourceMedia, cmsGetPublishedPost]) {
    expect(fn.__endpoint.minInstances).toBe(1);
  }
  expect(cmsListBylineAuthors.__endpoint.cpu).toBe(1);
  expect(cmsListBylineAuthors.__endpoint.concurrency).toBe(80);
  for (const fn of [cmsListMedia, cmsListMediaCategories, cmsListMediaCollections, cmsListMediaCollectionItems,
    cmsListMediaFavorites, cmsGetMediaReview, cmsListMediaComments, cmsListMediaSources, cmsListSourceMedia, cmsCreateSourceMediaRead]) {
    expect(fn.__endpoint.cpu).toBe(1);
    expect(fn.__endpoint.concurrency).toBe(80);
  }
  expect(cmsGetSettings.__endpoint.cpu).toBe(1);
  expect(cmsGetSettings.__endpoint.concurrency).toBe(80);
  expect(cmsGetSettings.__endpoint.minInstances).toBeInstanceOf(RESET_VALUE.constructor);
  for (const fn of [cmsVoiceoverReview, registerStaffProfile]) {
    expect(fn.__endpoint.cpu).toBe(1);
    expect(fn.__endpoint.concurrency).toBe(1);
    expect(fn.__endpoint.minInstances).toBeInstanceOf(RESET_VALUE.constructor);
  }
});
