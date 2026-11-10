"use strict";

async function fetchAnalyticsJson(url, options, fetchFn = fetch) {
  const response = await fetchFn(url, {
    ...options,
    signal: AbortSignal.timeout(12000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Analytics provider request failed");
  // Stream with a hard cap; content-length alone is not trustworthy.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("Analytics response too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

module.exports = { fetchAnalyticsJson };
