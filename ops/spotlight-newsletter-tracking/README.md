# Spotlight privacy choices

This WordPress package loads Google Analytics, Wisepops and ActiveCampaign only
after an explicit consent choice. Analytics and newsletter tools are two
separate choices with separate cookies: a grant for one never loads the other.
It adds a footer Privacy settings button, a consent panel, and analytics and
newsletter privacy sections on the configured native privacy page.

## Analytics

The analytics choice uses the `spotlight-analytics-consent` cookie with the
same format, versioning and 180-day life as the newsletter cookie. With a grant
on an eligible page, the client sets all Google consent types to denied, then
grants `analytics_storage` only, and loads `gtag.js` once with one `config`
call (`send_page_view: true`, Google signals and ad personalization off). It
uses no Tag Manager container. The measurement ID comes from the
`NJSPOTLIGHT_GA4_MEASUREMENT_ID` server setting; an invalid value keeps the
whole package inactive. The NJ Spotlight News stream is `G-QDQ31Y7117` in the
NJ PBS GA4 property 552755351. GA counts only readers who allow analytics, so
its numbers are not comparable with the earlier all-visitor WNET container.
Withdrawal, GPC and a player that appears later stop analytics the same way
they stop newsletter tools.

The package stays inactive without complete configuration for the selected
production installation, including the GA4 measurement ID. `.env.example` lists the required names and example
values. It is documentation; PHP does not load it. The account owner supplies
the tracking account and property after enabling the intended live domain and
checking campaign targeting. The operator supplies the production blog ID,
exact HTTPS home origin without a trailing slash, and published privacy page ID.
The selected privacy page must belong to that origin.

## Page and consent controls

The plugin checks the final rendered HTML before inserting its footer control.
This covers the theme's primary player, related-feature players, legacy
shortcodes, and pasted media. Native video, frames, objects, embedded media,
video placeholders, interactive modal links, unknown external scripts, noindex,
and redirect documents remain excluded. All rendered frames are excluded,
including nonvideo frames, because their contents can change independently.
Unrendered Handlebars templates do not constitute a player. Existing shared
CDN libraries are allowed by exact package path and version. The first-party
client rechecks known players before requesting vendors and before processing
the ActiveCampaign page visit. If a known player appears after loading, the
client saves a per-page session exclusion before ending the vendor document.
The replacement document keeps the tools off, even before that player is
opened again. If session storage is unavailable, a query parameter carries the
exclusion through navigation without replacing the reader's existing anchor.
The server and client both reject that marked address. This reloads a newly
opened player once only when newsletter tools were running;
it does not repeatedly reload or record another tracking visit. New code that
can insert a player still needs the eligibility review described below.
Readers who have not loaded the tools keep their video document without a reload.

Admin, authenticated, preview, private, password-protected, Kids and descendant,
child-directed, search, feed, REST, embedded, non-GET, and nonproduction requests
remain excluded. A missing DOM extension, incomplete/streamed output, or an
HTML document larger than 2 MiB prevents initialization. The plugin does not
change stored editorial content. The configured privacy page gets the appended
notice even if its media or robots settings exclude its tracking/footer UI.

Unknown, malformed, duplicate, unreadable, expired, or older-version consent
records never allow tracking. Global Privacy Control keeps both vendors off.
The consent cookie is host-only, Secure, SameSite=Lax, and valid for 180 days.
The grant must be saved and read back before the first vendor request. A saved
grant does not override an excluded page or GPC.

ActiveCampaign starts with default tracking disabled and processes a page only
after its script loads and the current consent check still passes. It receives
no explicit email, identification, custom-event, or form commands from this
integration. Wisepops receives its denied default before an explicit grant.
Each script loads once per document. The implementation does not infer that
an enabled domain proves campaign delivery or a successful vendor backend call.

Changing to Do not allow saves denial and reloads a document that ran vendor
code. Removing a script cannot stop executed code, and Wisepops has no supported
programmatic consent revocation. The reload cannot recall earlier requests or
delete vendor-held records. Other open tabs receive a change notification where
BroadcastChannel is supported; focus and page visibility also recheck consent.
If a browser permits reading an old grant but blocks writing a new choice,
the panel reports that withdrawal was not saved and gives cookie/blocking
instructions. It does not reload and silently treat the old grant as a new
permission. The existing vendor document can continue under that earlier
permission until the visitor clears the cookies, blocks the tools, or leaves.

## Review and installation

Joe reviews the consent and privacy wording with the source PR. Independent
technical review and hosted CI precede merge. Merge, installation, deployment,
and campaign activation remain separately authorized steps.

After that authorization, the operator installs the PHP file directly in
`wp-content/mu-plugins/` and the JavaScript and CSS in its sibling directory
`wp-content/mu-plugins/spotlight-newsletter-tracking/`. Preserve existing files
and capture their hashes and backups before a replacement. Set the seven named
environment settings before PHP starts. The existing site cache and privacy
bypass rules remain unchanged.

Before activation, verify ordinary public text, home, About, privacy, primary
video, related video, pasted video, preview, noindex, and child-directed paths.
Check an unknown choice, denial, grant, GPC, blocked cookie storage, an old
choice, revocation, and two open tabs. Confirm actual vendor requests only
after consent, including successful account-domain responses and the intended
campaign. Repeat after any theme, embedding-provider, or campaign change that
can add media. Hosted tests use synthetic content and intercepted vendors;
they do not prove production campaign behavior.

Check ordinary keyboard Tab order, focus return, a screen reader, and reflow at
200% and 400%. Focusing an ordinary page link closes the nonmodal panel so it
does not cover that focus. The settings button appears only after its script
mounts; the ordinary privacy-information link remains usable if JavaScript is
disabled, blocked, or unavailable.

To disable this package, remove its MU-plugin PHP entry. This stops subsequent
initialization and the dynamically appended privacy section. It does not end
already open documents or remove vendor-held data.

## Verification

The existing hosted Policy job runs PHP syntax/HTML contracts and a focused
system-Chrome browser contract. Browser tests use the real PHP-rendered footer,
intercept every request, and never contact a vendor or a real subscriber.
They capture phone and desktop UI evidence outside the source repository.
Public repository checks run on GitHub-hosted runners only.

References: [Wisepops consent mode](https://support.wisepops.com/en/articles/12679556-cookie-consent-mode),
[ActiveCampaign consent guidance](https://help.activecampaign.com/hc/en-us/articles/360000872064-Site-tracking-and-the-GDPR),
and [ActiveCampaign domain settings](https://help.activecampaign.com/hc/en-us/articles/221493708-How-to-set-up-Site-Tracking).
