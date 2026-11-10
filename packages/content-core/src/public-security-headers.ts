import { BOARDWALK_EDIT_SCRIPT_HASH } from "./boardwalk-edit-script";
import { SHARE_UPLOAD_ORIGIN } from "./share-upload-origin";

export const SECURITY_HEADER_BASELINE = {
  "content-security-policy-report-only":
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' '${BOARDWALK_EDIT_SCRIPT_HASH}' https://jaws-prod.cdn.pbs.org https://public.flourish.studio https://challenges.cloudflare.com https://www.googletagmanager.com https://chimpstatic.com https://cdn.wisepops.com https://app.getwisp.co https://wisepops.net https://cdn.wisepops.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://public.flourish.studio https://image.pbs.org https://media.njpbs.org https://*.google-analytics.com https://www.googletagmanager.com https://cdn.wisepops.com https://tracking.wisepops.com https://dx4nr741tfc02.cloudfront.net https://wisp-production-storage.s3.amazonaws.com https://cdn.wisepops.net https://assets.wisepops.net; media-src 'self' https://media.njpbs.org; font-src 'self' https://media.njpbs.org; frame-src https://flo.uri.sh https://datawrapper.dwcdn.net https://interactives.apelections.org https://player.pbs.org https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.tiktok.com https://www.instagram.com https://www.facebook.com https://challenges.cloudflare.com https://notifications.wisepops.com https://wisepops.net; worker-src 'self'; connect-src 'self' https://huggingface.co https://us.aws.cdn.hf.co https://challenges.cloudflare.com https://report.njpbs.org https://intake.njpbs.org ${SHARE_UPLOAD_ORIGIN} https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://activity.wisepops.com https://tracking.wisepops.com https://app.getwisp.co https://wisepops.net; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'`,
  "permissions-policy":
    'geolocation=(self "https://player.pbs.org"), encrypted-media=(self "https://player.pbs.org" "https://www.youtube-nocookie.com" "https://www.youtube.com" "https://player.vimeo.com" "https://www.facebook.com"), camera=(), microphone=(), payment=(), usb=()',
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
} as const;
