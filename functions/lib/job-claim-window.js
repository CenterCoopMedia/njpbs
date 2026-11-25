"use strict";

// A worker that dies leaves an expired lease on its job. Such a job stays
// claimable without an attempt limit, so it must not be first again each time:
// jobs whose last worker did not die go first, then the one that died longest ago.
const interrupted = (job, now) => Boolean(job.leaseToken) && job.leaseUntil <= now;

/** The next jobs to try, at most `size`. `query` is ordered oldest first. */
async function jobClaimWindow({ query, now, size, skip = () => false }) {
  for (let limit = size; ; limit *= 2) {
    const page = await query.limit(limit).get();
    const open = page.docs.filter(doc => !skip(doc.data()));
    const ready = open.filter(doc => !interrupted(doc.data(), now));
    if (ready.length >= size || page.docs.length < limit) {
      const died = open.filter(doc => interrupted(doc.data(), now))
        .sort((a, b) => a.data().leaseUntil - b.data().leaseUntil);
      return [...ready, ...died].slice(0, size);
    }
  }
}

module.exports = { jobClaimWindow };
