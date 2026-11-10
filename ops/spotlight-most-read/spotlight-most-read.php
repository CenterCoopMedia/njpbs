<?php
/**
 * Plugin Name: Spotlight most read
 * Description: Show estimated article rankings from a local request snapshot.
 */

if (!defined('ABSPATH')) {
    return;
}

// Deployment settings are read once during plugin bootstrap; no remote lookup.
define('SPOTLIGHT_MOST_READ_BLOG_ID', filter_var(getenv('NJSPOTLIGHT_BLOG_ID'),
    FILTER_VALIDATE_INT, array('options' => array('min_range' => 1))) ?: 0);
define('SPOTLIGHT_MOST_READ_POSTING_ACCOUNT', trim(getenv('NJSPOTLIGHT_POSTING_ACCOUNT') ?: ''));
define('SPOTLIGHT_MOST_READ_ACTIVE', SPOTLIGHT_MOST_READ_BLOG_ID > 0
    && get_current_blog_id() === SPOTLIGHT_MOST_READ_BLOG_ID
    && SPOTLIGHT_MOST_READ_POSTING_ACCOUNT !== '' && getenv('NJSPOTLIGHT_CONTEXT') === 'production');

if (SPOTLIGHT_MOST_READ_ACTIVE) {

// Shared by Most read and RSS: the first native co-author owns the byline.
function spotlight_story_byline($id) {
    if (!function_exists('get_coauthors')) {
        return '';
    }
    // get_coauthors() falls back to the posting account when no terms exist.
    $terms = get_the_terms($id, 'author');
    if (is_wp_error($terms) || !$terms) {
        return '';
    }
    $authors = get_coauthors($id);
    $author = $authors ? trim(wp_strip_all_tags($authors[0]->display_name)) : '';
    if ($author === '' || strcasecmp($author, SPOTLIGHT_MOST_READ_POSTING_ACCOUNT) === 0
        || preg_match('/^NJ Spotlight(?: News)?$/i', $author)) {
        return '';
    }
    return count($authors) > 1 ? $author . ', et al.' : $author;
}

add_filter('the_author', function ($author) {
    return is_feed() ? spotlight_story_byline(get_the_ID()) : $author;
}, 20);

add_action('rss2_ns', function () {
    // Whitespace on both sides: the live site's media RSS plugin prints its
    // namespace next with no leading space.
    echo "\n\t" . 'xmlns:njspotlight="https://www.njspotlightnews.org/ns/1.0/"' . "\n";
});

add_action('rss2_item', function () {
    $author = spotlight_story_byline(get_the_ID());
    if ($author !== '') {
        echo '<njspotlight:byline>' . esc_xml($author) . '</njspotlight:byline>' . "\n";
    }
});

function spotlight_most_read_is_public($post) {
    return $post && $post->post_type === 'post' && $post->post_status === 'publish'
        && $post->post_password === '' && is_post_publicly_viewable($post);
}

function spotlight_home_story_meta($id, $author = '') {
    $date = get_the_date('F j, Y', $id);
    if (!$date) {
        return '';
    }
    $content = '<div class="spotlight-home-story-meta"><time datetime="'
        . esc_attr(get_the_date(DATE_W3C, $id)) . '">' . esc_html($date) . '</time>';
    if ($author) {
        $content .= '<span class="spotlight-home-story-meta__byline">By ' . wp_kses_post($author) . '</span>';
    }
    return $content . '</div>';
}

function spotlight_most_read_prepare($raw) {
    if (!is_array($raw) || ($raw['version'] ?? null) !== 1
        || ($raw['source'] ?? '') !== 'server-requests' || ($raw['complete'] ?? null) !== true
        || !is_array($raw['articles'] ?? null) || count($raw['articles']) > 200) {
        throw new InvalidArgumentException('Unsupported or incomplete ranking snapshot.');
    }
    $times = array();
    foreach (array('generated_at', 'window_start', 'window_end') as $key) {
        $value = $raw[$key] ?? '';
        if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\+00:00|Z)$/D', $value)) {
            throw new InvalidArgumentException('Ranking timestamps must use UTC.');
        }
        $times[$key] = strtotime($value);
        if ($times[$key] === false) {
            throw new InvalidArgumentException('Invalid ranking timestamp.');
        }
    }
    $now = time();
    if ($times['window_end'] - $times['window_start'] !== DAY_IN_SECONDS
        || $times['window_end'] > $now + 300 || $times['generated_at'] > $now + 300
        || $times['generated_at'] < $times['window_end']
        || $now - $times['window_end'] > 4 * HOUR_IN_SECONDS) {
        throw new InvalidArgumentException('Ranking reporting period is invalid or stale.');
    }
    $counts = array();
    foreach ($raw['articles'] as $row) {
        $path = $row['path'] ?? '';
        $requests = $row['requests'] ?? null;
        if (!is_string($path) || !preg_match('~^/[0-9]{4}/(?:0[1-9]|1[0-2])/[^/?#\\\\]{1,300}/$~D', $path)
            || !is_int($requests) || $requests < 3) {
            throw new InvalidArgumentException('Invalid aggregate article record.');
        }
        $id = url_to_postid(home_url($path));
        if ($id <= 0 || !spotlight_most_read_is_public(get_post($id))) {
            continue;
        }
        // URL aliases must not multiply one article's repeat allowance.
        $counts[$id] = max($counts[$id] ?? 0, $requests);
    }
    arsort($counts, SORT_NUMERIC);
    if (!$counts) {
        throw new InvalidArgumentException('No eligible public articles in the snapshot.');
    }
    return array_merge($times, array('version' => 1, 'source' => 'server-requests',
        'ids' => array_slice(array_keys($counts), 0, 50)));
}

