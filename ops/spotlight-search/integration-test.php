<?php
/**
 * Real WordPress/CAP/Relevanssi checks for the disposable search fixture.
 * Run separate requests: seed, drain refresh.php, assert, mutate,
 * assert-queued, drain refresh.php, assert-fresh. The jobs phase counts saved jobs.
 * Run assert-retry separately to check contention with another database connection.
 * Run assert-index-failure to check persisted retries after a real failed INSERT.
 * Keep corpus-sample.jsonl in this directory beside integration-test.php.
 */
if (!defined('WP_CLI') || !WP_CLI || !defined('SPOTLIGHT_SEARCH_BLOG_ID') || get_current_blog_id() !== SPOTLIGHT_SEARCH_BLOG_ID
    || get_option('siteurl') !== 'http://search-fixture.example.test'
) {
    throw new RuntimeException('This test runs only in the isolated Spotlight fixture');
}
if (!function_exists('spotlight_indexed_search') || !function_exists('relevanssi_index_doc')
    || !function_exists('get_coauthors')
) {
    throw new RuntimeException('Load the search adapter, Relevanssi and Co-Authors Plus first');
}

$phase = $args[0] ?? '';
$GLOBALS['spotlight_test_checks'] = 0;

function spotlight_test_check($condition, $label) {
    if (!$condition) {
        throw new RuntimeException('FAIL: ' . $label);
    }
    ++$GLOBALS['spotlight_test_checks'];
    echo 'PASS: ', $label, PHP_EOL;
}

function spotlight_test_api($result, $label) {
    if (is_wp_error($result)) {
        throw new RuntimeException($label . ': ' . $result->get_error_message());
    }
    return $result;
}

function spotlight_test_ids($term, $videos = false, $page = 1) {
    global $wpdb;
    $ids = spotlight_test_api(spotlight_indexed_search($term, $videos, $page), 'Search ' . $term);
    spotlight_test_check($wpdb->last_error === '', 'Search SQL succeeds: ' . $term);
    return array_map('intval', $ids);
}

function spotlight_test_matches($term, $expected, $label, $videos = false, $page = 1) {
    $actual = spotlight_test_ids($term, $videos, $page);
    spotlight_test_check($actual === $expected,
        $label . ' (expected ' . json_encode($expected) . ', got ' . json_encode($actual) . ')');
}

function spotlight_test_user($login, $name, $role = 'author') {
    $user = get_user_by('login', $login);
    $data = array('display_name' => $name, 'role' => $role);
    if ($user) {
        $data['ID'] = $user->ID;
        return spotlight_test_api(wp_update_user($data), 'Update fixture user');
    }
    $data += array('user_login' => $login, 'user_email' => $login . '@example.org',
        'user_pass' => wp_generate_password());
    return spotlight_test_api(wp_insert_user($data), 'Create fixture user');
}

function spotlight_test_post($id, $title, $content = '', $extra = array()) {
    $data = $extra + array('post_title' => $title, 'post_content' => $content,
        'post_excerpt' => '', 'post_type' => 'post', 'post_status' => 'publish', 'post_password' => '',
        'post_author' => (int) get_option('spotlight_test_reporter'),
        'post_date' => '2020-01-01 12:00:00', 'post_date_gmt' => '2020-01-01 12:00:00');
    $data[get_post($id) ? 'ID' : 'import_id'] = $id;
    $created = spotlight_test_api(wp_insert_post($data, true), 'Save fixture post');
    spotlight_test_check((int) $created === $id, 'Fixture post retains ID ' . $id);
    return $created;
}

function spotlight_test_assign($post_id, $author) {
    global $coauthors_plus;
    $term = spotlight_test_api($coauthors_plus->update_author_term($author), 'Save author term');
    if (!$term) {
        throw new RuntimeException('No author term for fixture author');
    }
    spotlight_test_api(wp_set_object_terms($post_id, array($term->slug), 'author'), 'Assign coauthor');
}

function spotlight_test_rename_guest($id, $name) {
    global $coauthors_plus;
    $saved_post = $_POST;
    $_POST['guest-author-nonce'] = wp_create_nonce('guest-author-nonce');
    $_POST['cap-display_name'] = $name;
    try {
        spotlight_test_api(wp_update_post(array('ID' => $id, 'post_title' => $name), true), 'Save guest author through CAP');
    } finally {
        $_POST = $saved_post;
    }
    spotlight_test_check($coauthors_plus->guest_authors->get_guest_author_by('ID', $id)->display_name === $name,
        'CAP saved guest display name ' . $name);
}

