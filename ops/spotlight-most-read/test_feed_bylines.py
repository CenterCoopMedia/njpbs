"""Exercise the real plugin through WordPress's external hook boundary."""
import json
from xml.etree import ElementTree
from pathlib import Path
import subprocess
import unittest


class FeedBylines(unittest.TestCase):
    def test_missing_invalid_or_wrong_site_configuration_registers_no_hooks(self):
        plugin = Path(__file__).with_name("spotlight-most-read.php")
        for blog, account, context in [
            ("", "posting-account", "production"),
            ("invalid", "posting-account", "production"),
            ("0", "posting-account", "production"),
            ("2", "posting-account", "production"),
            ("1", "", "production"),
            ("1", "posting-account", "development"),
        ]:
            with self.subTest(blog=blog, account=account, context=context):
                stub = r'''<?php
                define('ABSPATH', '/fixture/');
                putenv('NJSPOTLIGHT_BLOG_ID=' . $argv[2]);
                putenv('NJSPOTLIGHT_POSTING_ACCOUNT=' . $argv[3]);
                putenv('NJSPOTLIGHT_CONTEXT=' . $argv[4]);
                function get_current_blog_id() { return 1; }
                function add_action() { throw new Exception('Inactive plugin registered an action'); }
                function add_filter() { throw new Exception('Inactive plugin registered a filter'); }
                function add_shortcode() { throw new Exception('Inactive plugin registered a shortcode'); }
                require $argv[1];
                echo json_encode(SPOTLIGHT_MOST_READ_ACTIVE);
                '''
                result = subprocess.run(["php", "/dev/stdin", str(plugin), blog, account, context],
                                        input=stub, text=True, check=True, capture_output=True)
                self.assertFalse(json.loads(result.stdout))

    def test_native_names_and_feed_hooks(self):
        plugin = Path(__file__).with_name("spotlight-most-read.php")
        stub = r'''<?php
        define('ABSPATH', '/fixture/');
        putenv('NJSPOTLIGHT_CONTEXT=production');
        putenv('NJSPOTLIGHT_BLOG_ID=1');
        putenv('NJSPOTLIGHT_POSTING_ACCOUNT=posting-account');
        function get_current_blog_id() { return 1; }
        function add_action($name, $callback, $priority = 10) { $GLOBALS['hooks'][$name] = $callback; }
        function add_filter($name, $callback, $priority = 10) { $GLOBALS['filters'][$name][$priority][] = $callback; }
        function apply_filters($name, $value) {
            ksort($GLOBALS['filters'][$name]);
            foreach ($GLOBALS['filters'][$name] as $callbacks) {
                foreach ($callbacks as $callback) { $value = $callback($value); }
            }
            return $value;
        }
        function get_the_terms($id, $taxonomy) { return $GLOBALS['terms']; }
        function is_wp_error($value) { return $value instanceof Exception; }
        function add_shortcode($name, $callback) {}
        function get_coauthors($id) { return $GLOBALS['authors']; }
        function get_the_ID() { return 800001; }
        function is_feed() { return $GLOBALS['feed']; }
        function wp_strip_all_tags($value) { return strip_tags($value); }
        function esc_xml($value) { return htmlspecialchars($value, ENT_XML1 | ENT_QUOTES, 'UTF-8'); }
        require $argv[1];
        // A normal plugin registers after the MU-plugin, at CAP's real priorities.
        add_filter('the_author', function ($value) {
            return is_feed() ? 'CAP priority 10 value' : $value;
        }, 10);
        add_filter('the_author', function ($value) {
            return is_feed() ? 'CAP priority 15 value' : $value;
        }, 15);
        $rows = array();
        foreach (array(
            array('Avery J. Reporter'),
            array('Morgan Editor', 'Casey Writer'),
            array('Riley Contributor, Example News'),
            array("Taylor O'Example"),
            array('WHYY'),
            array('Staff'),
            array(),
        ) as $names) {
            $GLOBALS['authors'] = array_map(function ($name) {
                return (object) array('display_name' => $name, 'user_login' => $name);
            }, $names);
            $GLOBALS['terms'] = $names ? array((object) array('slug' => 'assigned-author')) : false;
            $GLOBALS['feed'] = true;
            ob_start(); $GLOBALS['hooks']['rss2_item'](); $item = ob_get_clean();
            $rows[] = array(spotlight_story_byline(800001), apply_filters('the_author', 'posting-account'), $item);
        }
        $GLOBALS['authors'] = array((object) array('display_name' => 'posting-account', 'user_login' => 'posting-account'));
        $GLOBALS['terms'] = array((object) array('slug' => 'posting-account'));
        $rows[] = array(spotlight_story_byline(800001));
        // CAP returns the full-name posting author when no author terms exist.
        $GLOBALS['authors'] = array((object) array('display_name' => 'Morgan Editor', 'user_login' => 'posting-account'));
        foreach (array(false, new Exception('taxonomy unavailable')) as $terms) {
            $GLOBALS['terms'] = $terms;
            ob_start(); $GLOBALS['hooks']['rss2_item'](); $item = ob_get_clean();
            $rows[] = array(spotlight_story_byline(800001), apply_filters('the_author', 'Morgan Editor'), $item);
        }
        $GLOBALS['feed'] = false;
        $rows[] = array(apply_filters('the_author', 'Unchanged article author'));
        ob_start(); $GLOBALS['hooks']['rss2_ns'](); $rows[] = array(ob_get_clean());
        echo json_encode($rows);
        '''
        result = subprocess.run(["php", "/dev/stdin", str(plugin)], input=stub, text=True,
                                check=True, capture_output=True)
        rows = json.loads(result.stdout)
        self.assertEqual([row[0] for row in rows[:8]], [
            "Avery J. Reporter", "Morgan Editor, et al.", "Riley Contributor, Example News", "Taylor O'Example", "WHYY", "Staff", "", "",
        ])
        self.assertEqual([row[1] for row in rows[:7]], [row[0] for row in rows[:7]])
        self.assertEqual(rows[0][2], "<njspotlight:byline>Avery J. Reporter</njspotlight:byline>\n")
        self.assertEqual(rows[3][2], "<njspotlight:byline>Taylor O&apos;Example</njspotlight:byline>\n")
        self.assertEqual(rows[6][2], "")
        self.assertEqual(rows[8:10], [["", "", ""], ["", "", ""]])
        self.assertEqual(rows[10], ["Unchanged article author"])
        # On the live site another rss2_ns callback (media RSS) prints
        # 'xmlns:media=...' with no leading space; the feed head must still parse.
        head = ('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"\n'
                '\txmlns:dc="http://purl.org/dc/elements/1.1/"\n'
                + rows[11][0] + 'xmlns:media="http://search.yahoo.com/mrss/">'
                '<channel><item><njspotlight:byline>A</njspotlight:byline></item></channel></rss>')
        root = ElementTree.fromstring(head)
        self.assertEqual(root.find("channel/item/{https://www.njspotlightnews.org/ns/1.0/}byline").text, "A")


if __name__ == "__main__":
    unittest.main()
