/* ============================================================
   Shared utilities, visible log, toast, modal, downloads
   ============================================================ */
(function(){
  'use strict';

  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const uid = () => Math.random().toString(36).slice(2, 10);
  const fmtSize = b => b < 1024 ? b + ' B'
    : b < 1048576 ? (b/1024).toFixed(1) + ' KB'
    : (b/1048576).toFixed(2) + ' MB';
  const extOf = name => (name.split('.').pop() || '').toLowerCase();

  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
  const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const debounce = (fn, ms = 250) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const rafThrottle = fn => {
    let queued = false;
    return (...a) => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn(...a); });
    };
  };

  /* ---------- Visible debug log ---------- */
  const debugLines = [];
  const MAX_LOG = 200;
  function AppLog(...args){
    console.log(...args);
    const msg = args.map(a => {
      if (a instanceof Error) return 'ERR: ' + a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch(e){ return String(a); }
      }
      return String(a);
    }).join(' ');
    debugLines.push(msg);
    if (debugLines.length > MAX_LOG) debugLines.shift();
    const el = document.getElementById('debugLog');
    if (el){
      el.textContent = debugLines.join('\n');
      el.scrollTop = el.scrollHeight;
    }
  }

  /* ---------- Toast ---------- */
  function toast(msg, kind = ''){
    AppLog('[toast]', kind, msg);
    const host = document.getElementById('toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.classList.add('is-out'), 2400);
    setTimeout(() => el.remove(), 2750);
  }

  /* ---------- Confirm modal ---------- */
  function confirmModal(title, text){
    return new Promise(resolve => {
      const backdrop = document.getElementById('modalBackdrop');
      const okBtn = document.getElementById('modalOk');
      const cancelBtn = document.getElementById('modalCancel');
      if (!backdrop) { resolve(window.confirm(title + '\n\n' + text)); return; }
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalText').textContent = text;
      backdrop.classList.remove('hidden');

      const cleanup = () => {
        backdrop.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
      };
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
    });
  }

  /* ---------- Download ---------- */
  function download(filename, content, mime = 'text/plain'){
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 600);
  }
  function csvEscape(v){
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows){ return rows.map(r => r.map(csvEscape).join(',')).join('\n'); }

  /* ---------- Prefs ---------- */
  const Prefs = {
    get(key, fallback){
      try {
        const v = localStorage.getItem('wa_' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch(e){ return fallback; }
    },
    set(key, value){
      try { localStorage.setItem('wa_' + key, JSON.stringify(value)); } catch(e){}
    }
  };

  /* ---------- Progress-aware reader ---------- */
  function readFile(file, mode, onProgress){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      if (typeof onProgress === 'function'){
        reader.onprogress = e => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('File read failed'));
      reader.onabort  = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (mode === 'text') reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
    });
  }

  window.UA = {
    $, $$, uid, fmtSize, extOf, escapeHtml, escapeRegex,
    debounce, rafThrottle, AppLog, toast, confirmModal,
    download, csvEscape, toCSV, Prefs, readFile
  };
})();
