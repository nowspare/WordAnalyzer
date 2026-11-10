/* ============================================================
   Upload manager — one-line rows, real progress only
   ============================================================ */
(function(){
  'use strict';

  const WA = window.WA;
  const $ = WA.$;

  const rows = new Map(); // id -> { file, el, state }

  function strip(){ return $('#uploadStrip'); }
  function rowHost(){ return $('#uploadRows'); }

  function totalLabel(){
    let total = 0;
    let done = 0;
    rows.forEach(entry => {
      total++;
      if (entry.state === 'done' || entry.state === 'error') done++;
    });
    const el = $('#uploadTotal');
    if (el) el.textContent = done + ' of ' + total + ' completed';
    if (total === 0 && strip()) strip().classList.remove('active');
  }

  function statusText(state){
    switch(state){
      case 'reading': return 'Uploading…';
      case 'processing': return 'Processing…';
      case 'done': return 'Completed';
      case 'error': return 'Error';
      default: return 'Queued';
    }
  }

  function buildRow(file){
    const el = document.createElement('div');
    el.className = 'upload-row';
    el.dataset.id = file.id;

    const ext = (file.ext || '?').toUpperCase().slice(0, 4);

    el.innerHTML =
      '<span class="ur-icon">' + WA.escapeHtml(ext) + '</span>' +
      '<span class="ur-name" title="' + WA.escapeHtml(file.name) + '">' + WA.escapeHtml(file.name) + '</span>' +
      '<span class="ur-size">' + WA.fmtSize(file.size) + '</span>' +
      '<div class="ur-track"><div class="ur-fill"></div></div>' +
      '<span class="ur-pct">0%</span>' +
      '<span class="ur-status">Queued</span>' +
      '<button class="ur-cancel" type="button" aria-label="Remove file" title="Remove">×</button>';

    const cancel = el.querySelector('.ur-cancel');
    cancel.addEventListener('click', () => remove(file.id, true));

    return el;
  }

  function setState(entry, state, pct, phase){
    entry.state = state;
    const el = entry.el;
    if (!el) return;

    el.classList.toggle('processing', state === 'processing');
    el.classList.toggle('done', state === 'done');
    el.classList.toggle('error', state === 'error');

    const fill = el.querySelector('.ur-fill');
    const pctEl = el.querySelector('.ur-pct');
    const statusEl = el.querySelector('.ur-status');
    const cancel = el.querySelector('.ur-cancel');

    if (state === 'processing'){
      fill.style.width = '100%';
      pctEl.textContent = '··';
    } else {
      const value = Math.max(0, Math.min(100, Number(pct) || 0));
      fill.style.width = value + '%';
      pctEl.textContent = Math.round(value) + '%';
    }

    statusEl.className = 'ur-status ' + state;
    statusEl.textContent = phase || statusText(state);

    if (state === 'error'){
      cancel.textContent = '↻';
      cancel.title = 'Retry';
      cancel.setAttribute('aria-label', 'Retry');
      cancel.onclick = e => { e.stopPropagation(); retry(entry.file.id); };
    } else if (state === 'done'){
      cancel.textContent = '×';
      cancel.title = 'Remove';
      setTimeout(() => {
        if (!rows.has(entry.file.id)) return;
        el.classList.add('collapsing');
        setTimeout(() => {
          el.remove();
          rows.delete(entry.file.id);
          totalLabel();
        }, 300);
      }, 1800);
    }

    totalLabel();
  }

  function reporter(entry){
    return function(payload){
      if (!payload || entry.cancelled) return;
      if (payload.pct === null || payload.pct === undefined){
        setState(entry, 'processing', null, payload.phase || 'Processing…');
      } else {
        setState(entry, 'reading', payload.pct, payload.phase || 'Uploading…');
      }
      if (typeof payload.pct === 'number') entry.file.progress = payload.pct;
    };
  }

  async function run(entry){
    const file = entry.file;
    if (!WA.Analyzer || typeof WA.Analyzer.processFile !== 'function'){
      setState(entry, 'error', 100, 'Analyzer not ready');
      return;
    }
    setState(entry, 'reading', 0, 'Uploading…');
    try {
      await WA.Analyzer.processFile(file, reporter(entry));
      if (entry.cancelled) return;

      if (file.status === 'done') setState(entry, 'done', 100, 'Completed');
      else if (file.status === 'error') setState(entry, 'error', 100, file.error || 'Failed');
      else setState(entry, 'done', 100, 'Completed');
    } catch(err){
      if (err && err.cancelled) return;
      setState(entry, 'error', 100, (err && err.message) || 'Failed');
      WA.log('[upload] error', file.name, err);
    }
  }

  function enqueue(files){
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return;
    const host = rowHost();
    if (!host) return;
    if (strip()) strip().classList.add('active');

    list.forEach(file => {
      if (rows.has(file.id)) return;
      const el = buildRow(file);
      host.appendChild(el);
      const entry = { file, el, state: 'queued', cancelled: false };
      rows.set(file.id, entry);
      totalLabel();
      run(entry);
    });
  }

  function remove(id, dropFromState){
    const entry = rows.get(id);
    if (!entry) return;
    entry.cancelled = true;
    if (entry.el) entry.el.remove();
    rows.delete(id);
    if (dropFromState && WA.Analyzer && WA.Analyzer.state){
      const state = WA.Analyzer.state;
      state.files = state.files.filter(f => f.id !== id);
      if (state.activeId === id) state.activeId = state.files[0] ? state.files[0].id : null;
      state.selected.delete(id);
      if (typeof WA.Analyzer.refreshAll === 'function') WA.Analyzer.refreshAll();
    }
    totalLabel();
  }

  function retry(id){
    const entry = rows.get(id);
    if (!entry) return;
    entry.cancelled = false;
    entry.file.text = '';
    entry.file.status = 'pending';
    entry.file.progress = 0;
    entry.file.error = null;
    entry.file.wordCount = 0;
    entry.file.charCount = 0;
    setState(entry, 'reading', 0, 'Queued');
    run(entry);
  }

  function clearCompleted(){
    Array.from(rows.entries()).forEach(([id, entry]) => {
      if (entry.state === 'done' || entry.state === 'error') remove(id, false);
    });
  }

  WA.Upload = { enqueue, remove, retry, clearCompleted };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('#uploadClear');
    if (btn) btn.addEventListener('click', clearCompleted);
  });
})();