function spotlight_test_job_count() {
    global $wpdb;
    return (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE %s",
        $wpdb->esc_like('spotlight_search_job_') . '%'));
}

function spotlight_test_all_ids($term) {
    $all = array();
    for ($page = 1; $page <= 10; ++$page) {
        $ids = spotlight_test_ids($term, false, $page);
        $all = array_merge($all, array_slice($ids, 0, 10));
        if (count($ids) <= 10) {
            return $all;
        }
    }
    throw new RuntimeException('Large-author fixture unexpectedly exceeds 100 results');
}

function spotlight_test_seed() {
    global $coauthors_plus;
    $admin = spotlight_test_user('search-fixture-admin', 'Fixture Administrator', 'administrator');
    $reporter = spotlight_test_user('search-fixture-reporter', 'Fixture Reporter');
    $riverbyline = spotlight_test_user('search-fixture-riverbyline', 'Riverbyline Reporter');
    $azure = spotlight_test_user('loginonlyprobe', 'Azure Reporter');
    $amber = spotlight_test_user('search-fixture-amber', 'Amber Journalist');
    $large = spotlight_test_user('search-fixture-large-author', 'Saffron Reporter');
    $unicode = spotlight_test_user('search-fixture-unicode', 'José Álvarez');
    update_option('spotlight_test_reporter', $reporter);
    update_option('spotlight_test_admin', $admin);
    update_option('spotlight_test_azure', $azure);
    update_option('spotlight_test_amber', $amber);
    update_option('spotlight_test_large_author', $large);
    wp_set_current_user($admin);

    $corpus = dirname(__FILE__) . '/corpus-sample.jsonl';
    $lines = file($corpus, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) {
        throw new RuntimeException('Missing synthetic corpus: ' . $corpus);
    }
    foreach ($lines as $line) {
        $row = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
        $id = (int) $row['ID'];
        unset($row['ID']);
        $row['post_author'] = $id === 800001 ? $riverbyline : $reporter;
        spotlight_test_post($id, $row['post_title'], $row['post_content'], $row);
        spotlight_test_assign($id, get_user_by('id', $row['post_author']));
    }
    spotlight_test_check(count($lines) === 18, 'Import all 18 synthetic public articles');

    $guest = $coauthors_plus->guest_authors->get_guest_author_by('user_login', 'search-fixture-guest');
    if (!$guest) {
        $guest_id = spotlight_test_api($coauthors_plus->guest_authors->create(array(
            'user_login' => 'search-fixture-guest', 'display_name' => 'Teal Visitor',
            'user_email' => 'privateemailprobe@example.org')), 'Create guest author');
        $guest = $coauthors_plus->guest_authors->get_guest_author_by('ID', $guest_id);
    }
    update_option('spotlight_test_guest', $guest->ID);
    spotlight_test_rename_guest($guest->ID, 'Teal Visitor');
    $guest = $coauthors_plus->guest_authors->get_guest_author_by('ID', $guest->ID);

    spotlight_test_post(900101, 'fixtureand alpha', 'gamma', array('post_excerpt' => 'beta'));
    spotlight_test_assign(900101, get_user_by('id', $azure));
    spotlight_test_post(900102, 'fixturetoken NJ UP');
    spotlight_test_post(900103, 'fixturephrase river basin');
    spotlight_test_post(900104, 'fixturephrase river delta basin');
    spotlight_test_post(900105, 'fixturehtml', 'Union <strong>Pacific</strong>');
    spotlight_test_post(900106, 'fixtureliteral', 'Union Pacific railroad');
    spotlight_test_post(900107, 'fixtureliteral', 'Pacific Union railroad');
    spotlight_test_post(900110, 'fixtureexclude metro', 'railroad merger');
    spotlight_test_post(900111, 'fixtureexclude metro', 'railroad proposed merger');
    spotlight_test_post(900112, 'fixturenumeric', '1869');
    spotlight_test_post(900113, 'fixturenumeric', '1870');
    foreach (array('post', 'page', 'njt_video', 'podcast', 'special', 'special-report') as $i => $type) {
        spotlight_test_post(900120 + $i, 'fixturetypes', '', array('post_type' => $type));
    }

    spotlight_test_post(900199, 'fixturepaging', '', array(
        'post_date' => '2020-03-01 12:00:00', 'post_date_gmt' => '2020-03-01 12:00:00'));
    for ($i = 0; $i < 24; ++$i) {
        $date = sprintf('2020-01-%02d 12:00:00', 1 + intdiv($i, 4));
        spotlight_test_post(900200 + $i, 'fixturepaging', '', array('post_date' => $date, 'post_date_gmt' => $date));
    }

    spotlight_test_post(900300, 'fixtureprivacy', '', array('post_status' => 'draft'));
    spotlight_test_post(900301, 'fixtureprivacy', '', array('post_status' => 'private'));
    spotlight_test_post(900302, 'fixtureprivacy', '', array('post_status' => 'future',
        'post_date' => '2099-01-01 12:00:00', 'post_date_gmt' => '2099-01-01 12:00:00'));
    spotlight_test_post(900303, 'fixtureprivacy', '', array('post_password' => 'fixture-only-password'));
    spotlight_test_post(900304, 'fixtureprivacy', '', array('post_type' => 'attachment'));
    spotlight_test_post(SPOTLIGHT_SEARCH_PAGE_ID, 'fixtureprivacy', '', array('post_type' => 'page'));
    spotlight_test_post(900305, 'fixtureprivacy');

    spotlight_test_post(900400, 'fixtureupdate oldword');
    spotlight_test_post(900401, 'fixtureunpublish');
    spotlight_test_post(900402, 'fixturedelete');
    spotlight_test_post(900403, 'fixturepublish', '', array('post_status' => 'draft'));
    spotlight_test_post(900404, 'fixturepassword');
    spotlight_test_post(900405, 'fixtureassign');
    spotlight_test_post(900406, 'fixturebyline');
    spotlight_test_assign(900405, get_user_by('id', $azure));
    spotlight_test_assign(900406, get_user_by('id', $azure));

    spotlight_test_post(900407, 'fixtureguest');
    spotlight_test_assign(900407, $guest);
    spotlight_test_post(900408, 'fixtureunicode');
    spotlight_test_assign(900408, get_user_by('id', $unicode));
    spotlight_test_post(900409, 'fixtureunicode');
    spotlight_test_assign(900409, get_user_by('id', $reporter));
    for ($id = 900600; $id < 900660; ++$id) {
        spotlight_test_post($id, 'fixturelargeauthor');
        spotlight_test_assign($id, get_user_by('id', $large));
    }
    update_option('spotlight_test_seeded', true);
}

