# Automatic story calls to action

The `story-ctas` settings document stores an ordered list of rules. Publish its
saved version with the normal settings publication method. The public site reads
the published snapshot; later draft edits do not change readers' pages.

Each rule has a stable `id`, a staff `label`, an `enabled` switch, a `target`
object, a `position` object and `content`. The target contains
`contentTypes: ["post"]`. Keeping target fields together lets later optional
category or tag restrictions extend existing rules without a data migration.
Category and tag restrictions are not supported now.

Positions are `{ kind: "start" }`, `{ kind: "end" }` or
`{ kind: "after-paragraph", count: N }`. Count visible body paragraphs only,
including separate paragraph nodes in one prose block. Photos, headings, lists,
quotes, hidden content and CTA text do not count. If the body has fewer than N
paragraphs, that rule is omitted. A CTA inside a row keeps its column. Splitting
prose preserves chapter navigation and the saved text.

Content is an existing `support_appeal` or `newsletter_signup` block's `type`
and `data`. A support appeal needs a heading, copy, button label, safe link and
existing color style. Automatic appeals use text and a button. Images remain
part of authored story blocks. A newsletter CTA selects one to four newsletter
records; only their current approved public cards and safe signup links render.
Automatic newsletter cards use text and links; optional images do not add a
site-wide media dependency. Missing cards are omitted. Authored block dependencies
keep their existing limits and media checks. Card-only story reads omit CTA joins.
Up to 20 rules are allowed. Version 2 admits these positions and newsletter
blocks; existing version 1 end appeals remain readable without migration.

The renderer inserts enabled rules at their body positions in list order. Empty
bodies can show start and end CTAs. On live blogs, start and paragraph positions
apply to the intro and end CTAs follow the update stream. Pages do not receive story rules. Automatic blocks
are render inputs; the saved story is unchanged. Invalid optional settings are
omitted so the story stays readable. The publication receipt records any
addressable settings fallback.

Use the station's verified PBS Donor360 donation URL, including its `station_id`
and `campaign`. Payments remain on PBS's page. The CTA cannot contain HTML,
scripts, an iframe or a payment proxy. Do not add unverified amount or frequency
parameters to the donation link.

The existing settings publication updates the public context and dependent story
outputs without a code deployment or full site build. Both compiled public
rendering and full artifact rendering consume the same rule contract.
Newsletter approval and withdrawal confirmation include stories that reference
the card through an enabled CTA rule, even when their authored body has no card.
Static story routes use the existing request-time context adapter once the CTA
settings document exists. Turning all rules off keeps that adapter active so
an older built appeal cannot reappear.
Route hints keep their existing 10,000-route and 2 MiB serialized-file bounds.
The inventory is written without indentation to preserve byte headroom. The
route-count bound does not guarantee that every catalog fits the byte bound.
These bounds and the settings publication roster bound still apply to CTA updates.
