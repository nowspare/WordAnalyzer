/* ============================================================
   UI — navigation, theme, settings, charts, word cloud, contact
   ============================================================ */
(function(){
  'use strict';

  const WA = window.WA;
  const $  = WA.$;
  const $$ = WA.$$;

  /* ============================================================
     NAVIGATION
     ============================================================ */
  const PAGES = ['home', 'features', 'privacy', 'contact', 'app'];

  function goTo(page){
    if (!PAGES.includes(page)) page = 'home';

    $$('.page').forEach(el => el.classList.remove('active'));
    const target = document.getElementById('page-' + page);
    if (target) target.classList.add('active');

    $$('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.nav === page);
    });

    document.body.classList.remove('left-open', 'right-open');

    if (location.hash !== '#' + page){
      history.replaceState(null, '', '#' + page);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (page === 'app' && WA.Analyzer) WA.Analyzer.refreshAll();
  }

  function bindNavigation(){
    $$('[data-nav]').forEach(el => {
      el.addEventListener('click', event => {
        event.preventDefault();
        goTo(el.dataset.nav);
      });
    });

    window.addEventListener('hashchange', () => {
      const page = location.hash.replace('#', '');
      goTo(page || 'home');
    });

    const initial = location.hash.replace('#', '') || 'home';
    goTo(initial);
  }

  /* ============================================================
     DRAWER (mobile)
     ============================================================ */
  function bindDrawer(){
    const menu = $('#btnMenu');
    if (!menu) return;

    menu.addEventListener('click', () => {
      const body = document.body;
      if (body.classList.contains('left-open')){
        body.classList.remove('left-open');
        menu.setAttribute('aria-expanded', 'false');
      } else {
        body.classList.add('left-open');
        body.classList.remove('right-open');
        menu.setAttribute('aria-expanded', 'true');
      }
    });

    document.addEventListener('click', event => {
      if (window.innerWidth > 860) return;
      const inSidebar = event.target.closest('.sidebar-left');
      const isMenu = event.target.closest('#btnMenu');
      if (!inSidebar && !isMenu){
        document.body.classList.remove('left-open');
        menu.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape'){
        document.body.classList.remove('left-open', 'right-open');
        menu.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ============================================================
     THEME
     ============================================================ */
  function applyTheme(theme){
    document.documentElement.dataset.theme = theme;
    WA.Prefs.set('theme', theme);

    const icon = $('#btnTheme use');
    if (icon) icon.setAttribute('href', theme === 'light' ? '#i-sun' : '#i-moon');

    const seg = $('#setTheme');
    if (seg){
      seg.querySelectorAll('button').forEach(button => {
        button.classList.toggle('active', button.dataset.val === theme);
      });
    }
    if (WA.Analyzer && WA.Analyzer.state.files.length) WA.Analyzer.refreshViews();
  }

  function bindTheme(){
    const button = $('#btnTheme');
    if (button) button.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme;
      applyTheme(current === 'light' ? 'dark' : 'light');
    });
  }

  /* ============================================================
     SETTINGS
     ============================================================ */
  function bindSettings(){
    const backdrop = $('#settingsBackdrop');
    const open = $('#btnSettings');
    const close = $('#settingsClose');

    if (open && backdrop) open.addEventListener('click', () => backdrop.classList.remove('hidden'));
    if (close && backdrop) close.addEventListener('click', () => backdrop.classList.add('hidden'));
    if (backdrop) backdrop.addEventListener('click', event => {
      if (event.target === backdrop) backdrop.classList.add('hidden');
    });

    const themeSeg = $('#setTheme');
    if (themeSeg) themeSeg.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', () => applyTheme(button.dataset.val));
    });

    const animSeg = $('#setAnim');
    if (animSeg) animSeg.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', () => {
        const on = button.dataset.val === 'on';
        document.body.classList.toggle('no-anim', !on);
        WA.Prefs.set('anim', on);
        animSeg.querySelectorAll('button').forEach(item => {
          item.classList.toggle('active', item === button);
        });
      });
    });

    const dirSeg = $('#setDir');
    if (dirSeg) dirSeg.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', () => {
        const dir = button.dataset.val;
        WA.Analyzer.setDirection(dir);
        dirSeg.querySelectorAll('button').forEach(item => {
          item.classList.toggle('active', item === button);
        });
      });
    });

    const reset = $('#setReset');
    if (reset) reset.addEventListener('click', async () => {
      const ok = await WA.confirmModal('Reset preferences?', 'This clears theme, animation, and direction preferences from this browser. Files are not affected.');
      if (!ok) return;
      ['theme', 'anim', 'dir'].forEach(key => WA.Prefs.remove(key));
      location.reload();
    });
  }

  function bootPrefs(){
    const theme = WA.Prefs.get('theme', 'dark');
    applyTheme(theme);

    const anim = WA.Prefs.get('anim', true);
    document.body.classList.toggle('no-anim', !anim);
    const animSeg = $('#setAnim');
    if (animSeg){
      animSeg.querySelectorAll('button').forEach(button => {
        button.classList.toggle('active', (button.dataset.val === 'on') === anim);
      });
    }

    const dir = WA.Prefs.get('dir', 'ltr');
    const dirSeg = $('#setDir');
    if (dirSeg){
      dirSeg.querySelectorAll('button').forEach(button => {
        button.classList.toggle('active', button.dataset.val === dir);
      });
    }

    const ltr = $('#btnLtr');
    const rtl = $('#btnRtl');
    if (dir === 'rtl'){
      if (ltr) ltr.classList.remove('active');
      if (rtl) rtl.classList.add('active');
    }
  }

  /* ============================================================
     HOME QUICK STATS
     ============================================================ */
  function updateHomeStats(){
    if (!WA.Analyzer) return;
    const { stats } = WA.Analyzer.scopedStats('all');
    const map = {
      files: WA.Analyzer.state.files.length,
      words: stats.words,
      chars: stats.chars,
      sentences: stats.sentences
    };
    Object.keys(map).forEach(key => {
      const el = document.querySelector('[data-qs="' + key + '"]');
      if (el) el.textContent = map[key].toLocaleString();
    });
  }

  /* ============================================================
     DASHBOARD CHARTS (canvas, no dependencies)
     ============================================================ */
  function setupCanvas(canvas){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    const height = Number(canvas.getAttribute('height')) || 200;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  function cssVar(name){
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawDashboardCharts(stats){
    drawTopWords(stats);
    drawFileTypes();
  }

  function drawTopWords(stats){
    const canvas = $('#chartTopWords');
    if (!canvas) return;

    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);

    const entries = Array.from(stats.freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);

    if (!entries.length){
      ctx.fillStyle = cssVar('--text-muted') || '#777';
      ctx.font = '12px sans-serif';
      ctx.fillText('No data yet', 12, 24);
      return;
    }

    const max = entries[0][1] || 1;
    const rowHeight = Math.min(24, (height - 12) / entries.length);
    const labelWidth = Math.min(110, width * 0.38);
    const barX = labelWidth + 8;
    const barWidth = width - barX - 34;
    const textColor = cssVar('--text') || '#fff';
    const muted = cssVar('--text-muted') || '#777';
    const barColor = cssVar('--text-soft') || '#aaa';

    entries.forEach(([word, count], index) => {
      const y = 6 + index * rowHeight;
      const length = Math.max(2, (count / max) * barWidth);

      ctx.fillStyle = barColor;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(barX, y + 4, length, rowHeight - 8);
      ctx.globalAlpha = 1;

      ctx.fillStyle = textColor;
      ctx.font = '600 11px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(word, labelWidth, y + rowHeight - 7);

      ctx.textAlign = 'left';
      ctx.fillStyle = muted;
      ctx.fillText(String(count), barX + length + 6, y + rowHeight - 7);
    });
  }

  function drawFileTypes(){
    const canvas = $('#chartFileTypes');
    if (!canvas || !WA.Analyzer) return;

    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);

    const groups = { PDF: 0, Image: 0, Document: 0, Text: 0, Other: 0 };

    WA.Analyzer.state.files.forEach(file => {
      const ext = (file.ext || '').toLowerCase();
      if (ext === 'pdf') groups.PDF++;
      else if (['jpg','jpeg','png','webp','gif'].includes(ext)) groups.Image++;
      else if (['docx','xlsx','xls','pptx'].includes(ext)) groups.Document++;
      else if (WA.TEXT_EXTENSIONS.has(ext)) groups.Text++;
      else groups.Other++;
    });

    const entries = Object.entries(groups).filter(([, count]) => count > 0);

    if (!entries.length){
      ctx.fillStyle = cssVar('--text-muted') || '#777';
      ctx.font = '12px sans-serif';
      ctx.fillText('No files yet', 12, 24);
      return;
    }

    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    const cx = width * 0.42;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.34;
    const inner = radius * 0.58;

    // grayscale shades only
    const shades = ['#ffffff', '#d0d0d0', '#a0a0a0', '#707070', '#404040'];

    let start = -Math.PI / 2;
    entries.forEach(([, count], index) => {
      const sweep = (count / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, start, start + sweep);
      ctx.closePath();
      ctx.fillStyle = shades[index % shades.length];
      ctx.fill();
      start += sweep;
    });

    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--surface-2') || '#111';
    ctx.fill();

    ctx.fillStyle = cssVar('--text') || '#fff';
    ctx.font = '700 16px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(total), cx, cy - 1);

    ctx.fillStyle = cssVar('--text-muted') || '#777';
    ctx.font = '600 9px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('FILES', cx, cy + 13);

    // legend
    ctx.textAlign = 'left';
    let ly = 14;
    entries.forEach(([label, count], index) => {
      ctx.fillStyle = shades[index % shades.length];
      ctx.fillRect(width - 92, ly, 8, 8);
      ctx.fillStyle = cssVar('--text-soft') || '#aaa';
      ctx.font = '600 10px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(label + ' · ' + count, width - 78, ly + 8);
      ly += 16;
    });
  }

  /* ============================================================
     WORD CLOUD
     ============================================================ */
  function drawWordCloud(entries){
    const host = $('#wordCloud');
    if (!host) return;

    if (!entries.length){
      host.innerHTML = '<p class="meta">No words to display.</p>';
      return;
    }

    const top = entries.slice(0, 40);
    const max = top[0][1] || 1;
    const min = top[top.length - 1][1] || 1;

    host.innerHTML = top.map(([word, count]) => {
      const ratio = max === min ? 0.5 : (count - min) / (max - min);
      const size = 12 + ratio * 26;
      return '<button class="wc-word" data-word="' + WA.escapeHtml(word) + '" ' +
        'style="font-size:' + size.toFixed(1) + 'px" ' +
        'title="' + WA.escapeHtml(word) + ' · ' + count + '">' +
        WA.escapeHtml(word) + '</button>';
    }).join('');

    host.querySelectorAll('.wc-word').forEach(button => {
      button.addEventListener('click', () => {
        const word = button.dataset.word;
        const input = $('#quickSearch');
        if (input) input.value = word;
        if (WA.Analyzer){
          WA.Analyzer.switchView('editor');
          WA.Analyzer.performSearch(word, { scope: WA.Analyzer.state.scope });
        }
      });
    });
  }

  /* ============================================================
     CONTACT FORM
     ============================================================ */
  function bindContactForm(){
    const form = $('#contactForm');
    if (!form) return;

    form.addEventListener('submit', event => {
      event.preventDefault();

      const name = $('#cfName').value.trim();
      const email = $('#cfEmail').value.trim();
      const subject = $('#cfSubject').value;
      const message = $('#cfMessage').value.trim();

      if (!name || !email || !message){
        WA.toast('Please fill in name, email, and message.', 'err');
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
        WA.toast('Please enter a valid email address.', 'err');
        return;
      }

      const body = encodeURIComponent(message + '\n\n— ' + name + ' (' + email + ')');
      const mailto = 'mailto:hello@wordanalyzer.dev?subject=' + encodeURIComponent(subject) + '&body=' + body;
      window.location.href = mailto;
      WA.toast('Opening your email app…', 'ok');
    });
  }

  /* ============================================================
     MISC
     ============================================================ */
  function bindMisc(){
    const year = $('#year');
    if (year) year.textContent = new Date().getFullYear();

    window.addEventListener('resize', WA.debounce(() => {
      if (WA.Analyzer && WA.Analyzer.state.files.length) WA.Analyzer.refreshViews();
    }, 220));

    window.addEventListener('error', event => {
      WA.log('window error', event.message, event.filename, event.lineno);
    });
  }

  WA.UI = {
    goTo,
    applyTheme,
    updateHomeStats,
    drawDashboardCharts,
    drawWordCloud
  };

  function init(){
    bootPrefs();
    bindNavigation();
    bindDrawer();
    bindTheme();
    bindSettings();
    bindContactForm();
    bindMisc();
    updateHomeStats();
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();