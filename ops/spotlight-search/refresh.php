<?php
/** Dedicated WP-CLI job runner; never dispatches general WordPress cron. */
if (!defined('WP_CLI') || !WP_CLI || !defined('SPOTLIGHT_SEARCH_BLOG_ID') || get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID) {
    throw new RuntimeException('Expected WP-CLI in the configured Spotlight site');
}
echo wp_json_encode(array('refreshed' => spotlight_search_refresh_jobs(100, 2))), PHP_EOL;
