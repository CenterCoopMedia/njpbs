<?php
/** Indexed public search for NJ Spotlight sites, using Relevanssi Free. */
if (!defined('ABSPATH')) {
    exit;
}

// Invalid or absent deployment configuration leaves this adapter inactive.
if (!defined('SPOTLIGHT_SEARCH_BLOG_ID')) {
    define('SPOTLIGHT_SEARCH_BLOG_ID', filter_var(getenv('NJSPOTLIGHT_BLOG_ID'),
        FILTER_VALIDATE_INT, array('options' => array('min_range' => 1))) ?: 0);
}
if (!defined('SPOTLIGHT_SEARCH_PAGE_ID')) {
    define('SPOTLIGHT_SEARCH_PAGE_ID', filter_var(getenv('NJSPOTLIGHT_SEARCH_PAGE_ID'),
        FILTER_VALIDATE_INT, array('options' => array('min_range' => 1))) ?: 0);
}
define('SPOTLIGHT_SEARCH_INDEX_LOCK', 'spotlight-search-index-' . SPOTLIGHT_SEARCH_BLOG_ID);
if (!SPOTLIGHT_SEARCH_BLOG_ID || !SPOTLIGHT_SEARCH_PAGE_ID) {
    return;
}

function spotlight_search_post_types() {
    return array('post', 'page', 'njt_video', 'podcast', 'special', 'special-report');
}

function spotlight_search_public_post($post) {
    return $post && $post->post_status === 'publish' && $post->post_password === ''
        && (int) $post->ID !== SPOTLIGHT_SEARCH_PAGE_ID && in_array($post->post_type, spotlight_search_post_types(), true);
}

/** The vendor can clear an INSERT error with a later metadata query. */
function spotlight_search_index_doc($id, $initial = false) {
    global $wpdb;
    $failed = false;
    $wpdb->last_error = '';
    $observe = static function ($query) use ($wpdb, &$failed) {
        if ($wpdb->last_error) {
            $failed = true;
        }
        return $query;
    };
    add_filter('query', $observe, PHP_INT_MAX);
    try {
        $result = $initial ? relevanssi_index_doc((int) $id, true, '', true)
            : relevanssi_insert_edit((int) $id);
        return $failed || $wpdb->last_error ? -1 : $result;
    } finally {
        remove_filter('query', $observe, PHP_INT_MAX);
    }
}

// Only the explicit query below uses Relevanssi; other WordPress queries keep their SQL.
function spotlight_search_native_queries($allowed) {
    return get_current_blog_id() === SPOTLIGHT_SEARCH_BLOG_ID ? false : $allowed;
}
add_filter('relevanssi_search_ok', 'spotlight_search_native_queries', PHP_INT_MAX);
add_filter('relevanssi_admin_search_ok', 'spotlight_search_native_queries', PHP_INT_MAX);
add_filter('relevanssi_prevent_default_request', 'spotlight_search_native_queries', PHP_INT_MAX);

add_filter('relevanssi_valid_status', static function ($statuses) {
    return get_current_blog_id() === SPOTLIGHT_SEARCH_BLOG_ID ? array('publish') : $statuses;
});

function spotlight_search_index_restriction($restriction) {
    if (get_current_blog_id() === SPOTLIGHT_SEARCH_BLOG_ID) {
        $restriction['mysql'] .= " AND post.post_password = '' AND post.ID <> " . SPOTLIGHT_SEARCH_PAGE_ID;
    }
    return $restriction;
}
add_filter('relevanssi_indexing_restriction', 'spotlight_search_index_restriction');

add_filter('relevanssi_do_not_index', static function ($blocked, $id, $post) {
    if (get_current_blog_id() === SPOTLIGHT_SEARCH_BLOG_ID && !spotlight_search_public_post($post)) {
        return 'Outside public Spotlight search';
    }
    return $blocked;
}, 20, 3);

add_filter('relevanssi_post_author', static function ($name, $post) {
    if (get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID || !function_exists('get_coauthors')) {
        return $name;
    }
    return implode(' ', array_map(static function ($author) {
        return sanitize_text_field($author->display_name);
    }, get_coauthors($post->ID)));
}, 20, 2);

