<?php
/**
 * Plugin Name: Spotlight privacy choices
 * Description: Consent-gated analytics and newsletter tools on public pages without embedded media.
 */
namespace NJSpotlightNewsletter;

if (!defined('ABSPATH')) {
    exit;
}

const MARKER = '<!-- spotlight-newsletter-footer -->';

function configuration() {
    $blog = filter_var(getenv('NJSPOTLIGHT_BLOG_ID'), FILTER_VALIDATE_INT, array('options' => array('min_range' => 1)));
    $privacy = filter_var(getenv('NJSPOTLIGHT_PRIVACY_PAGE_ID'), FILTER_VALIDATE_INT, array('options' => array('min_range' => 1)));
    $origin = (string) getenv('NJSPOTLIGHT_TRACKING_ORIGIN');
    $account = (string) getenv('NJSPOTLIGHT_ACTIVE_CAMPAIGN_ACCOUNT');
    $property = (string) getenv('NJSPOTLIGHT_WISEPOPS_PROPERTY');
    $measurement = (string) getenv('NJSPOTLIGHT_GA4_MEASUREMENT_ID');
    $parts = wp_parse_url($origin);
    if (getenv('NJSPOTLIGHT_CONTEXT') !== 'production' || !$blog || !$privacy
        || get_current_blog_id() !== $blog || rtrim(home_url('/'), '/') !== $origin
        || !is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])
        || count(array_diff(array_keys($parts), array('scheme', 'host'))) !== 0
        || preg_match('/\A[1-9][0-9]{0,19}\z/', $account) !== 1
        || preg_match('/\A[A-Za-z0-9]{6,32}\z/', $property) !== 1
        || preg_match('/\AG-[A-Z0-9]{6,16}\z/', $measurement) !== 1) {
        return null;
    }
    $page = get_post($privacy);
    if (!$page || $page->post_type !== 'page' || $page->post_status !== 'publish'
        || $page->post_password !== '' || !is_post_publicly_viewable($page)) {
        return null;
    }
    $policy_url = get_permalink($privacy);
    if (strpos($policy_url, $origin . '/') !== 0) {
        return null;
    }
    return array('account' => $account, 'property' => $property, 'measurement' => $measurement,
        'privacy' => $privacy, 'policyUrl' => $policy_url . '#analytics-privacy');
}

function public_request() {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET' || is_admin() || wp_doing_ajax()
        || is_user_logged_in() || is_preview() || is_feed() || is_embed() || is_404()
        || is_search() || (defined('REST_REQUEST') && REST_REQUEST)
        || !empty($_SERVER['HTTP_AUTHORIZATION']) || !empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])
        || isset($_GET['spotlight_newsletter_media']) || get_option('blog_public') !== '1') {
        return false;
    }
    $path = wp_parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    if (!is_string($path) || preg_match('/%(?![0-9a-f]{2})/i', $path)
        || preg_match('~(?:^|/)(?:kids|preview|wp-admin)(?:/|$)~i', rawurldecode($path))) {
        return false;
    }
    if (is_singular()) {
        $post = get_queried_object();
        if (!$post || $post->post_status !== 'publish' || $post->post_password !== ''
            || !is_post_publicly_viewable($post) || $post->post_type === 'njt_video'
            || get_post_meta($post->ID, 'child_directed', true)) {
            return false;
        }
    }
    return true;
}

