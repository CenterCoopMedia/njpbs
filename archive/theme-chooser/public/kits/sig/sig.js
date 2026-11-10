/* ===================================================================
   sig.js  —  Signal kit behaviors
   Plain JS, no build, no dependencies. Loading it changes nothing
   until the matching markup is on the page; then each behavior wires
   itself up. No-op otherwise.

   Wired automatically when present:
     - theme toggle   .sig-theme-toggle  or  [data-sig-toggle-theme]
     - mobile nav      .sig-masthead     with [data-sig-nav-toggle]
     - channel clock   [data-sig-clock]  (mono station time; static under
                        reduced motion — updates once, no ticking loop)

   Public API on window.Signal:
     - isDark()                 current theme is dark
     - setTheme('dark'|'light') set + persist + notify
     - toggleTheme()            flip + persist + notify
   Fires a 'sig:themechange' event on document when the theme flips, so
   a page can re-theme a canvas (the particle-NJ hero reads its colors
   from CSS vars and can re-read on this event).

   No scroll-jacking of any kind: nothing here intercepts, delays, or
   snaps scrolling.
   =================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'sig-theme';
  var root = document.documentElement;
  var reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  /* ---------- Theme ---------- */
  function isDark() {
    var t = root.getAttribute('data-sig-theme');
    if (t) return t === 'dark';
    return window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
  }

  function setTheme(mode) {
    var dark = mode === 'dark';
    root.setAttribute('data-sig-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(STORE_KEY, dark ? 'dark' : 'light'); } catch (e) {}
    syncToggles();
    document.dispatchEvent(new CustomEvent('sig:themechange', { detail: { dark: dark } }));
  }

  function toggleTheme() { setTheme(isDark() ? 'light' : 'dark'); }

  function syncToggles() {
    var d = isDark();
    document.querySelectorAll('.sig-theme-toggle, [data-sig-toggle-theme]').forEach(function (btn) {
      btn.setAttribute('data-mode', d ? 'dark' : 'light');
      btn.setAttribute('aria-pressed', d ? 'true' : 'false');
    });
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (saved === 'dark' || saved === 'light') root.setAttribute('data-sig-theme', saved);
    syncToggles();
    document.querySelectorAll('.sig-theme-toggle, [data-sig-toggle-theme]').forEach(function (btn) {
      btn.addEventListener('click', toggleTheme);
    });
  }

  /* ---------- Mobile nav (hamburger) ---------- */
  function closeAllNavs() {
    document.querySelectorAll('.sig-masthead.is-open').forEach(function (mast) {
      mast.classList.remove('is-open');
      var t = mast.querySelector('[data-sig-nav-toggle], .sig-nav-toggle');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
  }

  function initNav() {
    var wired = false;
    document.querySelectorAll('.sig-masthead').forEach(function (mast) {
      var toggle = mast.querySelector('[data-sig-nav-toggle], .sig-nav-toggle');
      if (!toggle) return;
      wired = true;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', function () {
        var willOpen = !mast.classList.contains('is-open');
        closeAllNavs();
        if (willOpen) {
          mast.classList.add('is-open');
          toggle.setAttribute('aria-expanded', 'true');
        }
      });
      // Close after tapping any nav link.
      mast.querySelectorAll('.sig-nav a').forEach(function (a) {
        a.addEventListener('click', closeAllNavs);
      });
    });
    if (!wired) return;
    // ONE shared document listener handles Escape + outside-click for every nav.
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAllNavs(); });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.sig-masthead')) closeAllNavs();
    });
  }

  /* ---------- Channel clock ---------- */
  // A small civic-broadcast wink: a mono "station time". Updates once a
  // minute by default; under reduced motion it sets the time once and never
  // ticks. Markup: <span data-sig-clock data-sig-clock-prefix="ch 23">…</span>
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clockText(el) {
    var d = new Date();
    var prefix = el.getAttribute('data-sig-clock-prefix');
    var time = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return prefix ? prefix + ' · ' + time : time;
  }
  function initClock() {
    var clocks = document.querySelectorAll('[data-sig-clock]');
    if (!clocks.length) return;
    function render() {
      clocks.forEach(function (el) {
        var face = el.querySelector('[data-sig-clock-face]') || el;
        face.textContent = clockText(el);
      });
    }
    render();
    if (reduceMotion) return; // static time, no ticking loop
    // Align the first tick to the next minute boundary, then every minute.
    var now = new Date();
    var msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    setTimeout(function () {
      render();
      setInterval(render, 60000);
    }, Math.max(0, msToNextMinute));
  }

  /* ---------- Boot ---------- */
  function boot() {
    initTheme();
    initNav();
    initClock();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.Signal = {
    isDark: isDark,
    setTheme: setTheme,
    toggleTheme: toggleTheme
  };
})();
