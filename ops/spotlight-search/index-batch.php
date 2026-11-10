<?php
/** wp eval-file index-batch.php [batch size]; resumable, the configured site only. */
if (!defined('SPOTLIGHT_SEARCH_BLOG_ID') || get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID || !function_exists('relevanssi_index_doc')) {
    throw new RuntimeException('Expected the configured Spotlight site with Relevanssi active');
}
$limit = isset($args[0]) ? filter_var($args[0], FILTER_VALIDATE_INT) : 200;
if (!$limit || $limit < 1 || $limit > 500) {
    throw new RuntimeException('Batch size must be between 1 and 500');
}
global $wpdb;
if ((int) $wpdb->get_var($wpdb->prepare("SELECT GET_LOCK(%s, 0)", SPOTLIGHT_SEARCH_INDEX_LOCK)) !== 1) {
    throw new RuntimeException('Another Spotlight indexing batch is active');
}
try {
    $wpdb->query('SET SESSION max_statement_time = 15');
    $state = get_option('spotlight_search_build', array('cursor' => 0, 'processed' => 0));
    $hash = hash_file('sha256', __DIR__ . '/spotlight-indexed-search.php');
    if (isset($state['source']) && $state['source'] !== $hash) {
        throw new RuntimeException('Adapter changed during the build; reconcile before resuming');
    }
    $types = spotlight_search_post_types();
    $slots = implode(',', array_fill(0, count($types), '%s'));
    $ids = $wpdb->get_col($wpdb->prepare("SELECT ID FROM {$wpdb->posts}"
        . " WHERE ID > %d AND ID <> %d AND post_status = 'publish' AND post_password = ''"
        . " AND post_type IN ($slots) ORDER BY ID LIMIT %d",
        array_merge(array($state['cursor'], SPOTLIGHT_SEARCH_PAGE_ID), $types, array($limit))));
    if ($wpdb->last_error) {
        throw new RuntimeException('Could not read indexing batch');
    }
    $started = microtime(true);
    foreach ($ids as $id) {
        $result = spotlight_search_index_doc((int) $id, true);
        if ($wpdb->last_error || $result === -1) {
            throw new RuntimeException('Indexing failed at document ' . (int) $id);
        }
        $state['cursor'] = (int) $id;
        ++$state['processed'];
    }
    $state['source'] = $hash;
    $state['complete'] = count($ids) < $limit;
    $state['updated'] = gmdate('c');
    update_option('spotlight_search_build', $state, false);
    if ($wpdb->last_error) {
        throw new RuntimeException('Could not save indexing checkpoint');
    }
    echo wp_json_encode($state + array('batch' => count($ids),
        'seconds' => round(microtime(true) - $started, 3))), PHP_EOL;
} finally {
    $wpdb->query($wpdb->prepare("SELECT RELEASE_LOCK(%s)", SPOTLIGHT_SEARCH_INDEX_LOCK));
}