function spotlight_test_assert() {
    global $wpdb, $relevanssi_variables;
    wp_set_current_user(0);
    spotlight_test_matches('riverbyline railroad', array(800001), 'Reported mixed author/body query finds merger article');
    spotlight_test_check(in_array(800001, spotlight_test_ids('union pacific'), true),
        'Synthetic body-only query finds merger article among synthetic phrase fixtures');
    spotlight_test_matches('alpha beta gamma azure', array(900101), 'Required terms combine title, summary, body and public author');
    spotlight_test_matches('"river basin" fixturephrase', array(900103), 'Quoted phrase requires adjacency');
    spotlight_test_matches('fixtureliteral "Union Pacific"', array(900106), 'Quoted body phrase matches literal order');
    spotlight_test_matches('fixturehtml union pacific', array(900105), 'Unquoted body terms survive HTML');
    spotlight_test_matches('fixturehtml "Union Pacific"', array(), 'Quoted phrase keeps native literal body semantics');
    spotlight_test_matches('fixtureexclude -proposed', array(900110), 'Body exclusion removes matching candidate');
    spotlight_test_matches('fixtureexclude -metro', array(), 'Title exclusion removes every candidate');
    spotlight_test_matches('fixtureexclude -"railroad merger"', array(900111), 'Quoted exclusion keeps literal phrase semantics');
    spotlight_test_matches('-"railroad merger"', array(), 'Phrase exclusion alone does not trigger an archive scan');
    spotlight_test_check(in_array(800001, spotlight_test_ids('1869'), true), 'Numeric body term finds synthetic merger article');
    spotlight_test_matches('riverbyline railroad -1869', array(), 'Negative numeric term excludes synthetic merger article');
    spotlight_test_matches('fixturenumeric 1869', array(900112), 'Numeric token matches stored index normalization');
    spotlight_test_matches('fixturenumeric -1869', array(900113), 'Negative numeric token remains a required exclusion');
    spotlight_test_matches('fixturetoken NJ', array(900102), 'Two-character NJ term remains required');
    spotlight_test_matches('fixturetoken UP', array(900102), 'Two-character UP term remains required');
    spotlight_test_matches('fixturetoken ZZ', array(), 'Absent short term cannot silently disappear');
    spotlight_test_matches('nonexistentfixtureword', array(), 'Empty candidate set stays empty');
    spotlight_test_matches('fixturetypes', array(900125, 900124, 900123, 900122, 900121, 900120), 'All six public content types are searchable');
    spotlight_test_matches('fixturetypes', array(900122), 'Video refinement restricts content type', true);
    spotlight_test_matches('riverbyline railroad', array(), 'Video refinement excludes an ordinary article', true);
    spotlight_test_matches('loginonlyprobe', array(), 'Technical author login is not indexed');
    spotlight_test_matches('privateemailprobe', array(), 'Author email is not indexed');
    spotlight_test_matches('fixtureguest teal', array(900407), 'Guest author public display name is indexed');
    spotlight_test_matches('fixturebyline azure', array(900406), 'Registered public display name is indexed');
    spotlight_test_matches('fixtureand "Azure Reporter"', array(900101), 'Quoted public author name combines with topic');
    spotlight_test_matches('fixtureunicode "josé álvarez"', array(900408), 'Quoted author matching folds Unicode case');
    spotlight_test_matches('fixtureunicode "JOSÉ ÁLVAREZ"', array(900408), 'Uppercase Unicode author phrase matches public byline');
    spotlight_test_matches('fixtureunicode -"josé álvarez"', array(900409), 'Quoted Unicode exclusion removes byline-only matches');

    $ordered = array_merge(array(900199), range(900223, 900200));
    $shown = array();
    for ($page = 1; $page <= 3; ++$page) {
        $expected = array_slice($ordered, ($page - 1) * 10, 11);
        spotlight_test_matches('fixturepaging', $expected, 'Newest date and descending ID pagination page ' . $page, false, $page);
        $shown = array_merge($shown, array_slice($expected, 0, 10));
    }
    spotlight_test_check($shown === $ordered && count(array_unique($shown)) === 25, 'Displayed pagination has no gaps or duplicates');
    spotlight_test_matches('fixturepaging', array(), 'Page beyond final results is empty', false, 4);

    $blocked = array(900300, 900301, 900302, 900303, 900304, SPOTLIGHT_SEARCH_PAGE_ID);
    $table = $relevanssi_variables['relevanssi_table'];
    $ids_sql = implode(',', $blocked);
    spotlight_test_check((int) $wpdb->get_var("SELECT COUNT(*) FROM $table WHERE doc IN ($ids_sql)") === 0,
        'Index contains no private, unpublished, protected or disallowed content');
    // Deliberate stale rows prove admission checks survive an outdated provider index.
    foreach ($blocked as $id) {
        $inserted = $wpdb->replace($table, array('doc' => $id, 'term' => 'fixtureprivacy',
            'term_reverse' => strrev('fixtureprivacy'), 'content' => 1, 'type' => 'post',
            'taxonomy_detail' => '', 'customfield_detail' => '', 'mysqlcolumn_detail' => ''));
        spotlight_test_check($inserted !== false, 'Inject stale test index row ' . $id);
    }
    spotlight_test_matches('fixtureprivacy', array(900305), 'Anonymous searches reject stale nonpublic index rows');
    wp_set_current_user((int) get_option('spotlight_test_admin'));
    spotlight_test_matches('fixtureprivacy', array(900305), 'Staff searches remain published and passwordless');
    wp_set_current_user(0);
    $wpdb->query("DELETE FROM $table WHERE doc IN ($ids_sql)");
    spotlight_test_check($wpdb->last_error === '', 'Remove deliberate stale index rows');

    $native = new WP_Query(array('s' => 'fixtureexclude -proposed', 'fields' => 'ids',
        'post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => -1));
    spotlight_test_check(array_map('intval', $native->posts) === array(900110), 'Unrelated native WordPress search retains exclusion behavior');
    spotlight_test_matches("fixtureexclude' OR 1=1 --", array(), 'SQL-looking input cannot broaden results');
    spotlight_test_matches('fixtureupdate oldword', array(900400), 'Content update baseline is indexed');
    spotlight_test_matches('fixtureunpublish', array(900401), 'Unpublish baseline is indexed');
    spotlight_test_matches('fixturedelete', array(900402), 'Deletion baseline is indexed');
    spotlight_test_matches('fixturepublish', array(), 'Unpublished baseline is excluded');
    spotlight_test_matches('fixtureassign azure', array(900405), 'Assignment baseline has original author');
    spotlight_test_check(spotlight_test_job_count() === 0, 'Saved seed refresh jobs were drained in separate requests');
    spotlight_test_check(spotlight_test_all_ids('fixturelargeauthor saffron') === range(900659, 900600),
        'All 60 large-author articles have the original public name');
}

function spotlight_test_mutate() {
    global $coauthors_plus;
    wp_set_current_user((int) get_option('spotlight_test_admin'));
    spotlight_test_api(wp_update_post(array('ID' => 900400, 'post_title' => 'fixtureupdate newword'), true), 'Edit article');
    spotlight_test_api(wp_update_post(array('ID' => 900401, 'post_status' => 'draft'), true), 'Unpublish article');
    spotlight_test_check((bool) wp_delete_post(900402, true), 'Delete article through WordPress');
    spotlight_test_api(wp_update_post(array('ID' => 900403, 'post_status' => 'publish'), true), 'Publish article');
    spotlight_test_api(wp_update_post(array('ID' => 900404, 'post_password' => 'fixture-only-password'), true), 'Protect article');
    spotlight_test_matches('fixtureupdate oldword', array(), 'Edited article immediately loses old text');
    spotlight_test_matches('fixtureupdate newword', array(900400), 'Edited article immediately gains new text');
    spotlight_test_matches('fixtureunpublish', array(), 'Unpublished article immediately leaves search');
    spotlight_test_matches('fixturedelete', array(), 'Deleted article immediately leaves search');
    spotlight_test_matches('fixturepublish', array(900403), 'Newly published article immediately enters search');
    spotlight_test_matches('fixturepassword', array(), 'Newly password-protected article immediately leaves search');

    spotlight_test_assign(900405, get_user_by('id', (int) get_option('spotlight_test_amber')));
    spotlight_test_api(wp_update_user(array('ID' => (int) get_option('spotlight_test_azure'),
        'display_name' => 'Vermilion Correspondent')), 'Rename registered author');
    spotlight_test_rename_guest((int) get_option('spotlight_test_guest'), 'Cobalt Writer');
    spotlight_test_api(wp_update_user(array('ID' => (int) get_option('spotlight_test_large_author'),
        'display_name' => 'Indigo Contributor')), 'Rename author with 60 articles');
    echo 'Check saved jobs in the next request, drain them, then assert freshness.', PHP_EOL;
}

function spotlight_test_assert_queued() {
    wp_set_current_user(0);
    spotlight_test_check(spotlight_test_job_count() > 0, 'Large author rename persists unfinished jobs after shutdown');
    $old = spotlight_test_all_ids('fixturelargeauthor saffron');
    $new = spotlight_test_all_ids('fixturelargeauthor indigo');
    spotlight_test_check(count($old) >= 35 && count($new) <= 25, 'Shutdown refresh stays within its 25-document bound');
    $combined = array_merge($old, $new);
    sort($combined);
    spotlight_test_check($combined === range(900600, 900659), 'Partial refresh retains every large-author article');
}

function spotlight_test_assert_retry() {
    global $wpdb;
    spotlight_test_check(spotlight_test_job_count() === 0, 'Lock retry starts with a drained fixture queue');
    $foreign = new wpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
    try {
        spotlight_test_check($foreign->get_var('SELECT CONNECTION_ID()') !== $wpdb->get_var('SELECT CONNECTION_ID()'),
            'Contention uses a separate actual database connection');
        spotlight_test_check((int) $foreign->get_var($wpdb->prepare("SELECT GET_LOCK(%s, 0)", SPOTLIGHT_SEARCH_INDEX_LOCK)) === 1,
            'Foreign database connection holds the search index lock');
        $job = array('ids' => array(800001));
        spotlight_search_save_job($job);
        $name = $wpdb->get_var($wpdb->prepare("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s",
            $wpdb->esc_like('spotlight_search_job_') . '%'));
        spotlight_test_check($name && get_option($name) === $job, 'Refresh job is persisted before lock contention');
        $stored = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name=%s", $name));
        spotlight_test_api(wp_clear_scheduled_hook('spotlight_search_refresh_jobs', array(), true), 'Consume only search continuation');
        spotlight_test_check(wp_next_scheduled('spotlight_search_refresh_jobs') === false, 'Consumed search event has no scheduled continuation');
        spotlight_test_check(spotlight_search_refresh_jobs(100, 2) === 0, 'Contended refresh returns without indexing');
        spotlight_test_check(spotlight_test_job_count() === 1 && $wpdb->get_var($wpdb->prepare(
            "SELECT option_value FROM {$wpdb->options} WHERE option_name=%s", $name)) === $stored,
            'Contended refresh retains the unchanged persisted job');
        spotlight_test_check(wp_next_scheduled('spotlight_search_refresh_jobs') !== false,
            'Contended refresh rearms the consumed continuation');
    } finally {
        $foreign->query($wpdb->prepare("SELECT RELEASE_LOCK(%s)", SPOTLIGHT_SEARCH_INDEX_LOCK));
        $foreign->close();
    }
    spotlight_test_check(spotlight_search_refresh_jobs(100, 2) === 1, 'Released lock permits the saved job to drain');
    spotlight_test_check(get_option($name, false) === false && spotlight_test_job_count() === 0,
        'Successful retry completes and removes the saved job');
    spotlight_test_matches('riverbyline railroad', array(800001), 'Retry preserves the reported merger article result');
}

function spotlight_test_failed_insert($operation) {
    global $wpdb, $relevanssi_variables;
    $index = $relevanssi_variables['relevanssi_table'];
    $missing = $wpdb->prefix . 'spotlight_search_missing_fixture';
    spotlight_test_check($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($missing))) === null,
        'Owned fault table does not exist in the isolated fixture');
    $injected = 0;
    $fault = static function ($query) use ($index, $missing, &$injected) {
        $prefix = 'INSERT IGNORE INTO ' . $index . ' ';
        if (str_starts_with($query, $prefix)) {
            ++$injected;
            return 'INSERT IGNORE INTO ' . $missing . ' ' . substr($query, strlen($prefix));
        }
        return $query;
    };
    $errors_before = count($GLOBALS['EZSQL_ERROR'] ?? array());
    $suppressed = $wpdb->suppress_errors(true);
    add_filter('query', $fault, PHP_INT_MAX);
    try {
        $result = $operation();
        return array('result' => $result, 'last_error' => $wpdb->last_error, 'injected' => $injected,
            'sql_errors' => count($GLOBALS['EZSQL_ERROR'] ?? array()) - $errors_before);
    } finally {
        remove_filter('query', $fault, PHP_INT_MAX);
        $wpdb->suppress_errors($suppressed);
    }
}

