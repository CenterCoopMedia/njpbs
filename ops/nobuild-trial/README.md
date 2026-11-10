# No-build Post trial probe

This read-only harness measures the public Post route and the Home, feed, sitemap and search outputs. It sends anonymous HTTPS `GET` requests. It omits cookies and credentials, does not follow redirects, and does not send cache-bypass headers.

Plain requests decide pass or fail. The harness also sends one request per route with a unique `__nobuild_probe` query value. It labels these as diagnostics and excludes them from the pass decision because they may use a different cache key. Both request types record status, `Cache-Control`, cache-status headers and response digest. A request that fails before receiving an HTTP response is recorded as a probe error. It does not count as a stale response; the next successful plain responses still need to confirm the current bytes.

## Config

Save two JSON files outside the repository. The baseline config contains only the aggregate targets. The trial config contains the same aggregate targets plus the Post details. Use the exact public version, operation ID and HTML SHA-256 from the accepted publication. Set each aggregate `needle` to a stable public string that should appear or disappear, such as the canonical Post path or slug. The needle must identify this Post, not an unrelated existing entry.

```json
{
  "aggregates": [
    { "name": "home", "url": "https://njpbs.org/", "needle": "/posts/<post-slug>/", "presence": "omits", "expectation": "unchanged" },
    { "name": "feeds", "url": "https://njpbs.org/feeds/news.xml", "needle": "/posts/<post-slug>/", "presence": "contains" },
    { "name": "sitemap", "url": "https://njpbs.org/<sitemap-file-containing-the-post>", "needle": "/posts/<post-slug>/", "presence": "contains" },
    { "name": "search", "url": "https://njpbs.org/search/meaning-index.json", "needle": "<post-slug>", "presence": "contains" }
  ]
}
```

The example configuration assumes no Home placement. Only Home accepts `expectation: "unchanged"`, and it requires `presence: "omits"`. It records successful ordinary responses without the exact Post needle before and after publication. An observed appearance fails this check, including one before the first absence. Home remains a required target; its evidence is not a changed output or a catch-up time. Omitting `expectation` retains the transition check.

For a rename, use the new canonical path as the aggregate needle and put the old detail URL in `post.aliases`. Keep Home unchanged and absent. The new path must be absent from the affected aggregates before publication. Alternatively, a separate removal measurement can use the exact old path with `presence: "omits"` on affected aggregates. Do not substitute an unrelated needle if the Post is already present: A stable path cannot prove an update transition. Stage a publication or rename with an observable Post-specific transition.

Use `presence: "omits"` without `expectation` on affected aggregates to measure removal, including a withdrawal. Those targets must contain the Post needle before the operation. Home still uses unchanged absence. The detail pass contract remains a published 200 response, so a full withdrawal (410) does not pass the published-detail trial. The sitemap target must be the sitemap file that contains the Post entry, not only an index that links to sitemap files.

## Capture the pre-operation baseline

Run this shortly before publication. Affected outputs must show the opposite of the configured post-publication state; unchanged Home must already omit the Post. With `--remote-host`, it records local and remote results. The baseline must finish before publication acceptance and no more than 30 minutes before it.

```sh
node ops/nobuild-trial/probe.mjs baseline \
  --config /tmp/no-build-trial-aggregates.json \
  --receipt /tmp/no-build-trial-baseline.json \
  --remote-host remote-probe
```

## Measure the accepted publication

Run this after publication acceptance. Set `--start-at` to the exact acceptance timestamp, including its timezone. The baseline receipt must be from before this time and must include every requested vantage.

```sh
node ops/nobuild-trial/probe.mjs probe \
  --config /tmp/no-build-trial.json \
  --baseline-receipt /tmp/no-build-trial-baseline.json \
  --start-at 2026-10-09T13:00:00-04:00 \
  --receipt /tmp/no-build-trial-receipt.json \
  --remote-host remote-probe \
  --confirmations 3
```

