/* ===================================================================
   glasshouse.js — Garden signal glasshouse kit behaviors
   Plain JS, optional enhancements only. No scroll snapping, no scroll
   interception, no custom scroll container.

   Wired automatically when present:
     - utility dismiss     [data-glasshouse-dismiss]
     - theme toggle        [data-glasshouse-toggle-theme]
     - mobile nav          .glasshouse-masthead with [data-glasshouse-nav-toggle]
     - passive parallax    .glasshouse wrapper gets --glasshouse-scroll
     - optional Three.js   window.Glasshouse.mountThree(canvas) on demand

   Public API on window.Glasshouse:
     - isDark()
     - setTheme('dark'|'light')
     - toggleTheme()
     - mountThree(canvas)
   =================================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'glasshouse-theme';
  var THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.min.js';
  var root = document.documentElement;
  var reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  function isDark() {
    var t = root.getAttribute('data-glasshouse-theme');
    if (t) return t === 'dark';
    return window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
  }

  function setTheme(mode) {
    var dark = mode === 'dark';
    root.setAttribute('data-glasshouse-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(STORE_KEY, dark ? 'dark' : 'light'); } catch (e) {}
    syncToggles();
    document.dispatchEvent(new CustomEvent('glasshouse:themechange', { detail: { dark: dark } }));
  }

  function toggleTheme() {
    setTheme(isDark() ? 'light' : 'dark');
  }

  function syncToggles() {
    var d = isDark();
    document.querySelectorAll('[data-glasshouse-toggle-theme]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', d ? 'true' : 'false');
      btn.setAttribute('data-mode', d ? 'dark' : 'light');
      var label = btn.querySelector('[data-glasshouse-theme-label]');
      if (label) label.textContent = d ? 'Dark' : 'Light';
    });
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (saved === 'dark' || saved === 'light') root.setAttribute('data-glasshouse-theme', saved);
    syncToggles();
    document.querySelectorAll('[data-glasshouse-toggle-theme]').forEach(function (btn) {
      btn.addEventListener('click', toggleTheme);
    });
  }

  function closeNavs() {
    document.querySelectorAll('.glasshouse-masthead.is-open').forEach(function (mast) {
      mast.classList.remove('is-open');
      var toggle = mast.querySelector('[data-glasshouse-nav-toggle]');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });
  }

  function initNav() {
    var wired = false;
    document.querySelectorAll('.glasshouse-masthead').forEach(function (mast) {
      var toggle = mast.querySelector('[data-glasshouse-nav-toggle]');
      if (!toggle) return;
      wired = true;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', function () {
        var willOpen = !mast.classList.contains('is-open');
        closeNavs();
        if (willOpen) {
          mast.classList.add('is-open');
          toggle.setAttribute('aria-expanded', 'true');
        }
      });
      mast.querySelectorAll('.glasshouse-nav a').forEach(function (a) {
        a.addEventListener('click', closeNavs);
      });
    });
    if (!wired) return;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNavs(); });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.glasshouse-masthead')) closeNavs();
    });
  }

  function initDismiss() {
    document.querySelectorAll('[data-glasshouse-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var bar = btn.closest('.glasshouse-utility');
        if (bar) bar.hidden = true;
      });
    });
  }

  function initParallax() {
    if (reduceMotion) return;
    var sections = document.querySelectorAll('.glasshouse');
    if (!sections.length) return;
    var ticking = false;
    function update() {
      ticking = false;
      var doc = document.documentElement;
      var max = Math.max(1, doc.scrollHeight - window.innerHeight);
      var progress = Math.min(1, Math.max(0, window.scrollY / max));
      sections.forEach(function (section) {
        section.style.setProperty('--glasshouse-scroll', progress.toFixed(4));
        section.style.setProperty('--glasshouse-breathe', Math.sin(progress * Math.PI).toFixed(4));
      });
    }
    function requestUpdate() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }
    update();
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);
  }

  function initPointerField() {
    if (reduceMotion) return;
    var sections = document.querySelectorAll('.glasshouse');
    if (!sections.length) return;
    var pointerTicking = false;
    var pointerX = 0;
    var pointerY = 0;
    function renderPointer() {
      pointerTicking = false;
      sections.forEach(function (section) {
        section.style.setProperty('--glasshouse-pointer-x', pointerX.toFixed(4));
        section.style.setProperty('--glasshouse-pointer-y', pointerY.toFixed(4));
      });
    }
    function updatePointer(e) {
      pointerX = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
      pointerY = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
      if (pointerTicking) return;
      pointerTicking = true;
      window.requestAnimationFrame(renderPointer);
    }
    window.addEventListener('pointermove', updatePointer, { passive: true });
  }

  function mountThree(canvas) {
    if (!canvas || reduceMotion) return function () {};
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.pointerEvents = 'none';

    var disposed = false;
    var cleanup = function () { disposed = true; };

    import(THREE_URL).then(function (mod) {
      if (disposed) return;
      var THREE = mod;
      var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      var scene = new THREE.Scene();
      var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.z = 7;

      var group = new THREE.Group();
      scene.add(group);

      var leafMaterial = new THREE.MeshBasicMaterial({ color: 0xB7FFD8, transparent: true, opacity: 0.42 });
      var ringMaterial = new THREE.MeshBasicMaterial({ color: 0xF0B23E, transparent: true, opacity: 0.32, side: THREE.DoubleSide });
      for (var i = 0; i < 21; i += 1) {
        var radius = 0.08 + (i % 5) * 0.035;
        var leaf = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), leafMaterial);
        leaf.scale.set(1, 2.2, 1);
        leaf.position.set(((i * 37) % 100) / 12 - 4.1, ((i * 53) % 100) / 14 - 3.4, -((i % 7) * 0.08));
        leaf.rotation.z = i * 0.61;
        group.add(leaf);
      }
      for (var r = 0; r < 4; r += 1) {
        var ring = new THREE.Mesh(new THREE.RingGeometry(1.1 + r * 0.7, 1.115 + r * 0.7, 96), ringMaterial);
        ring.position.z = -0.8;
        group.add(ring);
      }

      function resize() {
        var rect = canvas.getBoundingClientRect();
        var width = Math.max(1, rect.width);
        var height = Math.max(1, rect.height);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
      function frame(t) {
        if (disposed) return;
        resize();
        var time = t * 0.00012;
        group.rotation.z = Math.sin(time) * 0.08;
        group.rotation.x = Math.cos(time * 0.7) * 0.06;
        renderer.render(scene, camera);
        window.requestAnimationFrame(frame);
      }
      cleanup = function () {
        disposed = true;
        renderer.dispose();
        group.traverse(function (obj) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
        });
      };
      window.requestAnimationFrame(frame);
    }).catch(function () {
      canvas.hidden = true;
    });

    return function () { cleanup(); };
  }

  function boot() {
    initTheme();
    initNav();
    initDismiss();
    initParallax();
    initPointerField();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.Glasshouse = {
    isDark: isDark,
    setTheme: setTheme,
    toggleTheme: toggleTheme,
    mountThree: mountThree
  };
  document.dispatchEvent(new CustomEvent('glasshouse:ready'));
})();
