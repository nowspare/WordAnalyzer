/* ============================================================
   Core — utilities, log, toast, modal, prefs, text decoding
   ============================================================ */
(function(){
  'use strict';

  const WA = window.WA = window.WA || {};

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const uid = () => Math.random().toString(36).slice(2, 10);

  const fmtSize = bytes => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  };

  const extOf = name => {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
  };

  const escapeHtml = str => String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  const escapeRegex = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const debounce = (fn, ms = 220) => {
    let t;
    return function(...args){
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  const rafThrottle = fn => {
    let queued = false;
    return function(...args){
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn.apply(this, args); });
    };
  };

  /* ---------- visible debug log ---------- */
  const logLines = [];
  const MAX_LOG = 200;

  function log(...args){
    console.log(...args);
    const line = args.map(a => {
      if (a instanceof Error) return 'ERR: ' + a.message;
      if (typeof a === 'object'){
        try { return JSON.stringify(a); } catch(e){ return String(a); }
      }
      return String(a);
    }).join(' ');
    logLines.push(line);
    if (logLines.length > MAX_LOG) logLines.shift();
    const el = $('#debugLog');
    if (el){
      el.textContent = logLines.join('\n');
      el.scrollTop = el.scrollHeight;
    }
  }

  /* ---------- toast ---------- */
  function toast(message, kind = ''){
    log('[toast]', kind, message);
    const host = $('#toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 2950);
  }

  /* ---------- confirm modal ---------- */
  function confirmModal(title, text){
    return new Promise(resolve => {
      const backdrop = $('#confirmBackdrop');
      const okBtn = $('#confirmOk');
      const cancelBtn = $('#confirmCancel');
      if (!backdrop || !okBtn || !cancelBtn) {
        resolve(window.confirm(title + '\n\n' + text));
        return;
      }
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      backdrop.classList.remove('hidden');

      const cleanup = () => {
        backdrop.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onBackdrop);
      };
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const onBackdrop = e => { if (e.target === backdrop) onCancel(); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onBackdrop);
    });
  }

  /* ---------- prefs ---------- */
  const Prefs = {
    get(key, fallback){
      try {
        const raw = localStorage.getItem('wa_' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch(e){ return fallback; }
    },
    set(key, value){
      try { localStorage.setItem('wa_' + key, JSON.stringify(value)); } catch(e){}
    },
    remove(key){
      try { localStorage.removeItem('wa_' + key); } catch(e){}
    }
  };

  /* ---------- download ---------- */
  function download(filename, content, mime = 'text/plain'){
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 700);
  }

  function csvEscape(value){
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(rows){
    return rows.map(row => row.map(csvEscape).join(',')).join('\n');
  }

  /* ============================================================
     TEXT DECODING — the TXT upload fix
     Reads a Blob as ArrayBuffer with real progress, then decodes
     with TextDecoder. Handles UTF-8 (with or without BOM),
     UTF-16LE/BE, and strips any remaining BOM.
     ============================================================ */
  function readBlob(blob, mode, onProgress){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      if (typeof onProgress === 'function'){
        reader.onprogress = e => {
          if (e.lengthComputable) {
            try { onProgress(e.loaded / e.total); } catch(err){ log('[progress]', err); }
          }
        };
      }
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('File read failed'));
      reader.onabort = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));

      if (mode === 'text') reader.readAsText(blob, 'utf-8');
      else reader.readAsArrayBuffer(blob);
    });
  }

  function decodeTextBuffer(buffer){
    let bytes;
    if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
    else if (ArrayBuffer.isView(buffer)) bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    else bytes = new Uint8Array(buffer);

    let encoding = 'utf-8';
    if (bytes.length >= 2){
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = 'utf-16le';
      else if (bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = 'utf-16be';
    }

    let text;
    try {
      const decoder = new TextDecoder(encoding, { fatal: false });
      text = decoder.decode(bytes);
    } catch(e){
      log('[decode] TextDecoder failed, falling back to UTF-8', e);
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }

    // Safety net — strip a leading BOM if the decoder left one
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return text;
  }

  async function readTextFile(file, onProgress){
    const buffer = await readBlob(file, 'buffer', onProgress);
    return decodeTextBuffer(buffer);
  }

  /* ---------- reverse helpers (grapheme-aware) ---------- */
  let segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter){
      segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    }
  } catch(e){ /* older browser */ }

  function reverseText(str){
    if (!str) return '';
    if (segmenter){
      return [...segmenter.segment(str)].map(s => s.segment).reverse().join('');
    }
    return Array.from(str).reverse().join('');
  }

  function reverseWordOrder(str){
    if (!str) return '';
    // Keep the whitespace slots in place, reverse only the non-space tokens.
    const parts = str.split(/(\s+)/);
    const wordIdx = [];
    parts.forEach((p, i) => { if (p && !/^\s+$/.test(p)) wordIdx.push(i); });
    const words = wordIdx.map(i => parts[i]).reverse();
    wordIdx.forEach((idx, k) => { parts[idx] = words[k]; });
    return parts.join('');
  }

  /* ---------- text detection ---------- */
  const TEXT_EXTENSIONS = new Set(['txt','csv','md','markdown','json','log','html','htm','xml','yaml','yml','ini','cfg','conf','tsv']);
  const TEXT_MIME_PREFIXES = ['text/'];

  function isTextFile(file){
    const ext = extOf(file.name || '');
    if (TEXT_EXTENSIONS.has(ext)) return true;
    const type = (file.type || '').toLowerCase();
    if (!type) return false;
    if (TEXT_MIME_PREFIXES.some(p => type.startsWith(p))) return true;
    return type === 'application/json' || type === 'application/xml';
  }

  WA.$ = $;
  WA.$$ = $$;
  WA.uid = uid;
  WA.fmtSize = fmtSize;
  WA.extOf = extOf;
  WA.escapeHtml = escapeHtml;
  WA.escapeRegex = escapeRegex;
  WA.debounce = debounce;
  WA.rafThrottle = rafThrottle;
  WA.log = log;
  WA.toast = toast;
  WA.confirmModal = confirmModal;
  WA.Prefs = Prefs;
  WA.download = download;
  WA.csvEscape = csvEscape;
  WA.toCSV = toCSV;
  WA.readBlob = readBlob;
  WA.decodeTextBuffer = decodeTextBuffer;
  WA.readTextFile = readTextFile;
  WA.reverseText = reverseText;
  WA.reverseWordOrder = reverseWordOrder;
  WA.isTextFile = isTextFile;
  WA.TEXT_EXTENSIONS = TEXT_EXTENSIONS;
})();