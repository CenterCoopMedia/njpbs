#!/bin/sh
set -eu

: "${NJSPOTLIGHT_BLOG_ID:?Set the configured WordPress blog ID}"
: "${NJSPOTLIGHT_POSTING_ACCOUNT:?Set the technical posting account name}"
: "${SPOTLIGHT_WP_PATH:?Set the WordPress install directory}"
: "${SPOTLIGHT_WP_URL:?Set the WordPress site URL}"

# The timer owns the lock. Store only aggregates, outside the public web root.
task_snapshot=$(mktemp /var/lib/spotlight-most-read/requests.XXXXXX)
trap 'rm -f "$task_snapshot"' EXIT HUP INT TERM
nice -n 10 python3 /usr/local/lib/spotlight-most-read/rank_requests.py \
    /var/log/nginx/access.log > "$task_snapshot"
chown root:www-data "$task_snapshot"
chmod 640 "$task_snapshot"
runuser -u www-data -- env NJSPOTLIGHT_CONTEXT=production \
    NJSPOTLIGHT_BLOG_ID="$NJSPOTLIGHT_BLOG_ID" \
    NJSPOTLIGHT_POSTING_ACCOUNT="$NJSPOTLIGHT_POSTING_ACCOUNT" /usr/local/bin/wp \
    spotlight-most-read import "$task_snapshot" \
    --path="$SPOTLIGHT_WP_PATH" --url="$SPOTLIGHT_WP_URL"
