# Email routing worker

This Worker forwards shared station aliases to configured recipient groups. It
normalizes aliases, keeps department routing inside the configured zone, and
records durable delivery receipts to avoid repeating successful forwards when a
later destination fails. It logs normalized aliases and destination indexes.

Set the required `FANOUT_DESTINATIONS_JSON` Worker secret containing `default`,
`info`, `engineering`, `programming`, and `desk` arrays. Each array must contain at least
one valid recipient address. The `info` array is the complete membership for that
alias, including any recipients shared with the default group. Other station
aliases continue to use `default`; off-zone mail also uses `default`. The pure routing helpers contain placeholders for
local tests. The Worker rejects missing or malformed configuration before forwarding.
Replace every placeholder before enabling routing. Email Routing
rules determine which addresses reach the Worker; those rules and recipient
verification are configured separately.

Binding format, with placeholder recipients:

```json
{"default":["REPLACE_ME@example.org"],"info":["REPLACE_ME@example.org","REPLACE_ME_INFO@example.org"],"engineering":["REPLACE_ME_ENGINEERING@example.org"],"programming":["REPLACE_ME_PROGRAMMING@example.org"],"desk":["REPLACE_ME_DESK@example.org"]}
```

Authentication values and real recipient addresses belong in platform
configuration, never in source control.

## Durable acceptance and retries

Attempt configured destinations in order and catch each rejection so later
legs still run. After each resolved `forward()`, await its durable acceptance
receipt before the next leg. Replays skip accepted legs and attempt only
unfinished destinations. Retry an uncertain receipt once using the same claim,
then reread unfinished state before emitting a generic count-only failure.
All-success/already-complete replays return normally.

Identity hashes Message-ID, original Date, envelope sender and full normalized
recipient including any plus tag. `FANOUT_DELIVERIES` stores destination hashes
and acceptance/claim state, never bodies, subjects, raw headers or addresses.
Indexes are diagnostics, never receipt keys: membership changes cannot transfer
one destination's success to another. These hashes are pseudonymous, not encrypted.

Each destination acquires a ten-minute claim before forwarding. Rejection
releases it; accepted-forward receipt uncertainty retains it until expiry if
one write retry fails. Missing binding or ledger-read failure prevents sending
that leg; identified messages never silently fall back to stateless delivery.
Alarms remove receipts seven days after the last unfinished claim. Completed
replays do not extend retention.

Without Message-ID no reliable deduplication exists; independent forwards can
repeat on retry. Reused Message-ID/Date/envelope is a replay during retention,
not an authentication boundary. SMTP acceptance and receipt storage cannot
commit atomically: crashes, long forwards or expiry can still duplicate mail.
No receipt is accepted before `forward()` resolves, and a resolved call proves
forwarding-boundary acceptance rather than inbox delivery. All rejected legs
stay pending; opaque provider text cannot safely establish permanent failure.
The platform's handler retry signal is not an application retry queue or a
documented exactly-once guarantee.

Logs include only normalized served alias, destination index/count and fixed
failure category. No sender/destination address, subject, body, raw header or
provider exception text. Keep invocation logs disabled and bounded custom
failure logs enabled. Interpret indexes against that deployed configuration.

## Verify and release

From the repository root in credential-free Bash with both root and site
locked dependencies installed. The pinned Wrangler comes from the root lockfile:

```sh
cd site
npm test -- tests/email-fanout.test.ts tests/email-fanout-retry.test.ts
npx --no-install wrangler deploy --dry-run --config worker-fanout/wrangler.toml
```

The tests use fake forwarding and persistent fake storage; they send no email.
A dry run checks bundling/bindings without deploying. Before a separately
authorized release, the private operator step reconciles the actual recipient
groups and verifies every destination through Email Routing. An enabled/synced
multi-address forward rule is not a substitute for independent Worker forwards.

Deploy the reviewed script with `FANOUT_DELIVERIES` and the
`fanout-deliveries-v1` SQLite migration as one operation. From this directory the
supported command is `npx --no-install wrangler deploy`. Resolve the pinned
package before fetching deployment credentials; an absent package must refuse
rather than download install code with credentials in scope. Keep namespace, receipts and migration
on later versions; a script-only API upload or stateless rollback can repeat
previously accepted deliveries. Zone routing rules are independent and persist
across script uploads. Never infer which aliases are live from pure helpers.

After authorization, verify actual version/binding/migration and safe activity
logs. A labeled real-message exercise and intended-mailbox receipt require
separate authorization. Test the upstream SMTP failure behavior when storage is
unavailable before claiming live retry semantics. Local tests prove neither
production mailbox delivery nor platform replay cadence.
