<?php
/** Synthetic WordPress boundary; rendered HTML is parsed by the real PHP DOM extension. */
define('ABSPATH', __DIR__);
$actions = array();
$filters = array();
$page = (object) array('ID' => 42, 'post_type' => 'page', 'post_status' => 'publish', 'post_password' => '');
$request = array('admin' => false, 'ajax' => false, 'logged_in' => false, 'preview' => false,
    'feed' => false, 'embed' => false, '404' => false, 'search' => false, 'singular' => false);
function add_action($hook, $callback, $priority = 10) { $GLOBALS['actions'][$hook][] = $callback; }
function add_filter($hook, $callback, $priority = 10) { $GLOBALS['filters'][$hook][] = $callback; }
function wp_parse_url($value, $component = -1) { return parse_url($value, $component); }
function home_url($path = '') { return 'https://news.example.org' . $path; }
function get_current_blog_id() { return 7; }
function get_post($id) { return $GLOBALS['page']; }
function get_permalink($id) { return 'https://news.example.org/privacy/'; }
function is_post_publicly_viewable($post) { return $post->post_status === 'publish'; }
function is_admin() { return $GLOBALS['request']['admin']; }
function wp_doing_ajax() { return $GLOBALS['request']['ajax']; }
function is_user_logged_in() { return $GLOBALS['request']['logged_in']; }
function is_preview() { return $GLOBALS['request']['preview']; }
function is_feed() { return $GLOBALS['request']['feed']; }
function is_embed() { return $GLOBALS['request']['embed']; }
function is_404() { return $GLOBALS['request']['404']; }
function is_search() { return $GLOBALS['request']['search']; }
function is_singular() { return $GLOBALS['request']['singular']; }
function get_queried_object() { return $GLOBALS['page']; }
function get_post_meta($id, $key, $single = false) { return ''; }
function get_option($key) { return '1'; }
function is_page($id) { return $id === 42; }
function in_the_loop() { return true; }
function is_main_query() { return true; }
function plugins_url($path, $file) { return 'https://news.example.org/wp-content/mu-plugins/' . $path; }
function esc_url($value) { return htmlspecialchars($value, ENT_QUOTES); }
function esc_attr($value) { return htmlspecialchars($value, ENT_QUOTES); }
require dirname(__DIR__) . '/spotlight-newsletter-tracking.php';

function check($condition, $message) {
    if (!$condition) { throw new RuntimeException($message); }
}
function environment() {
    foreach (array('NJSPOTLIGHT_CONTEXT' => 'production', 'NJSPOTLIGHT_BLOG_ID' => '7',
        'NJSPOTLIGHT_PRIVACY_PAGE_ID' => '42', 'NJSPOTLIGHT_TRACKING_ORIGIN' => 'https://news.example.org',
        'NJSPOTLIGHT_ACTIVE_CAMPAIGN_ACCOUNT' => '123456', 'NJSPOTLIGHT_WISEPOPS_PROPERTY' => 'Example123',
        'NJSPOTLIGHT_GA4_MEASUREMENT_ID' => 'G-TEST123456') as $key => $value) {
        putenv($key . '=' . $value);
    }
    $_SERVER['REQUEST_METHOD'] = 'GET';
    $_SERVER['REQUEST_URI'] = '/article/';
}
function document($content = '', $head = '') {
    return '<!doctype html><html lang="en"><head><title>Example news</title>' . $head . '</head><body>'
        . '<main><h1>Example news</h1><p><a id="article-link" href="/another-article/">Another article</a></p><p>Public article text.</p>' . $content . '</main>'
        . NJSpotlightNewsletter\MARKER . '</body></html>';
}

environment();
if (($argv[1] ?? '') === 'render') {
    $case = $argv[2] ?? 'article';
    if ($case === 'media-blocked') $_GET['spotlight_newsletter_media'] = 'off';
    $content = $case === 'video' ? '<div class="video-wrap"><iframe src="https://player.pbs.org/viralplayer/123456/"></iframe></div>' : '';
    $html = document($content, $case === 'noindex' ? '<meta name="robots" content="noindex">' : '');
    $replacement = $case !== 'baseline' && NJSpotlightNewsletter\public_request() && NJSpotlightNewsletter\eligible_document($html)
        ? NJSpotlightNewsletter\footer_markup(NJSpotlightNewsletter\configuration()) : '';
    echo str_replace(NJSpotlightNewsletter\MARKER, $replacement, $html);
    exit;
}

check(class_exists('DOMDocument'), 'The HTML eligibility checks need PHP DOM');
$config = NJSpotlightNewsletter\configuration();
check($config && $config['account'] === '123456' && $config['property'] === 'Example123'
    && $config['measurement'] === 'G-TEST123456', 'Explicit settings activate only the selected installation');
