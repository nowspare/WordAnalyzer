/* ============================================================
   Dashboard — 3D cards, count-up, canvas charts, word cloud
   All values come from real computed statistics.
   ============================================================ */
(function(){
  'use strict';

  const UA = window.UA;
  const $ = UA.$;

  const PALETTE = ['#4ff0e0','#4da3ff','#a86bff','#ff6bd6','#ffc46b','#4be3a0'];
  let last = { stats: null, files: [] };

  /* ---------- helpers ---------- */
  function dpr(canvas){
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    const h = Number(canvas.getAttribute('height')) || 200;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, w, h };
  }

  function easeOut(t){ return 1 - Math.pow(1 - t, 3); }

  function animateCounter(el, target){
    const start = 0;
    const dur = 700;
    const t0 = performance.now();
    const fmt = n => Math.round(n).toLocaleString();
    function frame(now){
      const t = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(start + (target - start) * easeOut(t));
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- dashboard cards ---------- */
  function renderDashboard(stats, files){
    last = { stats, files };
    const host = $('#dashGrid');
    if (!host) return;

    const words = stats.words || 0;
    const chars = stats.chars || 0;
    const sentences = stats.sentences || 0;
    const paragraphs = stats.paragraphs || 0;
    const unique = stats.uniqueWords || 0;
    const avgWord = words > 0 ? (stats.letters / words) : 0;
    const readingMin = words > 0 ? Math.max(1, Math.round(words / 200)) : 0;
    const mostWord = topEntry(stats.freq);

    const cards = [
      ['Words', words, 'total tokens', false],
      ['Characters', chars, 'including spaces', false],
      ['Sentences', sentences, 'detected', false],
      ['Paragraphs', paragraphs, 'blocks', false],
      ['Unique Words', unique, 'distinct tokens', false],
      ['Avg Word Length', avgWord.toFixed(2), 'letters / word', true],
      ['Reading Time', readingMin + ' min', 'at 200 wpm', true],
      ['Files', files.length, 'loaded', false]
    ];

    host.innerHTML = cards.map(([label, value, sub, small]) => `
      <div class="dash-card tilt" data-tilt>
        <div class="dash-label"><i></i>${label}</div>
        <div class="dash-value ${small ? 'small' : ''}" data-count="${typeof value === 'number' ? value : ''}">${typeof value === 'string' ? value : '0'}</div>
        <div class="dash-sub">${sub}</div>
        ${label === 'Words' && mostWord ? `<div class="dash-sub">top: ${UA.escapeHtml(mostWord[0])}</div>` : ''}
      </div>
    `).join('');

    // count-up numeric values
    host.querySelectorAll('.dash-value[data-count]').forEach(el => {
      const n = Number(el.dataset.count);
      if (Number.isFinite(n) && el.dataset.count !== '') animateCounter(el, n);
    });

    if (window.Animations && Animations.bindTilt) Animations.bindTilt(host);

    drawTopWords();
    drawFileTypes();
  }

  function topEntry(obj){
    let best = null, bestN = 0;
    if (!obj) return null;
    if (obj instanceof Map){
      for (const [k,v] of obj) if (v > bestN){ best = k; bestN = v; }
    } else {
      for (const k in obj) if (obj[k] > bestN){ best = k; bestN = obj[k]; }
    }
    return best !== null ? [best, bestN] : null;
  }

  /* ---------- top words bar chart ---------- */
  function drawTopWords(){
    const canvas = $('#chartTopWords');
    if (!canvas || !last.stats) return;
    const entries = Array.from(last.stats.freq.entries())
      .sort((a,b) => b[1] - a[1])
      .slice(0, 8);
    const { ctx, w, h } = dpr(canvas);

    ctx.clearRect(0, 0, w, h);
    if (!entries.length){
      ctx.fillStyle = 'rgba(120,150,190,.5)';
      ctx.font = '12px sans-serif';
      ctx.fillText('No data yet', 12, 24);
      return;
    }

    const max = entries[0][1] || 1;
    const rowH = Math.min(24, (h - 12) / entries.length);
    const labelW = Math.min(110, w * 0.38);
    const barX = labelW + 8;
    const barW = w - barX - 40;
    const t0 = performance.now();

    function frame(now){
      const t = Math.min(1, (now - t0) / 650);
      const e = easeOut(t);
      ctx.clearRect(0, 0, w, h);
      entries.forEach(([word, count], i) => {
        const y = 6 + i * rowH;
        const len = Math.max(2, (count / max) * barW * e);
        const grad = ctx.createLinearGradient(barX, 0, barX + len, 0);
        grad.addColorStop(0, PALETTE[i % PALETTE.length]);
        grad.addColorStop(1, 'rgba(77,163,255,.25)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(barX, y + 4, len, rowH - 8, 4) : ctx.rect(barX, y + 4, len, rowH - 8);
        ctx.fill();

        ctx.fillStyle = 'rgba(200,220,255,.85)';
        ctx.font = '600 11px -apple-system,Segoe UI,Roboto,sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(word, labelW, y + rowH - 7);
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(160,190,230,.7)';
        ctx.fillText(String(count), barX + len + 6, y + rowH - 7);
      });
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- file type donut ---------- */
  function drawFileTypes(){
    const canvas = $('#chartFileTypes');
    if (!canvas) return;
    const { ctx, w, h } = dpr(canvas);
    ctx.clearRect(0, 0, w, h);

    const groups = { PDF:0, Image:0, Document:0, Text:0, Other:0 };
    (last.files || []).forEach(f => {
      const ext = (f.ext || '').toLowerCase();
      if (ext === 'pdf') groups.PDF++;
      else if (['jpg','jpeg','png','webp','gif'].includes(ext)) groups.Image++;
      else if (['docx','xlsx','xls','pptx'].includes(ext)) groups.Document++;
      else if (['txt','csv','md','json','log','html','htm','xml'].includes(ext)) groups.Text++;
      else groups.Other++;
    });

    const entries = Object.entries(groups).filter(([,v]) => v > 0);
    if (!entries.length){
      ctx.fillStyle = 'rgba(120,150,190,.5)';
      ctx.font = '12px sans-serif';
      ctx.fillText('No files yet', 12, 24);
      return;
    }

    const total = entries.reduce((a,[,v]) => a + v, 0);
    const cx = Math.min(w * 0.5, h * 0.55);
    const cy = h / 2;
    const r = Math.min(w, h) * 0.34;
    const inner = r * 0.58;

    let a0 = -Math.PI / 2;
    const t0 = performance.now();

    function frame(now){
      const t = Math.min(1, (now - t0) / 650);
      const e = easeOut(t);
      ctx.clearRect(0, 0, w, h);

      let start = a0;
      entries.forEach(([label, value], i) => {
        const sweep = (value / total) * Math.PI * 2 * e;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, start, start + sweep);
        ctx.closePath();
        ctx.fillStyle = PALETTE[i % PALETTE.length];
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        start += sweep;
      });

      // hole
      ctx.beginPath();
      ctx.arc(cx, cy, inner, 0, Math.PI * 2);
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg-0') || '#04060d';
      ctx.fill();

      ctx.fillStyle = 'rgba(220,235,255,.9)';
      ctx.font = '800 16px -apple-system,Segoe UI,Roboto,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(total), cx, cy - 2);
      ctx.fillStyle = 'rgba(140,170,210,.8)';
      ctx.font = '600 9px -apple-system,Segoe UI,Roboto,sans-serif';
      ctx.fillText('FILES', cx, cy + 13);

      // legend
      ctx.textAlign = 'left';
      let ly = 12;
      entries.forEach(([label, value], i) => {
        ctx.fillStyle = PALETTE[i % PALETTE.length];
        ctx.fillRect(w - 92, ly, 8, 8);
        ctx.fillStyle = 'rgba(190,210,240,.85)';
        ctx.font = '600 10px -apple-system,Segoe UI,Roboto,sans-serif';
        ctx.fillText(label + ' · ' + value, w - 78, ly + 8);
        ly += 16;
      });

      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 3D word cloud ---------- */
  function renderWordCloud(entries){
    const host = $('#wordCloud3D');
    if (!host) return;
    if (!entries || !entries.length){
      host.innerHTML = '<div style="color:var(--muted);font-size:12px;">No words to visualise.</div>';
      return;
    }

    const top = entries.slice(0, 40);
    const max = top[0][1] || 1;
    const min = top[top.length - 1][1] || 1;

    host.innerHTML = top.map(([word, count], i) => {
      const ratio = max === min ? 0.6 : (count - min) / (max - min);
      const size = 13 + ratio * 30;            // 13px → 43px
      const z = Math.round(ratio * 28) - 14;   // -14 → 14
      const ry = Math.round((Math.random() - 0.5) * 22);
      const color = PALETTE[i % PALETTE.length];
      const delay = (i * 0.11).toFixed(2);
      return `<span class="wc-word" data-word="${UA.escapeHtml(word)}"
        style="font-size:${size.toFixed(1)}px;--z:${z}px;--ry:${ry}deg;--d:${delay}s;--wc-color:${color};"
        title="${UA.escapeHtml(word)} · ${count}">${UA.escapeHtml(word)}</span>`;
    }).join('');

    host.querySelectorAll('.wc-word').forEach(el => {
      el.addEventListener('click', () => {
        const w = el.dataset.word;
        const qs = $('#quickSearch');
        if (qs) qs.value = w;
        if (window.App && App.searchFromCloud) App.searchFromCloud(w);
      });
    });
  }

  /* ---------- letter donut ---------- */
  function renderLetterDonut(letterFreq){
    const canvas = $('#letterDonut');
    if (!canvas) return;
    const { ctx, w, h } = dpr(canvas);
    ctx.clearRect(0, 0, w, h);

    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const sorted = letters
      .map(l => [l, letterFreq[l] || 0])
      .filter(([,v]) => v > 0)
      .sort((a,b) => b[1] - a[1]);

    if (!sorted.length){
      ctx.fillStyle = 'rgba(120,150,190,.5)';
      ctx.font = '12px sans-serif';
      ctx.fillText('No letters yet', 12, 24);
      return;
    }

    const top = sorted.slice(0, 6);
    const rest = sorted.slice(6).reduce((a,[,v]) => a + v, 0);
    if (rest > 0) top.push(['other', rest]);

    const total = top.reduce((a,[,v]) => a + v, 0);
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.36;
    const inner = r * 0.6;

    let start = -Math.PI / 2;
    const t0 = performance.now();

    function frame(now){
      const t = Math.min(1, (now - t0) / 700);
      const e = easeOut(t);
      ctx.clearRect(0, 0, w, h);

      let s = start;
      top.forEach(([label, value], i) => {
        const sweep = (value / total) * Math.PI * 2 * e;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, s, s + sweep);
        ctx.closePath();
        ctx.fillStyle = PALETTE[i % PALETTE.length];
        ctx.globalAlpha = 0.88;
        ctx.fill();
        ctx.globalAlpha = 1;
        s += sweep;
      });

      ctx.beginPath();
      ctx.arc(cx, cy, inner, 0, Math.PI * 2);
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg-0') || '#04060d';
      ctx.fill();

      ctx.fillStyle = 'rgba(220,235,255,.92)';
      ctx.font = '800 15px -apple-system,Segoe UI,Roboto,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(total.toLocaleString(), cx, cy - 2);
      ctx.fillStyle = 'rgba(140,170,210,.8)';
      ctx.font = '600 9px -apple-system,Segoe UI,Roboto,sans-serif';
      ctx.fillText('LETTERS', cx, cy + 13);

      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function redraw(){
    if (last.stats) {
      drawTopWords();
      drawFileTypes();
    }
  }

  window.addEventListener('resize', UA.debounce(redraw, 200));

  window.Dashboard = {
    renderDashboard,
    renderWordCloud,
    renderLetterDonut,
    redraw
  };
})();