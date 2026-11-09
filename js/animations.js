/* ============================================================
   Tilt, ripple, mobile drawer, settings, theme
   ============================================================ */
(function(){
  'use strict';

  const UA = window.UA;
  const $  = UA.$;
  const $$ = UA.$$;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 3D tilt ---------- */
  function bindTilt(scope){
    const root = scope || document;
    root.querySelectorAll('[data-tilt], .tilt').forEach(el => {
      if (el.dataset.tiltBound) return;
      el.dataset.tiltBound = '1';
      if (reduced) return;

      let raf = null;
      let mx = 0, my = 0;

      const apply = () => {
        raf = null;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = (mx - rect.left) / rect.width;
        const py = (my - rect.top) / rect.height;
        const rx = (0.5 - py) * 6;   // max 6deg
        const ry = (px - 0.5) * 6;
        el.style.setProperty('--rx', rx.toFixed(2) + 'deg');
        el.style.setProperty('--ry', ry.toFixed(2) + 'deg');
        el.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
        el.style.setProperty('--my', (py * 100).toFixed(1) + '%');
      };

      el.addEventListener('pointermove', e => {
        if (e.pointerType === 'touch') return;
        mx = e.clientX; my = e.clientY;
        if (!raf) raf = requestAnimationFrame(apply);
      }, { passive: true });

      el.addEventListener('pointerleave', () => {
        el.style.setProperty('--rx', '0deg');
        el.style.setProperty('--ry', '0deg');
      });
    });
  }

  /* ---------- button ripple ---------- */
  function bindRipples(){
    document.addEventListener('pointerdown', e => {
      const btn = e.target.closest('.btn, .tool-btn, .nav-item, .mini-btn, .word-chip');
      if (!btn || reduced) return;
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = size + 'px';
      span.style.left = (e.clientX - rect.left - size / 2) + 'px';
      span.style.top  = (e.clientY - rect.top  - size / 2) + 'px';
      const cs = getComputedStyle(btn);
      if (cs.position === 'static') btn.style.position = 'relative';
      btn.appendChild(span);
      setTimeout(() => span.remove(), 600);
    }, { passive: true });
  }

  /* ---------- mobile drawer ---------- */
  function bindDrawer(){
    const body = document.body;
    const overlay = $('#sidebarOverlay');
    const menuBtn = $('#btnMenu');

    const close = () => {
      body.classList.remove('sidebar-open');
      if (overlay) overlay.hidden = true;
    };
    const open = () => {
      body.classList.add('sidebar-open');
      if (overlay) overlay.hidden = false;
    };

    if (menuBtn){
      menuBtn.addEventListener('click', () => {
        if (body.classList.contains('sidebar-open')) close();
        else {
          open();
          // also open the right sidebar on tablet where it is off-canvas
          body.classList.remove('right-open');
        }
      });
    }
    if (overlay) overlay.addEventListener('click', () => {
      close();
      body.classList.remove('right-open');
    });

    // close drawer when a nav item is chosen (mobile)
    $$('.side-nav .nav-item').forEach(n => {
      n.addEventListener('click', () => {
        if (window.innerWidth <= 900) close();
      });
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { close(); body.classList.remove('right-open'); }
    });
  }

  /* ---------- theme ---------- */
  function applyTheme(theme){
    document.documentElement.dataset.theme = theme;
    UA.Prefs.set('theme', theme);
    const seg = $('#setTheme');
    if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === theme));
    if (window.Dashboard) Dashboard.redraw();
  }

  function applyAnimations(on){
    document.body.classList.toggle('no-anim', !on);
    UA.Prefs.set('anim', on);
    const seg = $('#setAnim');
    if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', (b.dataset.val === 'on') === on));
  }

  /* ---------- settings modal ---------- */
  function bindSettings(){
    const backdrop = $('#settingsBackdrop');
    const btn = $('#btnSettings');
    const closeBtn = $('#settingsClose');

    if (btn && backdrop){
      btn.addEventListener('click', () => backdrop.classList.remove('hidden'));
    }
    if (closeBtn && backdrop){
      closeBtn.addEventListener('click', () => backdrop.classList.add('hidden'));
    }
    if (backdrop){
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    }

    const themeSeg = $('#setTheme');
    if (themeSeg){
      themeSeg.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => applyTheme(b.dataset.val));
      });
    }
    const animSeg = $('#setAnim');
    if (animSeg){
      animSeg.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => applyAnimations(b.dataset.val === 'on'));
      });
    }
    const pSeg = $('#setParticles');
    if (pSeg){
      pSeg.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          if (window.ThreeScene) ThreeScene.setDensity(b.dataset.val);
          pSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        });
      });
    }
    const reset = $('#setReset');
    if (reset){
      reset.addEventListener('click', async () => {
        const ok = await UA.confirmModal('Reset all data?', 'This clears uploads, text and preferences stored in this browser.');
        if (!ok) return;
        try { localStorage.clear(); } catch(e){}
        location.reload();
      });
    }
  }

  /* ---------- theme button ---------- */
  function bindThemeButton(){
    const btn = $('#btnTheme');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      applyTheme(cur);
    });
  }

  /* ---------- boot prefs ---------- */
  function bootPrefs(){
    const theme = UA.Prefs.get('theme', 'dark');
    applyTheme(theme);
    const anim = UA.Prefs.get('anim', true);
    applyAnimations(anim);
    const dens = UA.Prefs.get('particles', 'medium');
    const pSeg = $('#setParticles');
    if (pSeg) pSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === dens));
  }

  function init(){
    bootPrefs();
    bindTilt(document);
    bindRipples();
    bindDrawer();
    bindSettings();
    bindThemeButton();
  }

  window.Animations = { init, bindTilt };

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else init();
})();
