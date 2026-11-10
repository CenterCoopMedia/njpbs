<?php
/** Local results for the existing Spotlight search page and header form. */
if (!defined('ABSPATH')) {
    exit;
}

// Keep the unavailable-state shortcode and header redirect independent of load order.
if (!defined('SPOTLIGHT_SEARCH_BLOG_ID')) {
    define('SPOTLIGHT_SEARCH_BLOG_ID', filter_var(getenv('NJSPOTLIGHT_BLOG_ID'),
        FILTER_VALIDATE_INT, array('options' => array('min_range' => 1))) ?: 0);
}
if (!defined('SPOTLIGHT_SEARCH_PAGE_ID')) {
    define('SPOTLIGHT_SEARCH_PAGE_ID', filter_var(getenv('NJSPOTLIGHT_SEARCH_PAGE_ID'),
        FILTER_VALIDATE_INT, array('options' => array('min_range' => 1))) ?: 0);
}
if (!SPOTLIGHT_SEARCH_BLOG_ID || !SPOTLIGHT_SEARCH_PAGE_ID) {
    return;
}

add_action('template_redirect', static function () {
    if (is_admin() || get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID) {
        return;
    }

    // The theme disables native search templates. Keep one public search URL.
    if (isset($_GET['s']) && is_string($_GET['s']) && !is_feed()) {
        $term = sanitize_text_field(wp_unslash($_GET['s']));
        $url = add_query_arg('q', rawurlencode($term), home_url('/search-results/'));
        wp_safe_redirect($url, 302, 'NJ Spotlight search');
        exit;
    }

    if (is_page(SPOTLIGHT_SEARCH_PAGE_ID)) {
        header('X-Robots-Tag: noindex, nofollow');
    }
}, 0);

add_action('init', static function () {
    // Retain the published page's existing shortcode without calling Google.
    if (!shortcode_exists('wnet-google-cse')) {
        add_shortcode('wnet-google-cse', 'spotlight_local_search_results');
    }
}, 20);

function spotlight_local_search_results() {
    if (get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID || !is_page(SPOTLIGHT_SEARCH_PAGE_ID)) {
        return '';
    }

    $term = isset($_GET['q']) && is_string($_GET['q'])
        ? trim(sanitize_text_field(wp_unslash($_GET['q']))) : '';
    $videos = isset($_GET['refine']) && $_GET['refine'] === 'videos';
    $page = isset($_GET['search_page']) && is_string($_GET['search_page'])
        ? filter_var($_GET['search_page'], FILTER_VALIDATE_INT, array(
            'options' => array('min_range' => 1, 'max_range' => 10000),
        )) : 1;

    $output = '<form action="' . esc_url(home_url('/search-results/')) . '" method="get" class="njs-search" aria-label="Search NJ Spotlight News">';
    $output .= '<input type="search" name="q" value="' . esc_attr($term) . '" placeholder="Search NJ Spotlight News" aria-label="Enter search terms" maxlength="200">';
    if ($videos) {
        $output .= '<input type="hidden" name="refine" value="videos">';
    }
    $output .= '<button aria-label="Submit search form">' . spotlight_svg('search') . '</button></form>';
    $output .= '<p>Search headlines, story text, summaries and bylines. Results show the newest matches first.</p>';

    if ($term === '') {
        return $output . '<p>Enter search terms to find stories, videos, and podcasts.</p>';
    }
    if (preg_match('/^.{0,200}$/us', $term) !== 1) {
        return $output . '<p>Use a shorter search, up to 200 characters.</p>';
    }
    if ($page === false) {
        return $output . '<p>That results page is not available. Submit your search again.</p>';
    }

    $post_ids = function_exists('spotlight_indexed_search')
        ? spotlight_indexed_search($term, $videos, $page) : new WP_Error('search_unavailable');
    if (is_wp_error($post_ids)) {
        if ($post_ids->get_error_code() === 'too_many_phrases') {
            return $output . '<p>Use at most eight quoted phrases.</p>';
        }
        return $output . '<p>Search is temporarily unavailable. Please try again shortly.</p>';
    }

    $output .= '<p>Results for <strong>' . esc_html($term) . '</strong></p>';
    if (!$post_ids) {
        $output .= '<p>No matching results. Try another search term.</p>';
    } else {
        $output .= '<div class="archive-main"><div class="post-list cf">';
        foreach (array_slice($post_ids, 0, 10) as $post_id) {
            $output .= spotlight_post_listing($post_id);
        }
        $output .= '</div></div>';
    }

    return $output . spotlight_local_search_pagination($term, $videos, $page, count($post_ids) > 10);
}

function spotlight_local_search_pagination($term, $videos, $page, $has_more) {
    if ($page === 1 && !$has_more) {
        return '';
    }

    $args = array('q' => rawurlencode($term));
    if ($videos) {
        $args['refine'] = 'videos';
    }
    $output = '<nav class="pagination faux" aria-label="Search results pages">';
    if ($page > 1) {
        $args['search_page'] = $page - 1;
        $output .= '<a class="prev page-numbers" href="' . esc_url(add_query_arg($args, home_url('/search-results/'))) . '">Previous results</a> ';
    }
    $output .= '<span class="page-numbers current" aria-current="page">' . esc_html((string) $page) . '</span> ';
    if ($has_more && $page < 10000) {
        $args['search_page'] = $page + 1;
        $output .= '<a class="next page-numbers" href="' . esc_url(add_query_arg($args, home_url('/search-results/'))) . '">More results</a>';
    }
    $output .= '</nav>';

    return $output;
}