function spotlight_most_read_items($snapshot = null, $limit = 20) {
    $snapshot = $snapshot ?? get_option('spotlight_most_read_snapshot', array());
    if (!is_array($snapshot) || ($snapshot['version'] ?? null) !== 1
        || !is_array($snapshot['ids'] ?? null) || count($snapshot['ids']) > 50
        || !is_int($snapshot['window_end'] ?? null) || $snapshot['window_end'] > time() + 300
        || time() - $snapshot['window_end'] > 4 * HOUR_IN_SECONDS) {
        return array();
    }
    $items = array();
    foreach (array_unique($snapshot['ids']) as $id) {
        if (!is_int($id) || !spotlight_most_read_is_public(get_post($id))) {
            continue;
        }
        $category = spotlight_most_read_category($id);
        $image = get_the_post_thumbnail_url($id, 'medium');
        $items[] = array('id' => $id, 'url' => get_permalink($id),
            'title' => wp_strip_all_tags(get_the_title($id)),
            'image' => $image ?: get_stylesheet_directory_uri() . '/libs/images/favicon.png',
            'image_fallback' => !$image, 'category' => $category['label'], 'tone' => $category['tone']);
        if (count($items) >= $limit) {
            break;
        }
    }
    return $items;
}

function spotlight_most_read_category($id) {
    $terms = get_the_terms($id, 'category');
    if (!is_array($terms) || !$terms) {
        return array('label' => 'News', 'tone' => 'stone');
    }
    $chosen = $terms[0];
    $primary = (int) get_post_meta($id, '_yoast_wpseo_primary_category', true);
    foreach ($terms as $term) {
        if ($term->term_id === $primary) {
            $chosen = $term;
            break;
        }
    }
    $labels = array('healthcare' => 'Health care', 'social-issues' => 'Social issues',
        'number-of-the-day' => 'Number of the day', 'energy-environment' => 'Energy & environment');
    $tones = array('education' => 'blue', 'opinion' => 'olive', 'healthcare' => 'sage',
        'budget' => 'rose', 'business' => 'rose', 'energy-environment' => 'sage',
        'immigration' => 'teal', 'social-issues' => 'teal');
    return array('label' => $labels[$chosen->slug] ?? html_entity_decode($chosen->name, ENT_QUOTES, 'UTF-8'),
        'tone' => $tones[$chosen->slug] ?? 'stone');
}

// MU-plugins load before the theme's guarded legacy function declarations.
if (!function_exists('njs_endpoint_popular')) {
    function njs_endpoint_popular() {
        $items = spotlight_most_read_items(null, 5);
        return new WP_REST_Response($items ? array('popular' => $items) : array(), 200);
    }
}

function spotlight_most_read_block($snapshot, $limit, $home = false, $heading = 'h2', $sidebar = false) {
    $items = spotlight_most_read_items($snapshot, $limit);
    if (!$items) {
        return $home ? '' : '<p>Most read rankings are temporarily unavailable. Please check again later.</p>';
    }
    $content = '<section class="spotlight-most-read' . ($sidebar ? ' spotlight-most-read--sidebar' : '')
        . '" aria-label="Most read stories">';
    if ($home) {
        $page = get_page_by_path('most-read');
        $content .= '<header class="spotlight-most-read__header"><h2>Most read</h2>';
        if ($page && $page->post_status === 'publish' && $page->post_password === '') {
            $content .= '<a class="spotlight-most-read__more" href="' . esc_url(get_permalink($page)) . '">See all stories</a>';
        }
        $content .= '</header>';
    }
    $content .= '<ul class="spotlight-most-read__list" role="list">';
    foreach ($items as $item) {
        $content .= '<li class="spotlight-most-read__story spotlight-most-read__story--' . esc_attr($item['tone']) . '">';
        $content .= '<a class="spotlight-most-read__story-link" href="' . esc_url($item['url']) . '"'
            . ($sidebar ? ' title="' . esc_attr($item['title']) . '"' : '') . '>';
        $content .= '<span class="spotlight-most-read__image"><img class="spotlight-most-read__thumbnail'
            . ($item['image_fallback'] ? ' spotlight-most-read__thumbnail--fallback' : '')
            . '" src="' . esc_url($item['image']) . '" alt="" width="80" height="80" loading="lazy" decoding="async"></span>';
        $content .= '<div class="spotlight-most-read__body"><' . $heading . ' class="spotlight-most-read__title">'
            . esc_html($item['title']) . '</' . $heading . '><div class="spotlight-most-read__footer">';
        $author = spotlight_story_byline($item['id']);
        if ($author !== '') {
            $content .= '<span class="spotlight-most-read__byline">' . esc_html($author) . '</span>';
        }
        $content .= '<div class="spotlight-most-read__category fig-overlay"><div class="cats uc">'
            . esc_html($item['category']) . '</div></div></div></div></a></li>';
    }
    return $content . '</ul></section>';
}

