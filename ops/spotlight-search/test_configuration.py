"""Check that missing deployment settings cannot activate public search hooks."""
from pathlib import Path
import subprocess
import unittest


class SearchConfiguration(unittest.TestCase):
    def test_shortcode_fallback_and_both_plugin_load_orders(self):
        directory = Path(__file__).parent
        for order in ["local-only", "local-first", "index-first", "phrase-limit"]:
            with self.subTest(order=order):
                stub = r'''<?php
                define('ABSPATH', '/fixture/');
                putenv('NJSPOTLIGHT_BLOG_ID=1');
                putenv('NJSPOTLIGHT_SEARCH_PAGE_ID=42');
                function get_current_blog_id() { return 1; }
                function is_page($id) { return $id === 42; }
                function add_action($name, $callback) { $GLOBALS['hooks'][$name] = $callback; }
                function add_filter() {}
                function shortcode_exists() { return false; }
                function add_shortcode($name, $callback) { $GLOBALS['shortcodes'][$name] = $callback; }
                function sanitize_text_field($text) { return $text; }
                function wp_unslash($text) { return $text; }
                function esc_url($text) { return $text; }
                function esc_attr($text) { return htmlspecialchars($text); }
                function home_url($path) { return 'https://example.org' . $path; }
                function spotlight_svg() { return ''; }
                class WP_Error {
                    public function __construct(public $code = '') {}
                    public function get_error_code() { return $this->code; }
                }
                function is_wp_error($value) { return $value instanceof WP_Error; }
                $index = $argv[1] . '/spotlight-indexed-search.php';
                if ($argv[2] === 'index-first') require $index;
                require $argv[1] . '/spotlight-local-search.php';
                if ($argv[2] === 'local-first') require $index;
                if ($argv[2] === 'phrase-limit') {
                    function spotlight_indexed_search() { return new WP_Error('too_many_phrases'); }
                }
                $GLOBALS['hooks']['init']();
                if (!isset($GLOBALS['hooks']['template_redirect'])) throw new Exception('Missing redirect');
                $_GET = array('q' => 'fixture query');
                echo call_user_func($GLOBALS['shortcodes']['wnet-google-cse']);
                '''
                result = subprocess.run(["php", "/dev/stdin", str(directory), order],
                                        input=stub, text=True, check=True, capture_output=True)
                if order == 'phrase-limit':
                    self.assertIn('Use at most eight quoted phrases.', result.stdout)
                    self.assertNotIn('temporarily unavailable', result.stdout)
                else:
                    self.assertIn('Search is temporarily unavailable.', result.stdout)
                self.assertIn('name="q"', result.stdout)
                self.assertEqual(result.stderr, '')

    def test_missing_or_invalid_ids_leave_hooks_inactive(self):
        directory = Path(__file__).parent
        for blog, page in [("", ""), ("1", ""), ("", "42"), ("0", "42"),
                           ("invalid", "42"), ("1", "invalid"), ("1", "-1")]:
            with self.subTest(blog=blog, page=page):
                stub = r'''<?php
                define('ABSPATH', '/fixture/');
                putenv('NJSPOTLIGHT_BLOG_ID=' . $argv[2]);
                putenv('NJSPOTLIGHT_SEARCH_PAGE_ID=' . $argv[3]);
                function add_action() { throw new Exception('Inactive search registered an action'); }
                function add_filter() { throw new Exception('Inactive search registered a filter'); }
                require $argv[1] . '/spotlight-indexed-search.php';
                require $argv[1] . '/spotlight-local-search.php';
                echo 'inactive';
                '''
                result = subprocess.run(["php", "/dev/stdin", str(directory), blog, page],
                                        input=stub, text=True, check=True, capture_output=True)
                self.assertEqual(result.stdout, "inactive")


if __name__ == '__main__':
    unittest.main()
