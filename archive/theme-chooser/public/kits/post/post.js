/* ===================================================================
   post.js — Garden State poster
   Opt-in behaviors for the post design kit. Plain JS, no build, no
   dependencies. Loading it changes nothing until the matching markup
   is on the page; then each behavior wires itself up. No-op otherwise.

   Wired automatically when present:
     - theme toggle   .post-theme-toggle  or  [data-post-toggle-theme]
     - mobile nav      .post-nav           with [data-post-nav-toggle]

   Public API on window.Poster:
     - isDark()                  current theme is dark
     - setTheme('dark'|'light')  set + persist + notify
     - toggleTheme()             flip + persist + notify

   Fires a 'post:themechange' event on document when the theme flips,
   so a host (e.g. the particle-NJ hero) can re-read its CSS colors.

   No scroll-jacking of any kind: nothing here intercepts, delays, or
   snaps the page scroll.
   =================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'post-theme';
  var root = document.documentElement;

  /* ---------- Theme ---------- */
  function isDark() {
    var t = root.getAttribute('data-post-theme');
    if (t) return t === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function setTheme(mode) {
    var dark = mode === 'dark';
    root.setAttribute('data-post-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(STORE_KEY, dark ? 'dark' : 'light'); } catch (e) {}
    syncToggles();
    document.dispatchEvent(new CustomEvent('post:themechange', { detail: { dark: dark } }));
  }

  function toggleTheme() { setTheme(isDark() ? 'light' : 'dark'); }

  function syncToggles() {
    var d = isDark();
    document.querySelectorAll('.post-theme-toggle, [data-post-toggle-theme]').forEach(function (btn) {
      btn.setAttribute('data-mode', d ? 'dark' : 'light');
      btn.setAttribute('aria-pressed', d ? 'true' : 'false');
    });
  }

  function initTheme() {
    // Respect a saved choice; otherwise leave whatever the page declared.
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (saved === 'dark' || saved === 'light') root.setAttribute('data-post-theme', saved);
    syncToggles();
    document.querySelectorAll('.post-theme-toggle, [data-post-toggle-theme]').forEach(function (btn) {
      btn.addEventListener('click', toggleTheme);
    });
  }

  /* ---------- Mobile nav (hamburger) ---------- */
  function closeAllNavs() {
    document.querySelectorAll('.post-nav.is-open').forEach(function (nav) {
      nav.classList.remove('is-open');
      var toggle = navToggleFor(nav);
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });
  }

  // The toggle is matched by aria-controls -> nav id, or falls back to the
  // toggle that sits in the same masthead as the nav.
  function navToggleFor(nav) {
    if (nav.id) {
      var byControls = document.querySelector('[data-post-nav-toggle][aria-controls="' + cssEscape(nav.id) + '"]');
      if (byControls) return byControls;
    }
    var scope = nav.closest('.post-masthead') || document;
    return scope.querySelector('[data-post-nav-toggle], .post-nav-toggle');
  }

  function navFor(toggle) {
    var id = toggle.getAttribute('aria-controls');
    if (id) {
      var byId = document.getElementById(id);
      if (byId) return byId;
    }
    var scope = toggle.closest('.post-masthead') || document;
    return scope.querySelector('.post-nav');
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function initNav() {
    var toggles = document.querySelectorAll('[data-post-nav-toggle], .post-nav-toggle');
    if (!toggles.length) return;
    var wired = false;

    toggles.forEach(function (toggle) {
      var nav = navFor(toggle);
      if (!nav) return;
      wired = true;
      if (!toggle.hasAttribute('aria-expanded')) toggle.setAttribute('aria-expanded', 'false');

      toggle.addEventListener('click', function () {
        var willOpen = !nav.classList.contains('is-open');
        closeAllNavs();
        if (willOpen) {
          nav.classList.add('is-open');
          toggle.setAttribute('aria-expanded', 'true');
        }
      });

      // Close on link tap.
      nav.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', closeAllNavs);
      });
    });

    if (!wired) return;

    // One shared document listener handles Escape + outside-click for every nav.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') closeAllNavs();
    });
    document.addEventListener('click', function (e) {
      if (e.target.closest('.post-nav') || e.target.closest('[data-post-nav-toggle], .post-nav-toggle')) return;
      closeAllNavs();
    });
  }

  /* ---------- Boot ---------- */
  function boot() {
    initTheme();
    initNav();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.Poster = {
    isDark: isDark,
    setTheme: setTheme,
    toggleTheme: toggleTheme
  };
})();