function spotlight_most_read_home($snapshot = null) {
    $snapshot = $snapshot ?? get_option('spotlight_most_read_snapshot', array());
    $content = spotlight_most_read_block($snapshot, 4, true, 'h3');
    return $content ? '<div class="hp-row spotlight-most-read__frame cf"><div class="cw ti">' . $content . '</div></div>' : '';
}

function spotlight_most_read_sidebar($snapshot = null) {
    $snapshot = $snapshot ?? get_option('spotlight_most_read_snapshot', array());
    $content = spotlight_most_read_block($snapshot, 4, true, 'h3', true);
    if ($content !== '') {
        $GLOBALS['spotlight_most_read_sidebar_rendered'] = true;
        $content .= <<<'HTML'
<script>
(() => {
    const section = document.currentScript.previousElementSibling;
    const list = section.querySelector('.spotlight-most-read__list');
    const cards = Array.from(list.children);
    const desktop = window.matchMedia('(min-width: 901px)');
    const update = () => {
        try {
            const box = list.getBoundingClientRect();
            const hidden = cards.map(card => {
                const row = card.getBoundingClientRect();
                return desktop.matches && (row.left < box.left - 0.5 || row.right > box.right + 0.5
                    || row.top < box.top - 0.5 || row.bottom > box.bottom + 0.5);
            });
            if (cards.some((card, index) => hidden[index] && card.contains(document.activeElement))) {
                const lastVisible = cards.filter((card, index) => !hidden[index]).pop();
                const target = lastVisible ? lastVisible.querySelector('a')
                    : section.querySelector('.spotlight-most-read__more');
                if (lastVisible) { lastVisible.inert = false; }
                if (target) {
                    target.focus();
                } else {
                    section.tabIndex = -1;
                    section.focus();
                }
            }
            cards.forEach((card, index) => { card.inert = hidden[index]; });
        } catch (error) {
            cards.forEach(card => { card.inert = false; });
        }
    };
    update();
    if (typeof desktop.addEventListener === 'function') {
        desktop.addEventListener('change', update);
    } else if (typeof desktop.addListener === 'function') {
        desktop.addListener(update);
    }
    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(update);
        observer.observe(list);
        cards.forEach(card => observer.observe(card));
    } else {
        window.addEventListener('resize', update);
    }
    if (document.fonts && document.fonts.ready) { document.fonts.ready.then(update); }
    window.addEventListener('load', update, { once: true });
})();
</script>
HTML;
    }
    return $content;
}

if (!function_exists('spotlight_hp_most_popular_shared')) {
    function spotlight_hp_most_popular_shared() {
        return !empty($GLOBALS['spotlight_most_read_sidebar_rendered']) ? '' : spotlight_most_read_home();
    }
}

function spotlight_most_read_page($snapshot = null, $limit = 10, $heading = 'h2') {
    $snapshot = $snapshot ?? get_option('spotlight_most_read_snapshot', array());
    return spotlight_most_read_block($snapshot, $limit, false, $heading);
}

add_action('wp_enqueue_scripts', function () {
    $path = get_stylesheet_directory() . '/libs/css/spotlight-most-read.css';
    if (is_readable($path)) {
        wp_enqueue_style('spotlight-most-read', get_stylesheet_directory_uri() . '/libs/css/spotlight-most-read.css',
            array('site-main'), (string) filemtime($path));
    }
}, 100);

add_shortcode('spotlight_most_read', function () {
    return spotlight_most_read_page();
});

if (defined('WP_CLI') && WP_CLI) {
    WP_CLI::add_command('spotlight-most-read import', function ($args, $assoc_args) {
        try {
            $json = file_get_contents($args[0] ?? '', false, null, 0, 131073);
            if ($json === false || strlen($json) > 131072) {
                throw new InvalidArgumentException('Cannot read bounded ranking snapshot.');
            }
            $snapshot = spotlight_most_read_prepare(json_decode($json, true, 32, JSON_THROW_ON_ERROR));
            if (!isset($assoc_args['dry-run'])) {
                update_option('spotlight_most_read_snapshot', $snapshot, false);
                if (get_option('spotlight_most_read_snapshot') !== $snapshot) {
                    throw new RuntimeException('Ranking save could not be verified.');
                }
            }
            WP_CLI::success(count($snapshot['ids']) . ' public articles validated.'
                . (isset($assoc_args['dry-run']) ? ' Nothing saved.' : ' Snapshot saved.'));
        } catch (Throwable $error) {
            WP_CLI::error($error->getMessage());
        }
    });
}

}
