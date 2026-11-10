<?php
if (!defined('ABSPATH')) {
    return;
}
if (!defined('SPOTLIGHT_MOST_READ_ACTIVE') || !SPOTLIGHT_MOST_READ_ACTIVE) {
    get_template_part('views/pages/page', 'view');
    return;
}
get_header();
?>
<div class="cw ti cf">
  <div id="primary" class="content-area cf">
    <main id="main" class="site-main spotlight-most-read-page" role="main">
      <?php while (have_posts()) : the_post(); ?>
        <article id="post-<?php the_ID(); ?>" <?php post_class('single-article'); ?>>
          <header class="a-head entry-header">
            <?php the_title('<h1 class="entry-title">', '</h1>'); ?>
          </header>
          <div class="entry-content cf"><?php the_content(); ?></div>
        </article>
      <?php endwhile; ?>
    </main>
  </div>
</div>
<?php get_footer(); ?>