/** Phrase matches use story text or a public Co-Authors Plus display name. */
function spotlight_search_phrase_sql($phrase) {
    global $wpdb, $coauthors_plus;
    $like = '%' . $wpdb->esc_like($phrase) . '%';
    $parts = array();
    foreach (array('post_title', 'post_excerpt', 'post_content') as $column) {
        $parts[] = $wpdb->prepare("p.$column LIKE %s", $like);
    }
    if (isset($coauthors_plus) && taxonomy_exists('author')) {
        $wpdb->last_error = '';
        $terms = get_terms(array('taxonomy' => 'author', 'hide_empty' => true,
            'description__like' => $phrase, 'number' => 101, 'update_term_meta_cache' => false));
        // The extra candidate detects overflow; never use a partial author list.
        if ($wpdb->last_error || is_wp_error($terms) || count($terms) > 100) {
            return new WP_Error('search_unavailable');
        }
        $ids = array();
        foreach ($terms as $term) {
            $author = $coauthors_plus->get_coauthor_by('user_login', $term->name);
            if ($wpdb->last_error) {
                return new WP_Error('search_unavailable');
            }
            if (!$author) {
                continue;
            }
            $matched = preg_match('/' . preg_quote($phrase, '/') . '/iu', $author->display_name);
            if ($matched === false) {
                return new WP_Error('search_unavailable');
            }
            if ($matched === 1) {
                $ids[] = (int) $term->term_taxonomy_id;
            }
        }
        if ($ids) {
            $parts[] = "EXISTS (SELECT 1 FROM {$wpdb->term_relationships} tr"
                . ' WHERE tr.object_id = p.ID AND tr.term_taxonomy_id IN (' . implode(',', $ids) . '))';
        }
    }
    return '(' . implode(' OR ', $parts) . ')';
}

/** Return IDs only: Never hydrate every matching article's body into PHP. */
function spotlight_indexed_search($term, $videos, $page) {
    global $wpdb, $relevanssi_variables;
    if (get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID || !function_exists('relevanssi_tokenize')
        || ($relevanssi_variables['plugin_version'] ?? '') !== '4.28.4'
        || !get_option('spotlight_search_ready')) {
        return new WP_Error('search_unavailable');
    }
    if (!is_string($term) || preg_match('/^.{1,200}$/us', $term) !== 1
        || !is_int($page) || $page < 1 || $page > 10000) {
        return new WP_Error('invalid_search');
    }
    preg_match_all('/-?"[^"\r\n]*(?:"|$)|[^\s]+/u', $term, $matches);
    $positive = array();
    $negative = array();
    $phrases = array();
    $excluded_phrases = array();
    foreach ($matches[0] as $word) {
        $excluded = str_starts_with($word, '-') && strlen($word) > 1;
        $word = $excluded ? substr($word, 1) : $word;
        $phrase = str_starts_with($word, '"');
        $word = trim($word, '"');
        if ($excluded && $phrase) {
            $excluded_phrases[] = $word;
        } elseif ($excluded) {
            $negative[] = $word;
        } else {
            $positive[] = $word;
            if ($phrase && $word !== '') {
                $phrases[] = $word;
            }
        }
    }
    // Bound positive and excluded phrases together before any author lookup.
    if (count($phrases) + count($excluded_phrases) > 8) {
        return new WP_Error('too_many_phrases');
    }
    $tokens = array_map('trim', array_keys(relevanssi_tokenize(implode(' ', $positive), false, 2, 'search_query')));
    $excluded_tokens = array_map('trim', array_keys(relevanssi_tokenize(implode(' ', $negative), false, 2, 'search_query')));
    if (!$tokens) {
        return array();
    }
    $index = $wpdb->prefix . 'relevanssi';
    $types = $videos ? array('njt_video') : spotlight_search_post_types();
    $type_slots = implode(',', array_fill(0, count($types), '%s'));
    $where = array("p.post_status = 'publish'", "p.post_password = ''", 'p.ID <> ' . SPOTLIGHT_SEARCH_PAGE_ID,
        $wpdb->prepare("p.post_type IN ($type_slots)", $types));
    // Let the optimizer start with a selective term, then check the other terms by document.
    foreach ($tokens as $number => $token) {
        $alias = 'positive' . $number;
        $where[] = $wpdb->prepare("EXISTS (SELECT 1 FROM $index $alias IGNORE INDEX (typeitem)"
            . " WHERE $alias.doc = p.ID AND $alias.type = 'post' AND $alias.term = %s)", $token);
    }
    if ($excluded_tokens) {
        $slots = implode(',', array_fill(0, count($excluded_tokens), '%s'));
        $where[] = $wpdb->prepare("NOT EXISTS (SELECT 1 FROM $index excluded WHERE excluded.doc = p.ID"
            . " AND excluded.type = 'post' AND excluded.term IN ($slots))", $excluded_tokens);
    }
    foreach (array(array($phrases, ''), array($excluded_phrases, 'NOT ')) as [$list, $prefix]) {
        foreach ($list as $phrase) {
            $condition = spotlight_search_phrase_sql($phrase);
            if (is_wp_error($condition)) {
                return $condition;
            }
            $where[] = $prefix . $condition;
        }
    }
    // Recheck current post visibility even if an old index entry survives a failed update.
    $sql = "SELECT p.ID FROM {$wpdb->posts} p WHERE " . implode(' AND ', $where)
        . $wpdb->prepare(' ORDER BY p.post_date DESC, p.ID DESC LIMIT 11 OFFSET %d', ($page - 1) * 10);
    // Avoid materializing entire common-term lists before the limited result query.
    $ids = $wpdb->get_col("SET STATEMENT max_statement_time=2, optimizer_switch='materialization=off' FOR " . $sql);
    return $wpdb->last_error ? new WP_Error('search_unavailable') : array_map('intval', $ids);
}

