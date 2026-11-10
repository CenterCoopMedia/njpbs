# Security headers and content security policy

The public policy is defined in `site/public/_headers` and
`packages/content-core/src/public-security-headers.ts`. The public Worker applies
the same headers to its Contact response branches. Static hosts must support
response headers for the `_headers` file to take effect.

The baseline uses `nosniff`, `strict-origin-when-cross-origin`, one year of HTTPS
transport security, `SAMEORIGIN`, and a restrictive Permissions Policy. Subdomain
transport enforcement requires separate verification that each subdomain uses
HTTPS. The content security policy starts in report-only mode.

## Permitted frames

The `frame-src` directive includes the published player origins and the two
election-map origins:

- `datawrapper.dwcdn.net`: Datawrapper maps in Custom HTML.
- `interactives.apelections.org`: Direct AP election layout frames from Embed.
- `flo.uri.sh`: Flourish chart and story frames.
- `player.pbs.org`: PBS and livestream players.
- `www.youtube-nocookie.com` and `www.youtube.com`: YouTube players.
- `player.vimeo.com`: Vimeo players.
- `www.tiktok.com`, `www.instagram.com`, and `www.facebook.com`: Supported embeds.
- `challenges.cloudflare.com`: Turnstile.
- `notifications.wisepops.com` and `wisepops.net`: Newsletter frames.

Pages with native video, a supported player, or sandboxed HTML that can load an
external frame or script omit site analytics. Election frames add no analytics.

## Other directives

Flourish scripts and noscript thumbnails use `public.flourish.studio` through
`script-src` and `img-src`. Generated chart and story frames use `flo.uri.sh`
through `frame-src`. Custom HTML stays sandboxed; no wildcard Flourish domain
is allowed.

Keep script and connection hosts limited to the public page's required services.
Inline script hashes must match the emitted bytes, including the staff-edit hint
script. Upload connections use the configured `PUBLIC_SHARE_UPLOAD_ORIGIN`; no
private account identifier belongs in the source policy.

Images can use the approved media origins and data URIs. The current site needs
inline styles; remove that allowance only after the affected rendering paths
use another supported method. Build-only API hosts need no browser connection
allowance. Navigation links need no frame allowance.

Geolocation is permitted only for the PBS livestream frame through its explicit
iframe permission. On-demand frames retain encrypted-media permission without
geolocation. The document permission must permit delegation to that frame.

Before changing report-only policy to enforcement, collect violations, exercise
the player, schedule, forms and supported embeds, and add only required observed
hosts. Keep reporting enabled when enforcement starts.