The detail poll interval is one second through the 20-second pass window, then five seconds by default. Alias checks run alongside canonical checks. The aggregate interval is 15 seconds. The default run limit is 10 minutes. Set `--max-duration-ms` to cover the first normal site build being measured. The first plain Post response must match the expected version, operation and digest within 20 seconds. When headers carry that identity, the receipt uses header arrival time after the body digest is verified. Otherwise, it uses the matching response or JSON-receipt completion time. Remote clock uncertainty reduces that timing margin. Each vantage must then return current bytes on the next three successful plain responses. Every alias must return a direct 308 to the canonical URL on its confirmations. Status 410 and 503 remain visible and fail a published-route check.

The unique-query request is diagnostic only. It cannot satisfy the expected-version check or alter the recorded first-match time. Confirm the build's exact ID, source commit SHA, start time and completion time independently. Then seal the receipt:

```sh
node ops/nobuild-trial/probe.mjs seal \
  --receipt /tmp/no-build-trial-receipt.json \
  --normal-build-id <build-id> \
  --normal-build-source-sha <40-character-source-commit-sha> \
  --normal-build-start-at 2026-10-09T13:00:05-04:00 \
  --normal-build-complete-at 2026-10-09T13:04:10-04:00
```

The aggregate receipt keeps request starts, response-header times, body-completion times, the latest stale request start and the first current response. Sealing passes only when the first normal build starts after publication and each aggregate's first current matching body completes by build completion, with remote clock uncertainty included. An aggregate observed before the build starts counts; a body first confirmed after build completion does not. The receipt reports the observation interval from the last stale request start to the first current body completion. This interval bounds public observations; it is not an exact server-side transition time. The receipt can be sealed only once.

Unchanged Home has `catchUpElapsedMs: null`. Its build-window result uses `catchUpEvidence: "unchanged-home"`, `caughtUpByBuildCompletion: null` and a separate `unchangedByBuildCompletion` decision. Its absence must be observed before the operation and again after feeds, sitemap and search finish their confirmations. Home keeps polling until that later ordinary request confirms absence. The receipt records this observation as `confirmedUnchangedAt`; it must meet the same build deadline with clock uncertainty included. Feeds, sitemap and search retain their transition evidence and catch-up decisions.

## Cache evidence

Every response sample preserves `X-Njpbs-Render-Cache` as `headers.renderCache`, including ordinary and unique-query requests from either vantage. The value is the exact header (`HIT`, `MISS` or `BYPASS`); an absent header is `null`. A request with no HTTP response has no response headers.

For each vantage, inspect repeated ordinary Post samples for `HIT` on the exact current version, operation and verified bytes. Record `BYPASS` on diagnostic requests. Private-request bypass proof needs separately authorized private-request evidence; this anonymous harness sends no credentials. A `MISS` immediately after purge is not required: The publication confirmation readback may already have warmed the cache. Browser-facing `Cache-Control: no-store` is intentional and does not disable the internal edge cache.

Keep the operation-bound purge acknowledgment and ordinary byte/version verification as separate evidence. A cache header alone proves neither. Cache evidence is retained for review; it does not replace the detail timing or identity checks. Diagnostic requests stay outside the latency pass decision.

Remote runs send three clock pings over the same SSH session as the probe, use the lowest-uncertainty sample, correct the sample times to the local clock and record the offset and uncertainty. The run refuses remote timing if calibration uncertainty exceeds one second. The receipt includes UTC and Eastern timestamps for samples, baseline, clock calibration, catch-up, build window and final decision.

`--remote-host` sends the probe code and non-secret config over SSH stdin. It writes no remote files and starts no service. The SSH host must have Node.js 22, GNU `timeout`, and batch SSH access. Tests use recorded fixtures only and do not contact the network:

```sh
node --test --test-concurrency=1 ops/nobuild-trial/probe.test.mjs
```

Use a deployment-selected SSH alias for `--remote-host`, or omit it to measure
only the local vantage. `--vantage` selects the local receipt label and defaults
to `local-probe`. The example alias is not a configured host.