function spotlight_test_assert_index_failure() {
    global $wpdb;
    spotlight_test_check(spotlight_test_job_count() === 0, 'Failed INSERT starts with a drained fixture queue');
    $vendor = spotlight_test_failed_insert(static function () {
        return relevanssi_index_doc(800001, true, '', true);
    });
    spotlight_test_check($vendor['injected'] > 0 && $vendor['sql_errors'] > 0,
        'Direct vendor indexing encounters an actual missing-table INSERT error');
    spotlight_test_check(is_int($vendor['result']) && $vendor['result'] >= 0 && $vendor['last_error'] === '',
        'Vendor token count and later SQL conceal the failed INSERT');
    spotlight_test_matches('riverbyline railroad', array(), 'Failed vendor INSERT leaves the known story absent from its index');
    $initial = spotlight_test_failed_insert(static function () {
        return spotlight_search_index_doc(800001, true);
    });
    spotlight_test_check($initial['injected'] > 0 && $initial['sql_errors'] > 0,
        'Initial builder wrapper encounters the actual injected INSERT error');
    spotlight_test_check($initial['result'] === -1 && $initial['last_error'] === '',
        'Initial builder wrapper reports failure after vendor SQL clears last_error');

    $job = array('ids' => array(800001));
    spotlight_search_save_job($job);
    $name = $wpdb->get_var($wpdb->prepare("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s",
        $wpdb->esc_like('spotlight_search_job_') . '%'));
    spotlight_test_check($name && get_option($name) === $job, 'Failed INSERT test saves the known story refresh job');
    $stored = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name=%s", $name));
    spotlight_test_api(wp_clear_scheduled_hook('spotlight_search_refresh_jobs', array(), true), 'Consume only search continuation');
    $refresh = spotlight_test_failed_insert(static function () {
        return spotlight_search_refresh_jobs(100, 2);
    });
    spotlight_test_check($refresh['injected'] > 0 && $refresh['sql_errors'] > 0,
        'Saved job refresh encounters the actual injected INSERT error');
    spotlight_test_check($refresh['result'] === 0, 'Failed INSERT refresh stops before acknowledging the story');
    spotlight_test_check(spotlight_test_job_count() === 1 && $wpdb->get_var($wpdb->prepare(
        "SELECT option_value FROM {$wpdb->options} WHERE option_name=%s", $name)) === $stored,
        'Failed INSERT refresh retains the unchanged persisted job');
    spotlight_test_check(wp_next_scheduled('spotlight_search_refresh_jobs') !== false,
        'Failed INSERT refresh arms its saved continuation');
    spotlight_test_check(spotlight_search_refresh_jobs(100, 2) === 1, 'Removing the INSERT fault permits the saved retry to drain');
    spotlight_test_check(get_option($name, false) === false && spotlight_test_job_count() === 0,
        'Successful INSERT retry removes the completed job');
    spotlight_test_matches('riverbyline railroad', array(800001), 'Successful INSERT retry restores the known merger story');
}

