/* ===================================================================
   gs.js  —  Garden State public
   Opt-in behaviors for the gs design kit. Plain JS, no build, no
   dependencies. Loading it changes nothing until the matching markup
   is on the page; then each behavior wires itself up, otherwise no-op.

   Wired automatically when present:
     - theme toggle    .gs-theme-toggle  or  [data-gs-toggle-theme]
     - mobile nav      .gs-masthead      with [data-gs-nav-toggle]
     - utility dismiss .gs-utility       with [data-gs-dismiss]

   Public API on window.GardenState:
     - isDark()                  current theme is dark
     - setTheme('dark'|'light')  set + persist + notify
     - toggleTheme()             flip + persist + notify
   Fires a 'gs:themechange' CustomEvent on document when the theme
   flips (detail: { dark }), so the canvas hero can re-read its colors.

   No scroll-jacking of any kind. prefers-reduced-motion is honored
   (no smooth scrollIntoView; CSS zeroes animation separately).
   =================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'gs-theme';
  var root = document.documentElement;

  /* ---------- Theme ---------- */
  function isDark() {
    var t = root.getAttribute('data-gs-theme');
    if (t) return t === 'dark';
    // Light is the canonical default; only report dark when explicitly set.
    return false;
  }

  function setTheme(mode) {
    var m = mode === 'dark' ? 'dark' : 'light';
    root.setAttribute('data-gs-theme', m);
    try { localStorage.setItem(STORE_KEY, m); } catch (e) {}
    syncToggles();
    document.dispatchEvent(new CustomEvent('gs:themechange', { detail: { dark: m === 'dark' } }));
  }

  function toggleTheme() { setTheme(isDark() ? 'light' : 'dark'); }

  function syncToggles() {
    var d = isDark();
    document.querySelectorAll('.gs-theme-toggle, [data-gs-toggle-theme]').forEach(function (btn) {
      btn.setAttribute('data-mode', d ? 'dark' : 'light');
      btn.setAttribute('aria-pressed', d ? 'true' : 'false');
    });
  }

  function initTheme() {
    // Respect a saved choice; otherwise leave whatever the page declared
    // (the no-flash snippet may have set data-gs-theme already).
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (saved === 'dark' || saved === 'light') root.setAttribute('data-gs-theme', saved);
    syncToggles();
    document.querySelectorAll('.gs-theme-toggle, [data-gs-toggle-theme]').forEach(function (btn) {
      btn.addEventListener('click', toggleTheme);
    });
  }

  /* ---------- Mobile nav (hamburger) ---------- */
  function closeAllNav() {
    document.querySelectorAll('.gs-masthead.is-open').forEach(function (m) {
      m.classList.remove('is-open');
      var t = m.querySelector('[data-gs-nav-toggle], .gs-nav-toggle');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
  }

  function initNav() {
    var wired = false;
    document.querySelectorAll('.gs-masthead').forEach(function (mast) {
      var toggle = mast.querySelector('[data-gs-nav-toggle], .gs-nav-toggle');
      if (!toggle) return;
      wired = true;
      toggle.addEventListener('click', function () {
        var willOpen = !mast.classList.contains('is-open');
        closeAllNav();
        if (willOpen) { mast.classList.add('is-open'); toggle.setAttribute('aria-expanded', 'true'); }
      });
      // Close on link tap.
      mast.querySelectorAll('.gs-nav a').forEach(function (a) { a.addEventListener('click', closeAllNav); });
    });
    if (!wired) return;
    // One shared document listener handles Escape and outside-click for every masthead.
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAllNav(); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.gs-masthead')) closeAllNav(); });
  }

  /* ---------- Utility / status bar dismiss ---------- */
  function initUtility() {
    document.querySelectorAll('[data-gs-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var bar = btn.closest('.gs-utility') || document.getElementById(btn.getAttribute('data-gs-dismiss'));
        if (bar) bar.remove();
      });
    });
  }

  /* ---------- Boot ---------- */
  function boot() {
    initTheme();
    initNav();
    initUtility();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.GardenState = {
    isDark: isDark,
    setTheme: setTheme,
    toggleTheme: toggleTheme
  };
})();
