<?php
// Retain the existing popup consumer with the same ranking explanation.
if (!defined('ABSPATH')) {
    return;
}
echo '<h2>Most read</h2>';
if (function_exists('spotlight_most_read_page')) {
    echo spotlight_most_read_page(null, 5, 'h3');
} else {
    echo '<p>Most read rankings are temporarily unavailable. Please check again later.</p>';
}