function spotlight_test_assert_fresh() {
    global $wpdb, $relevanssi_variables;
    wp_set_current_user(0);
    spotlight_test_matches('fixtureupdate oldword', array(), 'Old article text stays absent across requests');
    spotlight_test_matches('fixtureupdate newword', array(900400), 'New article text stays searchable across requests');
    spotlight_test_matches('fixtureunpublish', array(), 'Unpublished article stays absent across requests');
    spotlight_test_matches('fixturedelete', array(), 'Deleted article stays absent across requests');
    spotlight_test_matches('fixturepublish', array(900403), 'Published article stays searchable across requests');
    spotlight_test_matches('fixturepassword', array(), 'Protected article stays absent across requests');
    spotlight_test_matches('fixtureassign azure', array(), 'Author reassignment removes original public name');
    spotlight_test_matches('fixtureassign vermilion', array(), 'Author reassignment removes renamed original author too');
    spotlight_test_matches('fixtureassign amber', array(900405), 'Author reassignment adds the new public name');
    spotlight_test_matches('fixturebyline azure', array(), 'Registered author rename removes old public name');
    spotlight_test_matches('fixturebyline vermilion', array(900406), 'Registered author rename adds new public name');
    spotlight_test_matches('fixtureguest teal', array(), 'Guest author rename removes old public name');
    spotlight_test_matches('fixtureguest cobalt', array(900407), 'Guest author rename adds new public name');
    spotlight_test_check(spotlight_test_job_count() === 0, 'Dedicated CLI drained persisted author jobs');
    spotlight_test_matches('fixturelargeauthor saffron', array(), 'Large author refresh removes every old name');
    spotlight_test_check(spotlight_test_all_ids('fixturelargeauthor indigo') === range(900659, 900600),
        'Dedicated refresh makes all 60 renamed-author articles searchable');
    $table = $relevanssi_variables['relevanssi_table'];
    spotlight_test_check((int) $wpdb->get_var("SELECT COUNT(*) FROM $table WHERE doc IN (900401,900402,900404)") === 0,
        'Unpublish, delete and password changes also remove stored index rows');
}

if ($phase !== 'seed' && !get_option('spotlight_test_seeded')) {
    throw new RuntimeException('Run the seed phase first');
}
if ($phase !== 'seed' && !get_option('spotlight_search_ready')) {
    throw new RuntimeException('Build the fixture index and set spotlight_search_ready first');
}
switch ($phase) {
    case 'seed': spotlight_test_seed(); break;
    case 'assert': spotlight_test_assert(); break;
    case 'mutate': spotlight_test_mutate(); break;
    case 'assert-queued': spotlight_test_assert_queued(); break;
    case 'assert-retry': spotlight_test_assert_retry(); break;
    case 'assert-index-failure': spotlight_test_assert_index_failure(); break;
    case 'assert-fresh': spotlight_test_assert_fresh(); break;
    case 'jobs': echo spotlight_test_job_count(), PHP_EOL; return;
    default: throw new RuntimeException('Use seed, assert, mutate, assert-queued, assert-retry, assert-index-failure, assert-fresh or jobs');
}
echo 'Completed ', $phase, ': ', $GLOBALS['spotlight_test_checks'], ' checks.', PHP_EOL;
