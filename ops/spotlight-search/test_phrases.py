"""Exercise phrase SQL and refusal bounds without a WordPress service."""
from pathlib import Path
import json
import subprocess
import unittest


BOOTSTRAP = r'''<?php
define('ABSPATH', '/fixture/');
putenv('NJSPOTLIGHT_BLOG_ID=1');
putenv('NJSPOTLIGHT_SEARCH_PAGE_ID=42');
function add_action() {}
function add_filter() {}
function get_current_blog_id() { return 1; }
function get_option($name) { return $name === 'spotlight_search_ready'; }
function taxonomy_exists() { return true; }
class WP_Error {
    public function __construct(public $code) {}
}
function is_wp_error($value) { return $value instanceof WP_Error; }
function relevanssi_tokenize($text) {
    return array_fill_keys(preg_split('/\s+/u', trim($text), -1, PREG_SPLIT_NO_EMPTY), 1);
}
class FixtureDatabase {
    public $prefix = 'wp_', $posts = 'wp_posts', $term_relationships = 'wp_term_relationships';
    public $last_error = '', $queries = array();
    public function esc_like($value) { return addcslashes($value, '_%\\'); }
    public function prepare($sql, ...$args) {
        if (count($args) === 1 && is_array($args[0])) $args = $args[0];
        foreach ($args as $arg) {
            $sql = preg_replace_callback('/%[sd]/', static fn() => "'" . str_replace("'", "''", (string) $arg) . "'", $sql, 1);
        }
        return $sql;
    }
    public function get_col($sql) { $this->queries[] = $sql; return array(99); }
}
class FixtureAuthors {
    public $calls = 0;
    public function get_coauthor_by($field, $name) {
        ++$this->calls;
        if ($GLOBALS['author_sql_error']) $GLOBALS['wpdb']->last_error = 'fixture failure';
        return (object) array('display_name' => $GLOBALS['names'][$name]);
    }
}
function get_terms($args) {
    $GLOBALS['lookups'][] = $args;
    if ($GLOBALS['lookup_error']) return new WP_Error('fixture_error');
    if ($GLOBALS['lookup_sql_error']) {
        $GLOBALS['wpdb']->last_error = 'fixture failure';
        return array();
    }
    $terms = array();
    foreach ($GLOBALS['names'] as $name => $display) {
        $terms[] = (object) array('name' => $name, 'term_taxonomy_id' => count($terms) + 7);
    }
    return array_slice($terms, 0, $args['number'] ?? count($terms));
}
$wpdb = new FixtureDatabase();
$coauthors_plus = new FixtureAuthors();
$relevanssi_variables = array('plugin_version' => '4.28.4');
$names = array('fixture-author' => 'José Álvarez');
$lookups = array();
$lookup_error = false;
$lookup_sql_error = false;
$author_sql_error = false;
require $argv[1] . '/spotlight-indexed-search.php';
'''


class SearchPhrases(unittest.TestCase):
    def run_search(self, query, setup=''):
        program = BOOTSTRAP + setup + '\n$result = spotlight_indexed_search(' + json.dumps(query, ensure_ascii=False) + r''', false, 1);
        echo json_encode(array('result' => is_wp_error($result) ? $result->code : $result,
            'queries' => $wpdb->queries, 'lookups' => $lookups, 'authors' => $coauthors_plus->calls), JSON_THROW_ON_ERROR);
        '''
        result = subprocess.run(['php', '/dev/stdin', str(Path(__file__).parent)],
                                input=program, text=True, check=True, capture_output=True)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def test_unicode_positive_and_excluded_byline_phrases(self):
        for phrase in ['josé álvarez', 'JOSÉ ÁLVAREZ']:
            for prefix in ['', '-']:
                with self.subTest(phrase=phrase, prefix=prefix):
                    result = self.run_search('topic ' + prefix + '"' + phrase + '"')
                    self.assertEqual(result['result'], [99])
                    self.assertEqual(result['authors'], 1)
                    sql = result['queries'][0]
                    self.assertIn('tr.term_taxonomy_id IN (7)', sql)
                    self.assertIn(prefix and 'NOT (p.post_title LIKE' or '(p.post_title LIKE', sql)
                    self.assertIn('ORDER BY p.post_date DESC, p.ID DESC LIMIT 11', sql)

    def test_author_phrase_is_literal_not_a_regular_expression(self):
        setup = "$names = array('wrong' => 'Ax Reporter News/Team', 'right' => 'A. Reporter (News)/Team');"
        result = self.run_search('topic "a. reporter (news)/team"', setup)
        self.assertIn('tr.term_taxonomy_id IN (8)', result['queries'][0])
        self.assertNotIn('IN (7,8)', result['queries'][0])

    def test_author_overflow_refuses_positive_and_excluded_searches(self):
        for prefix in ['', '-']:
            with self.subTest(prefix=prefix):
                result = self.run_search('topic ' + prefix + '"reporter"',
                                         "$names = array_fill(0, 102, 'Reporter');")
                self.assertEqual(result['result'], 'search_unavailable')
                self.assertEqual(result['queries'], [])
                self.assertEqual(result['authors'], 0)
                self.assertEqual(result['lookups'], [{'taxonomy': 'author', 'hide_empty': True,
                                 'description__like': 'reporter', 'number': 101, 'update_term_meta_cache': False}])

    def test_exact_author_and_combined_phrase_limits_are_accepted(self):
        query = 'topic ' + ' '.join(['"reporter"'] * 4 + ['-"other"'] * 4)
        result = self.run_search(query, "$names = array_fill(0, 100, 'Reporter');")
        self.assertEqual(result['result'], [99])
        self.assertEqual(len(result['lookups']), 8)
        self.assertEqual(result['authors'], 800)
        self.assertEqual(len(result['queries']), 1)

    def test_combined_phrase_overflow_refuses_before_lookup(self):
        for positive in [0, 4, 9]:
            with self.subTest(positive=positive):
                query = 'topic ' + ' '.join(['"reporter"'] * positive + ['-"other"'] * (9 - positive))
                result = self.run_search(query)
                self.assertEqual(result['result'], 'too_many_phrases')
                self.assertEqual(result['lookups'], [])
                self.assertEqual(result['queries'], [])

    def test_lookup_failure_and_invalid_unicode_refuse_even_for_exclusions(self):
        for setup in ["$lookup_error = true;", "$lookup_sql_error = true;", "$author_sql_error = true;",
                      "$names = array('broken' => \"bad\\xffname\");"]:
            for prefix in ['', '-']:
                with self.subTest(setup=setup, prefix=prefix):
                    result = self.run_search('topic ' + prefix + '"reporter"', setup)
                    self.assertEqual(result['result'], 'search_unavailable')
                    self.assertEqual(result['queries'], [])

    def test_no_author_match_retains_text_predicate_and_exclusion_only_does_no_work(self):
        result = self.run_search('topic -"missing"')
        self.assertIn('NOT (p.post_title LIKE', result['queries'][0])
        self.assertNotIn('tr.term_taxonomy_id', result['queries'][0])
        result = self.run_search('-"josé álvarez"')
        self.assertEqual(result['result'], [])
        self.assertEqual(result['lookups'], [])
        self.assertEqual(result['queries'], [])


if __name__ == '__main__':
    unittest.main()
