<?php
/** Run with wp eval-file after installing Relevanssi Free on the configured site only. */
if (!defined('SPOTLIGHT_SEARCH_BLOG_ID') || get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID || !function_exists('relevanssi_index_doc')) {
    throw new RuntimeException('Expected the configured Spotlight site with Relevanssi active');
}
$settings = array(
    'relevanssi_index_post_types' => spotlight_search_post_types(),
    'relevanssi_index_taxonomies_list' => array(),
    'relevanssi_index_author' => 'on',
    'relevanssi_index_excerpt' => 'on',
    'relevanssi_index_comments' => 'none',
    'relevanssi_index_fields' => '',
    'relevanssi_expand_shortcodes' => 'off',
    'relevanssi_implicit_operator' => 'AND',
    'relevanssi_disable_or_fallback' => 'on',
    'relevanssi_fuzzy' => 'never',
    'relevanssi_min_word_length' => 2,
    'relevanssi_stopwords' => array(),
    'relevanssi_ignore_theme_post_type' => 'off',
    'relevanssi_seo_noindex' => 'off',
    'relevanssi_default_orderby' => 'relevance',
    'relevanssi_throttle' => 'off',
    'relevanssi_admin_search' => 'off',
    'relevanssi_excerpts' => 'off',
    'relevanssi_highlight_docs' => 'off',
    'relevanssi_highlight_comments' => 'off',
    'relevanssi_hilite_title' => 'off',
    'relevanssi_log_queries' => 'off',
    'relevanssi_log_queries_with_ip' => 'off',
);
foreach ($settings as $key => $value) {
    update_option($key, $value, false);
}
echo 'Configured public title, body, summary and byline search', PHP_EOL;