foreach (array('NJSPOTLIGHT_CONTEXT', 'NJSPOTLIGHT_BLOG_ID', 'NJSPOTLIGHT_PRIVACY_PAGE_ID',
    'NJSPOTLIGHT_TRACKING_ORIGIN', 'NJSPOTLIGHT_ACTIVE_CAMPAIGN_ACCOUNT', 'NJSPOTLIGHT_WISEPOPS_PROPERTY',
    'NJSPOTLIGHT_GA4_MEASUREMENT_ID') as $key) {
    putenv($key);
    check(NJSpotlightNewsletter\configuration() === null, 'Missing configuration must stay inactive: ' . $key);
    environment();
}
foreach (array('NJSPOTLIGHT_BLOG_ID' => '8', 'NJSPOTLIGHT_CONTEXT' => 'staging',
    'NJSPOTLIGHT_TRACKING_ORIGIN' => 'https://other.example.org', 'NJSPOTLIGHT_ACTIVE_CAMPAIGN_ACCOUNT' => 'not-an-account',
    'NJSPOTLIGHT_WISEPOPS_PROPERTY' => 'invalid/property', 'NJSPOTLIGHT_GA4_MEASUREMENT_ID' => 'GTM-W7PS3VH') as $key => $value) {
    putenv($key . '=' . $value);
    check(NJSpotlightNewsletter\configuration() === null, 'Invalid settings must stay inactive: ' . $key);
    environment();
}
check(NJSpotlightNewsletter\public_request(), 'Ordinary public request is eligible');
foreach (array('admin', 'ajax', 'logged_in', 'preview', 'feed', 'embed', '404', 'search') as $key) {
    $request[$key] = true;
    check(!NJSpotlightNewsletter\public_request(), 'Excluded request: ' . $key);
    $request[$key] = false;
}
foreach (array('/kids/', '/fr/%6Bids/game/', '/%invalid') as $path) {
    $_SERVER['REQUEST_URI'] = $path;
    check(!NJSpotlightNewsletter\public_request(), 'Excluded child or malformed route');
}
environment();
$_GET['spotlight_newsletter_media'] = 'off';
check(!NJSpotlightNewsletter\public_request(), 'A marked dynamic-media address cannot initialize vendors');
unset($_GET['spotlight_newsletter_media']);
$request['singular'] = true;
foreach (array('post_status' => 'private', 'post_password' => 'example', 'post_type' => 'njt_video') as $key => $value) {
    $before = $page->$key;
    $page->$key = $value;
    check(!NJSpotlightNewsletter\public_request(), 'Excluded singular content: ' . $key);
    $page->$key = $before;
}
$request['singular'] = false;
check(NJSpotlightNewsletter\eligible_document(document()), 'Public text document stays eligible');
check(NJSpotlightNewsletter\eligible_document(document('<script type="text/x-handlebars-template"><iframe src="{{url}}"></iframe></script>')), 'Unrendered templates do not constitute a player');
foreach (array('<video src="example.mp4"></video>', '<iframe src="https://player.pbs.org/viralplayer/123456/"></iframe>',
    '<iframe src="https://www.youtube.com/embed/Abc12345678"></iframe>', '<object data="example.mp4"></object>',
    '<embed src="example.mp4">', '<div data-child-directed></div>', '<div data-video-id="example"></div>',
    '<a data-remodal-target="modalinteractive" href="https://example.org/interactive">Open</a>',
    '<script src="https://platform.twitter.com/widgets.js"></script>') as $content) {
    check(!NJSpotlightNewsletter\eligible_document(document($content)), 'Rendered or deferred media must stay excluded');
}
foreach (array('<meta name="robots" content="noindex,follow">', '<meta name="googlebot" content="none">',
    '<meta http-equiv="REFRESH" content="0;url=/elsewhere/">') as $head) {
    check(!NJSpotlightNewsletter\eligible_document(document('', $head)), 'Robots and redirects stay excluded');
}
check(!NJSpotlightNewsletter\eligible_document('<p>Incomplete output</p>'), 'Partial output cannot enable tools');

ob_start();
$actions['template_redirect'][0]();
$parts = explode(NJSpotlightNewsletter\MARKER, document());
echo $parts[0];
$actions['wp_footer'][0]();
echo $parts[1];
ob_end_flush();
$rendered = ob_get_clean();
check(substr_count($rendered, 'id="spotlight-newsletter-choice"') === 1, 'One footer control is inserted');
check(strpos($rendered, 'consent.js') < strpos($rendered, '</body>'), 'Initialization stays inside the body footer');
check(strpos($rendered, 'diffuser-cdn') === false && strpos($rendered, 'wisepops.net/h/') === false
    && strpos($rendered, 'googletagmanager') === false && strpos($rendered, 'gtag(') === false, 'The server never emits a vendor script request');
check(strpos($filters['the_content'][0]('Existing policy'), 'Existing policy<section id="analytics-privacy">') === 0, 'The privacy addition preserves the existing notice');
echo "Spotlight newsletter WordPress contracts passed\n";