// Author changes can affect thousands of stories. Save jobs before doing bounded work.
function spotlight_search_queue_author_posts($term_id) {
    if (get_current_blog_id() === SPOTLIGHT_SEARCH_BLOG_ID) {
        $GLOBALS['spotlight_search_author_terms'][(int) $term_id] = true;
    }
}
add_action('edited_author', 'spotlight_search_queue_author_posts');
add_action('set_object_terms', static function ($object_id, $terms, $tt_ids, $taxonomy) {
    if (get_current_blog_id() === SPOTLIGHT_SEARCH_BLOG_ID && $taxonomy === 'author') {
        $GLOBALS['spotlight_search_refresh'][(int) $object_id] = true;
    }
}, 20, 4);

function spotlight_search_save_job($job) {
    $name = 'spotlight_search_job_' . wp_generate_uuid4();
    if (!add_option($name, $job, '', false)) {
        error_log('Could not persist Spotlight search refresh job');
    }
    spotlight_search_schedule_refresh();
}

function spotlight_search_schedule_refresh() {
    if (!wp_next_scheduled('spotlight_search_refresh_jobs')) {
        $result = wp_schedule_single_event(time() + 30, 'spotlight_search_refresh_jobs', array(), true);
        if (is_wp_error($result)) {
            error_log('Could not schedule saved Spotlight search refresh jobs');
        }
    }
}

/** The existing production cron runner drains persisted jobs in bounded batches. */
function spotlight_search_refresh_jobs($limit = 100, $seconds = 2) {
    global $wpdb;
    if (get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID || !function_exists('relevanssi_insert_edit')) {
        return 0;
    }
    if ((int) $wpdb->get_var($wpdb->prepare("SELECT GET_LOCK(%s, 0)", SPOTLIGHT_SEARCH_INDEX_LOCK)) !== 1) {
        spotlight_search_schedule_refresh();
        return 0;
    }
    $processed = 0;
    $deadline = microtime(true) + $seconds;
    try {
        $like = $wpdb->esc_like('spotlight_search_job_') . '%';
        while ($processed < $limit && microtime(true) < $deadline) {
            $name = $wpdb->get_var($wpdb->prepare("SELECT option_name FROM {$wpdb->options}"
                . ' WHERE option_name LIKE %s ORDER BY option_id LIMIT 1', $like));
            if (!$name) {
                break;
            }
            // Save the continuation before work so a timeout cannot strand the queue.
            spotlight_search_schedule_refresh();
            $job = get_option($name);
            if (!is_array($job) || (!isset($job['ids']) && !isset($job['term'], $job['cursor']))) {
                error_log('Invalid Spotlight search refresh job retained');
                return $processed;
            }
            $ids = isset($job['ids']) ? array_slice($job['ids'], 0, $limit - $processed)
                : $wpdb->get_col($wpdb->prepare("SELECT tr.object_id FROM {$wpdb->term_relationships} tr"
                    . " JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id=tr.term_taxonomy_id"
                    . " WHERE tt.taxonomy='author' AND tt.term_id=%d AND tr.object_id<%d"
                    . ' ORDER BY tr.object_id DESC LIMIT %d', $job['term'], $job['cursor'], $limit - $processed));
            if ($wpdb->last_error) {
                error_log('Could not read Spotlight search refresh batch');
                break;
            }
            if (!$ids) {
                delete_option($name);
                continue;
            }
            foreach ($ids as $id) {
                if (microtime(true) >= $deadline) {
                    break;
                }
                $result = spotlight_search_index_doc((int) $id);
                if ($wpdb->last_error || $result === -1) {
                    error_log('Spotlight search refresh failed; saved job retained');
                    return $processed;
                }
                if (isset($job['ids'])) {
                    array_shift($job['ids']);
                } else {
                    $job['cursor'] = (int) $id;
                }
                if (!update_option($name, $job, false)) {
                    error_log('Spotlight search checkpoint failed; saved job retained');
                    return $processed;
                }
                ++$processed;
            }
        }
    } finally {
        $wpdb->query($wpdb->prepare("SELECT RELEASE_LOCK(%s)", SPOTLIGHT_SEARCH_INDEX_LOCK));
    }
    return $processed;
}
add_action('spotlight_search_refresh_jobs', 'spotlight_search_refresh_jobs');

// CAP clears its caches after term hooks. Queue at shutdown, then refresh a small batch.
add_action('shutdown', static function () {
    if (get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID || !function_exists('relevanssi_insert_edit')) {
        return;
    }
    foreach (array_keys($GLOBALS['spotlight_search_author_terms'] ?? array()) as $term) {
        spotlight_search_save_job(array('term' => $term, 'cursor' => PHP_INT_MAX));
    }
    $ids = array_keys($GLOBALS['spotlight_search_refresh'] ?? array());
    if ($ids) {
        spotlight_search_save_job(array('ids' => $ids));
    }
    if ($ids || !empty($GLOBALS['spotlight_search_author_terms'])) {
        spotlight_search_refresh_jobs(25, 1);
    }
}, 20);
