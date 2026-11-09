/* ============================================================
   Upload manager — one-line real progress per file
   Progress sources:
     · FileReader onprogress  → real reading %
     · PDF page count         → real extraction %
     · Tesseract logger       → real OCR %
     · Parse phases with no native events → indeterminate shimmer
   No synthetic percentages.
   ============================================================ */
(function(){
  'use strict';

  const UA = window.UA;
  const $  = UA.$;

  const items = new Map(); // id -> { file, row, state }

  function root(){ return $('#uploadRows'); }
  function strip(){ return $('#uploadStrip'); }

  function statusLabel(state){
    switch(state){
      case 'reading':    return 'Uploading…';
      case 'processing': return 'Processing…';
      case 'done':       return 'Completed';
      case 'error':      return 'Error';
      default:           return 'Queued';
    }
  }

  function buildRow(file){
    const el = document.createElement('div');
    el.className = 'upload-row';
    el.dataset.id = file.id;
    el.innerHTML = `
      <span class="ur-icon">${UA.escapeHtml((file.ext || '?').toUpperCase().slice(0,4))}</span>
      <span class="ur-name" title="${UA.escapeHtml(file.name)}">${UA.escapeHtml(file.name)}</span>
      <span class="ur-size">${UA.fmtSize(file.size)}</span>
      <div class="ur-track"><div class="ur-fill"></div></div>
      <span class="ur-pct">0%</span>
      <span class="ur-status reading">Queued</span>
      <button class="ur-cancel" type="button" title="Cancel">×</button>
    `;
    el.querySelector('.ur-cancel').addEventListener('click', () => cancel(file.id));
    return el;
  }

  function ensureStrip(){
    const s = strip();
    if (s) s.classList.add('active');
  }

  function updateTotal(){
    let done = 0, total = 0;
    items.forEach(it => {
      total++;
      if (it.state === 'done' || it.state === 'error') done++;
    });
    const el = $('#uploadTotal');
    if (el) el.textContent = `${done} of ${total} completed`;
    if (total === 0){
      const s = strip();
      if (s) s.classList.remove('active');
    }
  }

  function setState(it, state, pct, phase){
    it.state = state;
    const row = it.row;
    if (!row) return;

    row.classList.toggle('is-processing', state === 'processing');
    row.classList.toggle('is-done', state === 'done');
    row.classList.toggle('is-error', state === 'error');

    const fill = row.querySelector('.ur-fill');
    const pctEl = row.querySelector('.ur-pct');
    const stEl = row.querySelector('.ur-status');
    const cancelBtn = row.querySelector('.ur-cancel');

    if (state === 'processing'){
      // Indeterminate — never show a fake number
      pctEl.textContent = '··';
      fill.style.width = '100%';
    } else {
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      fill.style.width = p + '%';
      pctEl.textContent = Math.round(p) + '%';
    }

    stEl.className = 'ur-status ' + state;
    stEl.textContent = phase || statusLabel(state);

    if (state === 'done' || state === 'error'){
      cancelBtn.textContent = state === 'error' ? '↻' : '×';
      cancelBtn.title = state === 'error' ? 'Retry' : 'Remove';
      if (state === 'error'){
        cancelBtn.onclick = (e) => { e.stopPropagation(); retry(it.file.id); };
      }
    }

    if (state === 'done'){
      // Collapse after a short confirmation window
      setTimeout(() => {
        if (!items.has(it.file.id)) return;
        row.classList.add('is-collapsing');
        setTimeout(() => {
          row.remove();
          items.delete(it.file.id);
          updateTotal();
        }, 320);
      }, 2200);
    }

    updateTotal();
  }

  function reportFor(it){
    return ({ pct, phase }) => {
      if (it.cancelled) return;
      if (pct === null || pct === undefined){
        setState(it, 'processing', null, phase || 'Processing…');
      } else {
        setState(it, 'reading', pct, phase || 'Uploading…');
      }
      // keep sidebar in sync
      it.file.progress = (pct === null || pct === undefined) ? it.file.progress : pct;
    };
  }

  async function run(it){
    if (!window.App || typeof App.processFile !== 'function'){
      setState(it, 'error', 100, 'App not ready');
      return;
    }
    const file = it.file;
    setState(it, 'reading', 0, 'Uploading…');

    try {
      await App.processFile(file, reportFor(it));
      if (it.cancelled){
        removeItem(it.file.id, false);
        return;
      }
      if (file.status === 'done'){
        setState(it, 'done', 100, 'Completed');
      } else if (file.status === 'error'){
        setState(it, 'error', 100, file.error || 'Failed');
        if (UA.AppLog) UA.AppLog('[upload] failed:', file.name, file.error);
      } else {
        setState(it, 'done', 100, 'Completed');
      }
    } catch(err){
      if (err && err.cancelled){
        removeItem(file.id, false);
        return;
      }
      setState(it, 'error', 100, (err && err.message) || 'Failed');
      if (UA.AppLog) UA.AppLog('[upload] error:', file.name, err);
    }
  }

  function removeItem(id, dropFromState){
    const it = items.get(id);
    if (!it) return;
    if (it.row) it.row.remove();
    items.delete(id);
    if (dropFromState && window.App && App.state){
      App.state.files = App.state.files.filter(f => f.id !== id);
      if (App.state.activeId === id){
        App.state.activeId = App.state.files[0] ? App.state.files[0].id : null;
      }
      if (typeof App.refreshAll === 'function') App.refreshAll();
    }
    updateTotal();
  }

  function cancel(id){
    const it = items.get(id);
    if (!it) return;
    it.cancelled = true;
    removeItem(id, true);
    UA.toast('Removed ' + it.file.name);
  }

  function retry(id){
    const it = items.get(id);
    if (!it) return;
    it.cancelled = false;
    it.file.text = '';
    it.file.status = 'pending';
    it.file.progress = 0;
    it.file.error = null;
    it.file.wordCount = 0;
    it.file.charCount = 0;
    setState(it, 'reading', 0, 'Queued');
    run(it);
  }

  function enqueue(files){
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return;
    ensureStrip();
    const rows = root();
    if (!rows) return;

    list.forEach(file => {
      if (items.has(file.id)) return;
      const row = buildRow(file);
      rows.appendChild(row);
      const it = { file, row, state: 'queued', cancelled: false };
      items.set(file.id, it);
      updateTotal();
      run(it);
    });
  }

  function clearCompleted(){
    items.forEach((it, id) => {
      if (it.state === 'done' || it.state === 'error') removeItem(id, false);
    });
  }

  function bind(){
    const btn = $('#uploadClear');
    if (btn) btn.addEventListener('click', clearCompleted);
  }

  window.UploadManager = { enqueue, cancel, retry, clearCompleted };

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bind);
  } else bind();
})();
