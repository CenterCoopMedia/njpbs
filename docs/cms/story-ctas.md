# Automatic story calls to action

The `story-ctas` settings document stores an ordered list of rules. Publish its
saved version with the normal settings publication method. The public site reads
the published snapshot; later draft edits do not change readers' pages.

Each rule has a stable `id`, a staff `label`, an `enabled` switch, a `target`
object, a `position` object and `content`. The target contains
`contentTypes: ["post"]`. Keeping target fields together lets later optional
category or tag restrictions extend existing rules without a data migration.
Category and tag restrictions are not supported now.

An end rule uses `position: { kind: "end" }`. Its content is an existing
`support_appeal` block's `type` and `data`, with a heading, copy, button label,
safe link and existing color style. Automatic appeals use text and a button.
Images remain part of authored story blocks. Up to 20 rules are allowed.

The renderer inserts enabled rules after the story body in list order. Empty
bodies can show an end CTA. Pages do not receive story rules. Automatic blocks
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