/** Examine rendered players, including related features and legacy custom HTML. */
function eligible_document($html) {
    if (!class_exists('\DOMDocument') || strlen($html) > 2 * 1024 * 1024
        || stripos($html, '</body>') === false) {
        return false;
    }
    $document = new \DOMDocument();
    $previous = libxml_use_internal_errors(true);
    try {
        if (!$document->loadHTML($html, LIBXML_NONET)) {
            return false;
        }
    } finally {
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
    }
    $xpath = new \DOMXPath($document);
    // Unknown frames and interactive modals can contain video. Keep them excluded.
    $blocked = $xpath->query('//video | //iframe | //object | //embed | //*[@data-child-directed]
        | //*[@data-remodal-target="modalinteractive"] | //*[@data-video-id]
        | //meta[translate(@http-equiv,"REFSH","refsh")="refresh"]');
    if ($blocked === false || $blocked->length || $xpath->query('//body')->length !== 1) {
        return false;
    }
    foreach ($document->getElementsByTagName('meta') as $meta) {
        if (in_array(strtolower($meta->getAttribute('name')), array('robots', 'googlebot'), true)
            && preg_match('/\b(?:noindex|none)\b/i', $meta->getAttribute('content'))) {
            return false;
        }
    }
    foreach ($document->getElementsByTagName('script') as $script) {
        $src = $script->getAttribute('src');
        $host = strtolower((string) wp_parse_url($src, PHP_URL_HOST));
        $own_host = strtolower((string) wp_parse_url(home_url('/'), PHP_URL_HOST));
        // These shared libraries do not embed content. Other external scripts can add players.
        $library = preg_match('~\A(?://|https://)cdnjs\.cloudflare\.com/ajax/libs/(?:remodal/1\.1\.1/remodal\.min\.js|splidejs/4\.1\.4/js/splide\.min\.js|handlebars\.js/4\.7\.7/handlebars\.min\.js|js-cookie/2\.0\.4/js\.cookie\.min\.js|jquery-expander/1\.7\.0/jquery\.expander\.min\.js)(?:\?[^#]*)?\z~', $src);
        if ($host !== '' && $host !== $own_host && !$library) {
            return false;
        }
    }
    foreach (headers_list() as $header) {
        if (preg_match('/^X-Robots-Tag:.*\b(?:noindex|none)\b/i', $header)) {
            return false;
        }
    }
    return http_response_code() === false || http_response_code() === 200;
}

function privacy_text() {
    // Joe approved this analytics wording on Nov. 26, 2026.
    return '<section id="analytics-privacy"><h2>Analytics and your choice</h2>'
        . '<p>With your permission, NJ Spotlight News uses Google Analytics to count visits and see which stories '
        . 'readers use; its advertising features stay off. It loads only after you allow analytics, and a denial '
        . 'or a Global Privacy Control signal keeps it off. You can change your choice at any time with the '
        . 'Privacy settings button at the bottom of the page.</p></section>'
        . '<section id="newsletter-privacy"><h2>Newsletter tools and your choice</h2>'
        . '<p>NJ Spotlight uses Wisepops for newsletter signup messages and ActiveCampaign for newsletter marketing. '
        . 'These tools load only after you allow newsletter tools. Wisepops may use cookies to remember your interactions. '
        . 'ActiveCampaign records page visits and IP addresses and may associate visits with an existing contact record. '
        . 'This integration does not send an email address or call ActiveCampaign identification features. '
        . 'Information you enter in a newsletter form is sent to its provider.</p>'
        . '<p>The site saves your choice in the first-party spotlight-newsletter-consent cookie for 180 days. '
        . 'A denial or Global Privacy Control signal keeps these tools off. They stay off pages containing video '
        . 'and other excluded pages. Privacy settings lets you change your choice. '
        . 'Changing to Do not allow reloads the page to stop running vendor code. '
        . 'This cannot recall information already sent.</p>'
        . '<p>If a page starts to display video while newsletter tools are running, it reloads once to stop the tools. '
        . 'A session-only page record keeps them off. If the browser cannot save that record, '
        . 'a marker in the page address keeps them off after the reload.</p>'
        . '<p><a href="https://www.activecampaign.com/legal/privacy-policy">ActiveCampaign privacy policy</a>. '
        . '<a href="https://wisepops.com/privacy-policy">Wisepops privacy policy</a>. '
        . 'Use the privacy contact on this page for questions or deletion requests.</p></section>';
}

function footer_markup($config) {
    $assets = plugins_url('spotlight-newsletter-tracking/', __FILE__);
    $choice = static function ($category, $title, $text, $data) {
        return '<section data-category="' . $category . '" data-newsletter-choice ' . $data . '>'
            . '<h3>' . $title . '</h3><p>' . $text . '</p><p data-current></p><p role="status" data-status></p>'
            . '<div class="spotlight-newsletter-actions">'
            . '<button type="button" data-deny>Do not allow ' . strtolower($title) . '</button>'
            . '<button type="button" data-allow>Allow ' . strtolower($title) . '</button></div></section>';
    };
    return '<link rel="stylesheet" href="' . esc_url($assets . 'consent.css') . '">'
        . '<p class="spotlight-newsletter-information"><a href="' . esc_url($config['policyUrl']) . '">Privacy information</a></p>'
        . '<button type="button" class="spotlight-newsletter-settings" data-newsletter-open hidden>Privacy settings</button>'
        . '<div class="spotlight-privacy-bar" data-privacy-bar role="region" aria-label="Privacy choices" hidden>'
        . '<p>We use analytics and newsletter tools only if you allow them.</p><div class="spotlight-privacy-bar-actions">'
        . '<button type="button" data-allow-all>Allow all</button><button type="button" data-allow-none>Allow none</button>'
        . '<button type="button" data-choices>Choices</button></div></div>'
        . '<aside id="spotlight-newsletter-choice" class="spotlight-newsletter-choice" aria-labelledby="spotlight-newsletter-title" hidden>'
        . '<h2 id="spotlight-newsletter-title">Your privacy choices</h2>'
        . '<p data-newsletter-gpc hidden>Your browser sent a Global Privacy Control signal. Analytics and newsletter tools stay off.</p>'
        . '<p data-newsletter-media hidden>Analytics and newsletter tools stay off on this page because it can display video.</p>'
        . '<p><a href="' . esc_url($config['policyUrl']) . '">Read the privacy policy</a></p>'
        . $choice('analytics', 'Analytics', 'With your permission, Google Analytics counts visits and shows which stories '
            . 'readers use. It sets cookies to recognize return visits. Its advertising features stay off.',
            'data-measurement-id="' . esc_attr($config['measurement']) . '"')
        . $choice('newsletter', 'Newsletter tools', 'With your permission, Wisepops can show newsletter forms and use cookies '
            . 'to remember your interactions. ActiveCampaign can record page visits and your IP address for newsletter '
            . 'marketing and link visits to an existing contact record.',
            'data-account="' . esc_attr($config['account']) . '" data-property="' . esc_attr($config['property']) . '"')
        . '<p>You can change your choices at any time in Privacy settings.</p>'
        . '<button type="button" data-newsletter-close>Close</button></aside>'
        . '<script type="module" src="' . esc_url($assets . 'consent.js') . '"></script>';
}

add_action('template_redirect', static function () {
    $config = configuration();
    if (!$config || !public_request()) {
        return;
    }
    add_filter('the_content', static function ($content) use ($config) {
        return is_page($config['privacy']) && in_the_loop() && is_main_query()
            ? $content . privacy_text() : $content;
    }, 100);
    add_action('wp_footer', static function () { echo MARKER; }, PHP_INT_MAX);
    // Run outside the existing GTM-removal buffer so eligibility sees its final HTML.
    $fragmented = false;
    ob_start(static function ($html, $phase) use ($config, &$fragmented) {
        if (!($phase & PHP_OUTPUT_HANDLER_FINAL)) {
            $fragmented = true;
        }
        $replacement = '';
        if (!$fragmented && substr_count($html, MARKER) === 1 && eligible_document($html)) {
            $replacement = footer_markup($config);
        }
        return str_replace(MARKER, $replacement, $html);
    });
}, -10);
