"use strict";

const { defineSecret, defineString } = require("firebase-functions/params");
const { publicMediaUrl } = require("./media-contract");

const MEDIA_CACHE_PURGE_TOKEN = defineSecret("CMS_MEDIA_CACHE_PURGE_TOKEN");
const MEDIA_ZONE = defineString("CMS_MEDIA_CLOUDFLARE_ZONE_ID", { default: "" });
const MEDIA_ORIGIN = defineString("CMS_MEDIA_PUBLIC_ORIGIN", { default: "https://media.njpbs.org" });

function createMediaCacheRetirement({ origin = MEDIA_ORIGIN.value(), zoneId = MEDIA_ZONE.value(),
  token = MEDIA_CACHE_PURGE_TOKEN.value(), fetchImpl = fetch, clock = Date.now } = {}) {
  const expectedOrigin = new URL(origin);
  if (expectedOrigin.protocol !== "https:" || origin.replace(/\/$/, "") !== expectedOrigin.origin ||
      !/^[a-f0-9]{32}$/.test(zoneId) || !token?.trim()) {
    throw new Error("Public media cache retirement is not configured");
  }
  return {
    url: (key) => publicMediaUrl(origin, key),
    async retire(objects, deadlineMs) {
      const remaining = deadlineMs - clock();
      if (remaining <= 0) throw new Error("Public media cache retirement deadline elapsed");
      const signal = AbortSignal.timeout(Math.min(20_000, remaining));
      const urls = objects.filter(({ store }) => store === "public").map(({ key }) => publicMediaUrl(origin, key));
      const { purgeCopies } = require("./public-video-withdrawal");
      await purgeCopies({ urls, config: { zoneId, token }, fetchImpl, signal });
      for (const url of urls) {
        const response = await fetchImpl(url, { method: "GET", redirect: "error", signal });
        await response.body?.cancel();
        if (response.status !== 404 && response.status !== 410) {
          throw new Error("Public media is still available");
        }
      }
    },
  };
}

module.exports = { MEDIA_CACHE_PURGE_TOKEN, createMediaCacheRetirement };
