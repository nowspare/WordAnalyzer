/* ============================================================
   WordAnalyzer — application core
   All extraction, search, replace, editor, stats, exports.
   Original behaviour preserved; progress callbacks added.
   ============================================================ */
(function(){
  'use strict';

  const {
    $, $$, uid, fmtSize, extOf, escapeHtml, escapeRegex,
    debounce, rafThrottle, AppLog, toast, confirmModal,
    download, csvEscape, toCSV, readFile
  } = window.UA;

  if (typeof pdfjsLib !== 'undefined'){
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  /* ============================================================
     STATE
     ============================================================ */
  const state = {
    files: [],
    activeId: null,
    selected: new Set(),
    scope: 'current',
    view: 'editor',
    filter: 'all',
    theme: 'dark',
    results: [],
    resultIndex: -1,
    lastSearch: '',
    replaceStack: [],
    editorUndo: [],
    editorRedo: [],
    wrap: false,
    showLines: true,
    highlightAll: true
  };

  const COMMON_WORDS = new Set(('the a an is are was were be been being of to and or in on at for with as by from ' +
    'that this these those it its i you he she we they them their there here ' +
    'what which who whom whose when where why how not no nor so if then than too very ' +
    'can could should would may might must will shall do does did done have has had ' +
    'having but also just only more most some any all each every both few many much ' +
    'other another such own same').split(/\s+/));

  /* ============================================================
     COUNTING — ASCII-safe, never silent
     ============================================================ */
  function countWords(text){
    if (!text) return 0;
    const trimmed = String(text).trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(t => /[a-zA-Z0-9]/.test(t)).length;
  }
  function countLetters(text){
    if (!text) return 0;
    const m = String(text).match(/[a-zA-Z]/g);
    return m ? m.length : 0;
  }
  function countSentences(text){
    if (!text) return 0;
    const t = String(text).trim();
    if (!t) return 0;
    const m = t.match(/[^.!?\n]+[.!?]+/g);
    if (m && m.length) return m.length;
    return t.split('\n').filter(l => l.trim().length > 0).length;
  }

  /* ============================================================
     FILE HANDLING
     ============================================================ */
  const ACCEPTED = ['pdf','jpg','jpeg','png','webp','gif','txt','csv','docx','xlsx','xls','pptx','md','json','log','html','htm','xml'];

  function fileKind(f){
    if (f.ext === 'pdf') return 'pdf';
    if (['jpg','jpeg','png','webp','gif'].includes(f.ext)) return 'image';
    if (['docx','xlsx','xls','pptx'].includes(f.ext)) return 'doc';
    if (['txt','csv','md','json','log','html','htm','xml'].includes(f.ext)) return 'text';
    return 'other';
  }

  function activeFile(){ return state.files.find(f => f.id === state.activeId) || null; }

  function filesInScope(scope = state.scope){
    if (scope === 'current'){
      const a = activeFile();
      return a ? [a] : [];
    }
    if (scope === 'selected'){
      return state.files.filter(f => state.selected.has(f.id));
    }
    return state.files.filter(f => f.text && f.text.length > 0);
  }

  function addFiles(fileList){
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    AppLog('=== ADD FILES ===', incoming.length, 'file(s)');

    const added = [];
    for (const raw of incoming){
      const ext = extOf(raw.name);
      const ok = ACCEPTED.includes(ext);
      const obj = {
        id: uid(),
        raw,
        name: raw.name,
        ext,
        size: raw.size,
        status: ok ? 'pending' : 'error',
        error: ok ? null : 'Unsupported file type',
        text: '',
        pages: null,
        ocrConfidence: null,
        progress: 0,
        wordCount: 0,
        charCount: 0
      };
      state.files.push(obj);
      if (ok) added.push(obj);
      AppLog('  queued:', raw.name, '(' + ext + ')', ok ? 'OK' : 'UNSUPPORTED');
    }

    if (!state.activeId && state.files.length){
      state.activeId = state.files[0].id;
      AppLog('  active file set:', state.files[0].name);
    }

    renderFileList();
    updateCounts();
    updateCenterVisibility();
    renderEditor();
    refreshViews();

    if (window.UploadManager && added.length){
      UploadManager.enqueue(added);
    } else {
      setTimeout(processAll, 0);
    }
  }

  /* ============================================================
     PROCESSING
     ============================================================ */
  let processing = false;
  async function processAll(){
    if (processing) return;
    processing = true;
    try {
      const snapshot = state.files.slice();
      for (const f of snapshot){
        if (!state.files.includes(f)) continue;
        if (f.status === 'pending' || (f.status === 'error' && ACCEPTED.includes(f.ext) && !f.text)){
          if (window.UploadManager) UploadManager.enqueue([f]);
          else await processFile(f);
        }
      }
    } finally {
      processing = false;
    }
  }

  const scheduleFileListRender = rafThrottle(() => renderFileList());

  async function processFile(f, report){
    report = typeof report === 'function' ? report : function(){};
    AppLog('>> processFile START:', f.name, '(' + f.ext + ')');
    f.status = 'processing';
    f.error = null;
    f.progress = 0;
    scheduleFileListRender();

    try {
      let text = '';
      const kind = fileKind(f);

      if (f.ext === 'pdf'){
        if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js not loaded');
        text = await extractPDF(f, report);
      } else if (kind === 'image'){
        if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js not loaded');
        text = await extractImage(f, report);
      } else if (f.ext === 'docx'){
        if (typeof mammoth === 'undefined') throw new Error('mammoth.js not loaded');
        text = await extractDOCX(f, report);
      } else if (['xlsx','xls'].includes(f.ext)){
        if (typeof XLSX === 'undefined') throw new Error('SheetJS not loaded');
        text = await extractXLSX(f, report);
      } else if (f.ext === 'pptx'){
        if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');
        text = await extractPPTX(f, report);
      } else {
        text = await extractPlain(f, report);
      }

      if (f.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });

      AppLog('   extracted length:', text.length, 'chars');
      f.text = text || '';
      f.wordCount = countWords(f.text);
      f.charCount = f.text.length;

      if (!f.text.trim()){
        f.status = 'error';
        f.error = f.ext === 'pdf' ? 'No selectable text (image-only PDF)'
          : kind === 'image' ? 'No text detected by OCR'
          : 'No readable text found';
        AppLog('   EMPTY TEXT -> error:', f.error);
      } else {
        f.status = 'done';
        AppLog('   STATUS: DONE', f.wordCount, 'words');
      }
    } catch (err){
      if (err && err.cancelled){
        f.status = 'error';
        f.error = 'Cancelled';
        throw err;
      }
      f.status = 'error';
      f.error = (err && err.message) ? err.message : 'Processing failed';
      AppLog('   ERROR:', f.error);
      toast('Failed: ' + f.name + ' — ' + f.error, 'err');
    }

    f.progress = 100;
    renderFileList();
    updateCounts();
    updateCenterVisibility();
    if (state.activeId === f.id) renderEditor();
    refreshViews();
    AppLog('<< processFile END:', f.name, 'status:', f.status);
  }

  /* ============================================================
     EXTRACTORS — all accept a report({pct, phase}) callback
     pct === null means indeterminate (no fake numbers)
     ============================================================ */
  async function extractPlain(f, report){
    const t = await readFile(f.raw, 'text', p => {
      report({ pct: Math.round(p * 100), phase: 'Uploading…' });
    });
    AppLog('   extractPlain ->', t.length, 'chars');
    return t;
  }

  async function extractDOCX(f, report){
    const buf = await readFile(f.raw, 'buffer', p => {
      report({ pct: Math.round(p * 60), phase: 'Uploading…' });
    });
    report({ pct: null, phase: 'Extracting…' });
    const res = await mammoth.extractRawText({ arrayBuffer: buf });
    const t = res.value || '';
    AppLog('   extractDOCX ->', t.length, 'chars');
    return t;
  }

  async function extractXLSX(f, report){
    const buf = await readFile(f.raw, 'buffer', p => {
      report({ pct: Math.round(p * 60), phase: 'Uploading…' });
    });
    report({ pct: null, phase: 'Parsing sheets…' });
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const out = [];
    wb.SheetNames.forEach(name => {
      out.push('=== Sheet: ' + name + ' ===');
      out.push(XLSX.utils.sheet_to_csv(wb.Sheets[name]));
    });
    const t = out.join('\n');
    AppLog('   extractXLSX ->', t.length, 'chars from', wb.SheetNames.length, 'sheets');
    return t;
  }

  async function extractPPTX(f, report){
    const buf = await readFile(f.raw, 'buffer', p => {
      report({ pct: Math.round(p * 40), phase: 'Uploading…' });
    });
    report({ pct: null, phase: 'Opening slides…' });
    const zip = await JSZip.loadAsync(buf);
    const slideNames = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a,b) => {
        const na = +a.match(/slide(\d+)/)[1];
        const nb = +b.match(/slide(\d+)/)[1];
        return na - nb;
      });
    if (!slideNames.length) throw new Error('No slides found');

    const parts = [];
    for (let i = 0; i < slideNames.length; i++){
      if (f.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const xml = await zip.files[slideNames[i]].async('string');
      const texts = [];
      const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
      let m;
      while ((m = re.exec(xml))){
        texts.push(m[1]
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#39;/g,"'"));
      }
      parts.push('--- Slide ' + (i+1) + ' ---\n' + texts.join('\n'));
      report({ pct: 40 + Math.round(((i + 1) / slideNames.length) * 60), phase: 'Extracting…' });
    }
    const t = parts.join('\n\n');
    AppLog('   extractPPTX ->', t.length, 'chars from', slideNames.length, 'slides');
    return t;
  }

  async function extractPDF(f, report){
    const buf = await readFile(f.raw, 'buffer', p => {
      report({ pct: Math.round(p * 40), phase: 'Uploading…' });
    });
    report({ pct: null, phase: 'Opening PDF…' });

    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    } catch(e){
      if (/password/i.test(e.message || '')) throw new Error('Password-protected PDF');
      throw new Error('Corrupt PDF: ' + (e.message || 'unknown'));
    }

    f.pages = pdf.numPages;
    AppLog('   extractPDF pages:', pdf.numPages);

    const pageTexts = [];
    let emptyPages = 0;

    for (let p = 1; p <= pdf.numPages; p++){
      if (f.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const text = content.items.map(it => it.str).join(' ').replace(/\s+/g,' ').trim();
      if (text) pageTexts.push('[Page ' + p + ']\n' + text);
      else { emptyPages++; pageTexts.push('[Page ' + p + ']\n[no selectable text]'); }
      const pct = 40 + Math.round((p / pdf.numPages) * 60);
      f.progress = pct;
      report({ pct, phase: 'Extracting page ' + p + '/' + pdf.numPages });
      scheduleFileListRender();
    }

    AppLog('   extractPDF empty pages:', emptyPages, '/', pdf.numPages);

    if (emptyPages === pdf.numPages && typeof Tesseract !== 'undefined'){
      toast('Scanned PDF — running OCR…');
      report({ pct: null, phase: 'OCR…' });
      const ocrTexts = [];
      for (let p = 1; p <= pdf.numPages; p++){
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 1.6 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

        const { data } = await Tesseract.recognize(canvas, 'eng', {
          logger: m => {
            if (m.status === 'recognizing text'){
              const pct = 40 + Math.round(((p - 1 + m.progress) / pdf.numPages) * 60);
              f.progress = pct;
              report({ pct, phase: 'OCR page ' + p + '/' + pdf.numPages });
              scheduleFileListRender();
            }
          }
        });
        ocrTexts.push('[Page ' + p + ' — OCR]\n' + data.text.trim());
        if (f.ocrConfidence === null) f.ocrConfidence = data.confidence;
      }
      return ocrTexts.join('\n\n');
    }

    return pageTexts.join('\n\n');
  }

  async function extractImage(f, report){
    const buf = await readFile(f.raw, 'buffer', p => {
      report({ pct: Math.round(p * 30), phase: 'Uploading…' });
    });
    report({ pct: null, phase: 'Decoding image…' });

    const blob = new Blob([buf], { type: f.raw.type || 'image/*' });
    const url = URL.createObjectURL(blob);

    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Could not decode image'));
      i.src = url;
    });

    const canvas = document.createElement('canvas');
    const maxDim = 2200;
    let w = img.width, h = img.height;
    if (Math.max(w,h) > maxDim){
      const s = maxDim / Math.max(w,h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);

    const { data } = await Tesseract.recognize(canvas, 'eng', {
      logger: m => {
        if (m.status === 'recognizing text'){
          const pct = 30 + Math.round(m.progress * 70);
          f.progress = pct;
          report({ pct, phase: 'OCR…' });
          scheduleFileListRender();
        }
      }
    });
    f.ocrConfidence = data.confidence;
    AppLog('   extractImage OCR confidence:', data.confidence, 'length:', (data.text || '').length);
    return (data.text || '').trim();
  }

  /* ============================================================
     RENDER — FILE LIST
     ============================================================ */
  function renderFileList(){
    const list = $('#fileList');
    if (!list) return;
    const visible = state.files.filter(f => state.filter === 'all' || fileKind(f) === state.filter);

    list.innerHTML = visible.map(f => {
      const st = { pending:'Pending', processing:'Processing…', done:'Done', error:'Error' }[f.status] || f.status;
      return `
        <li class="file-item ${state.activeId === f.id ? 'active' : ''} ${state.selected.has(f.id) ? 'selected' : ''}" data-id="${f.id}">
          <div class="file-name">${escapeHtml(f.name)}</div>
          <div class="file-meta">
            <span>${(f.ext || '?').toUpperCase()}</span>
            <span>${fmtSize(f.size)}</span>
            <span><strong>${f.wordCount}</strong> words</span>
            <span>${f.charCount} chars</span>
          </div>
          <div class="file-status status-${f.status}">${st}${f.ocrConfidence != null ? ' · OCR ' + Math.round(f.ocrConfidence) + '%' : ''}${f.error ? ' · ' + escapeHtml(f.error) : ''}</div>
          ${f.status === 'processing' ? `<div class="file-progress"><span style="width:${f.progress || 0}%"></span></div>` : ''}
          <div class="file-actions">
            <button data-act="process">Reprocess</button>
            <button data-act="remove">Remove</button>
          </div>
        </li>`;
    }).join('') || '<li style="font-size:12px;color:var(--muted);padding:8px;">No files.</li>';

    list.querySelectorAll('.file-item').forEach(li => {
      const id = li.dataset.id;
      li.addEventListener('click', e => {
        if (e.target.closest('.file-actions')) return;
        if (e.ctrlKey || e.metaKey){
          state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
        } else {
          state.activeId = id;
        }
        renderFileList();
        renderEditor();
        refreshViews();
      });

      li.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', async e => {
          e.stopPropagation();
          const f = state.files.find(x => x.id === id);
          if (!f) return;

          if (btn.dataset.act === 'remove'){
            state.files = state.files.filter(x => x.id !== id);
            state.selected.delete(id);
            if (state.activeId === id) state.activeId = state.files[0] ? state.files[0].id : null;
            renderFileList();
            renderEditor();
            refreshViews();
            updateCounts();
            updateCenterVisibility();
            return;
          }

          f.text = '';
          f.status = 'pending';
          f.progress = 0;
          f.error = null;
          f.ocrConfidence = null;
          f.wordCount = 0;
          f.charCount = 0;
          renderFileList();

          if (window.UploadManager) UploadManager.enqueue([f]);
          else await processFile(f);
        });
      });
    });

    const allChecked = state.files.length > 0 && state.files.every(f => state.selected.has(f.id));
    const selAll = $('#selectAllFiles');
    if (selAll) selAll.checked = allChecked;
  }

  function updateCounts(){
    const c = { all: state.files.length, pdf:0, image:0, doc:0, text:0 };
    state.files.forEach(f => { const k = fileKind(f); if (k in c) c[k]++; });
    Object.keys(c).forEach(k => {
      const el = document.querySelector('[data-count="' + k + '"]');
      if (el) el.textContent = c[k];
    });
  }

  function updateCenterVisibility(){
    const hasFiles = state.files.length > 0;
    const dz = $('#dropZone');
    const vc = $('#viewsContainer');
    const cp = $('#centerPane');
    if (dz) dz.classList.toggle('hidden', hasFiles);
    if (vc) vc.classList.toggle('hidden', !hasFiles);
    if (cp) cp.classList.toggle('no-files', !hasFiles);
  }

  /* ============================================================
     EDITOR
     ============================================================ */
  function renderEditor(){
    const f = activeFile();
    const ta = $('#editor');
    if (!ta) return;
    if (!f){
      ta.value = '';
      const hl = $('#highlightLayer'); if (hl) hl.innerHTML = '';
      const ln = $('#lineNumbersInner'); if (ln) ln.textContent = '';
      return;
    }
    ta.value = f.text || '';
    renderHighlight(ta.value);
    renderLineNumbers(ta.value);
    if (state.highlightAll && state.lastSearch) highlightInLayer();
    syncEditorScroll();
  }

  function renderLineNumbers(text){
    const ln = $('#lineNumbers');
    if (!ln) return;
    if (!state.showLines){ ln.classList.add('hidden'); return; }
    ln.classList.remove('hidden');
    const count = (text.match(/\n/g) || []).length + 1;
    const parts = [];
    for (let i = 1; i <= count; i++) parts.push(i);
    const inner = $('#lineNumbersInner');
    if (inner) inner.textContent = parts.join('\n');
  }

  function renderHighlight(text){
    const layer = $('#highlightLayer');
    if (!layer) return;
    if (text.length > 400000){ layer.textContent = text; return; }
    layer.innerHTML = escapeHtml(text);
  }

  function buildSearchRegex(query, caseSensitive, wholeWord, useRegex){
    if (!query) return null;
    let src = useRegex ? query : escapeRegex(query);
    if (wholeWord && !useRegex) src = '\\b(?:' + src + ')\\b';
    const flags = 'g' + (caseSensitive ? '' : 'i');
    try { return new RegExp(src, flags); } catch(e){ return null; }
  }

  function highlightInLayer(){
    const f = activeFile();
    if (!f) return;
    const q = state.lastSearch;
    const layer = $('#highlightLayer');
    if (!layer) return;
    const text = f.text || '';
    if (!q){ renderHighlight(text); return; }
    const re = buildSearchRegex(q, false, false, false);
    if (!re) return;
    if (text.length > 400000){ layer.textContent = text; return; }

    let html = '', last = 0, i = 0, m;
    while ((m = re.exec(text)) !== null){
      if (m.index === re.lastIndex) re.lastIndex++;
      html += escapeHtml(text.slice(last, m.index));
      const cls = (i === state.resultIndex) ? 'hl active' : 'hl';
      html += '<mark class="' + cls + '">' + escapeHtml(m[0]) + '</mark>';
      last = m.index + m[0].length;
      i++;
      if (i > 5000) break;
    }
    html += escapeHtml(text.slice(last));
    layer.innerHTML = html;
  }

  function syncEditorScroll(){
    const ta = $('#editor');
    const layer = $('#highlightLayer');
    const lnInner = $('#lineNumbersInner');
    if (!ta || !layer || !lnInner) return;
    layer.style.transform = 'translate(' + (-ta.scrollLeft) + 'px, ' + (-ta.scrollTop) + 'px)';
    lnInner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
  }

  function bindEditor(){
    const ta = $('#editor');
    if (!ta) return;

    ta.addEventListener('input', debounce(() => {
      const f = activeFile();
      if (!f) return;
      state.editorUndo.push(f.text);
      if (state.editorUndo.length > 200) state.editorUndo.shift();
      state.editorRedo.length = 0;
      f.text = ta.value;
      f.wordCount = countWords(f.text);
      f.charCount = f.text.length;
      renderLineNumbers(f.text);
      if (state.highlightAll && state.lastSearch) highlightInLayer();
      else renderHighlight(f.text);
      syncEditorScroll();
      updateCounts();
      refreshStatsOnly();
      scheduleFileListRender();
    }, 180));

    ta.addEventListener('scroll', syncEditorScroll);

    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab'){
        e.preventDefault();
        const s = ta.selectionStart;
        const en = ta.selectionEnd;
        ta.setRangeText('  ', s, en, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });

    window.addEventListener('resize', syncEditorScroll);
  }

  /* ============================================================
     SEARCH
     ============================================================ */
  function performSearch(query, opts){
    opts = opts || {};
    const caseSensitive = !!opts.caseSensitive;
    const wholeWord = !!opts.wholeWord;
    const useRegex = !!opts.useRegex;
    const scope = opts.scope || state.scope;

    state.lastSearch = query;
    state.results = [];
    state.resultIndex = -1;

    if (!query){
      renderResults();
      highlightInLayer();
      syncResultUI();
      return;
    }

    const targets = filesInScope(scope);
    for (const f of targets){
      const text = f.text || '';
      if (!text) continue;
      const re = buildSearchRegex(query, caseSensitive, wholeWord, useRegex);
      if (!re){ toast('Invalid regular expression', 'err'); return; }
      let m;
      while ((m = re.exec(text)) !== null){
        if (m.index === re.lastIndex) re.lastIndex++;
        const start = Math.max(0, m.index - 60);
        const end = Math.min(text.length, m.index + m[0].length + 60);
        let loc = 'Line ' + (text.slice(0, m.index).split('\n').length);
        const pm = text.slice(0, m.index).match(/\[Page (\d+)/g);
        if (pm && pm.length) loc = 'Page ' + pm[pm.length - 1].match(/\d+/)[0];
        state.results.push({
          fileId: f.id,
          fileName: f.name,
          loc,
          match: m[0],
          before: text.slice(start, m.index),
          after: text.slice(m.index + m[0].length, end),
          index: m.index,
          globalIndex: state.results.length
        });
        if (state.results.length > 5000) break;
      }
      if (state.results.length > 5000) break;
    }

    if (state.results.length) state.resultIndex = 0;
    AppLog('search:', query, '->', state.results.length, 'matches');
    renderResults();
    highlightInLayer();
    syncResultUI();
  }

  function syncResultUI(){
    const n = state.results.length;
    const i = state.resultIndex;
    const label = n === 0 ? '0 results' : ('Result ' + (i + 1) + ' of ' + n);
    const qc = $('#quickCounter'); if (qc) qc.textContent = label;
    const rm = $('#resultsMeta');
    if (rm) rm.textContent = n === 0
      ? (state.lastSearch ? 'No matches.' : 'No search yet.')
      : (n + ' matches across ' + new Set(state.results.map(r => r.fileId)).size + ' file(s)');
  }

  function renderResults(){
    const list = $('#resultsList');
    if (!list) return;
    list.innerHTML = state.results.slice(0, 300).map(r => `
      <li class="result-item ${r.globalIndex === state.resultIndex ? 'active' : ''}" data-idx="${r.globalIndex}">
        <span class="result-file">${escapeHtml(r.fileName)} · ${escapeHtml(r.loc)}</span>
        <span class="result-ctx">…${escapeHtml(r.before)}<mark class="${r.globalIndex === state.resultIndex ? 'active' : ''}">${escapeHtml(r.match)}</mark>${escapeHtml(r.after)}…</span>
      </li>`).join('');

    list.querySelectorAll('.result-item').forEach(el => {
      el.addEventListener('click', () => jumpToResult(+el.dataset.idx));
    });
  }

  function jumpToResult(idx){
    if (idx < 0 || idx >= state.results.length) return;
    state.resultIndex = idx;
    const r = state.results[idx];
    if (r.fileId !== state.activeId){
      state.activeId = r.fileId;
      renderFileList();
      renderEditor();
    }
    const ta = $('#editor');
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(r.index, r.index + r.match.length);
    const lineNum = ta.value.slice(0, r.index).split('\n').length;
    ta.scrollTop = Math.max(0, (lineNum - 6) * 19.4);
    syncEditorScroll();
    highlightInLayer();
    renderResults();
    syncResultUI();
  }

  function nextResult(){
    if (state.results.length) jumpToResult((state.resultIndex + 1) % state.results.length);
  }
  function prevResult(){
    if (state.results.length) jumpToResult((state.resultIndex - 1 + state.results.length) % state.results.length);
  }

  /* ============================================================
     REPLACE
     ============================================================ */
  function performReplace(findStr, replStr, opts){
    opts = opts || {};
    const caseSensitive = !!opts.caseSensitive;
    const wholeWord = !!opts.wholeWord;
    const useRegex = !!opts.useRegex;
    const scope = opts.scope || state.scope;
    const all = !!opts.all;

    if (!findStr){ toast('Enter text to find', 'err'); return 0; }
    const globalRe = buildSearchRegex(findStr, caseSensitive, wholeWord, useRegex);
    if (!globalRe){ toast('Invalid regex', 'err'); return 0; }

    const targets = filesInScope(scope);
    const snapshot = targets.map(f => ({ id: f.id, text: f.text }));
    let total = 0;

    let replaceRe = globalRe;
    if (!all) replaceRe = new RegExp(globalRe.source, globalRe.flags.replace('g', ''));

    for (const f of targets){
      const text = f.text || '';
      if (!text) continue;
      const cnt = (text.match(globalRe) || []).length;
      if (!cnt) continue;

      if (all){
        f.text = text.replace(globalRe, replStr);
        total += cnt;
      } else {
        f.text = text.replace(replaceRe, replStr);
        total += 1;
        if (scope === 'current') break;
      }
      f.wordCount = countWords(f.text);
      f.charCount = f.text.length;
    }

    if (total > 0){
      state.replaceStack.push({ snapshots: snapshot, label: total + ' replacement(s)' });
      if (state.replaceStack.length > 40) state.replaceStack.shift();
    }
    AppLog('replace:', findStr, '->', replStr, ':', total);
    return total;
  }

  /* ============================================================
     STATS
     ============================================================ */
  function computeStats(text){
    text = text || '';
    const wordList = text.match(/[a-zA-Z0-9_'-]+/g) || [];
    const words = wordList.length;
    const letters = countLetters(text);
    const numbers = (text.match(/[0-9]/g) || []).length;
    const spaces = (text.match(/[ \t]/g) || []).length;
    const newlines = (text.match(/\n/g) || []).length;
    const lines = text.length ? text.split('\n').length : 0;
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length).length;
    const sentences = countSentences(text);
    const punctuation = (text.match(/[.,;:!?'"()\[\]{}\-]/g) || []).length;
    const symbols = (text.match(/[^a-zA-Z0-9\s.,;:!?'"()\[\]{}\-]/g) || []).length;
    const chars = text.length;
    const charsNoSpace = text.replace(/\s/g, '').length;

    const freq = new Map();
    for (const w of wordList){
      const k = w.toLowerCase();
      freq.set(k, (freq.get(k) || 0) + 1);
    }

    const letterFreq = {};
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length; i++){
      const c = lower.charCodeAt(i);
      if (c >= 97 && c <= 122){
        const ch = lower[i];
        letterFreq[ch] = (letterFreq[ch] || 0) + 1;
      }
    }

    return {
      words, uniqueWords: freq.size, letters, numbers,
      spaces, newlines, lines, paragraphs, sentences, punctuation, symbols,
      chars, charsNoSpace, freq, letterFreq
    };
  }

  function scopedStats(scope){
    const targets = filesInScope(scope || state.scope);
    const text = targets.map(f => f.text || '').join('\n');
    return { stats: computeStats(text), files: targets };
  }

  /* ============================================================
     VIEWS
     ============================================================ */
  const VIEW_IDS = {
    editor: 'viewEditor',
    overview: 'viewOverview',
    replace: 'viewReplace',
    frequency: 'viewFrequency',
    allwords: 'viewAllWords',
    letters: 'viewLetters',
    sentences: 'viewSentences',
    characters: 'viewCharacters',
    perfile: 'viewPerFile'
  };

  function switchView(v){
    if (!VIEW_IDS[v]) return;
    state.view = v;
    $$('.view').forEach(el => el.classList.add('hidden'));
    const el = document.getElementById(VIEW_IDS[v]);
    if (el) el.classList.remove('hidden');
    $$('.side-nav[data-group="views"] .nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.view === v);
    });
    refreshViews();
    AppLog('view:', v);
  }

  function refreshViews(){
    try {
      const result = scopedStats();
      const stats = result.stats;
      renderLiveStats(stats);
      renderStatusBar(stats);
      if (state.view === 'overview') renderDashboard();
      if (state.view === 'frequency') renderFrequency();
      if (state.view === 'allwords') renderAllWords();
      if (state.view === 'letters') renderLetters();
      if (state.view === 'sentences') renderSentences();
      if (state.view === 'characters') renderCharacters();
      if (state.view === 'perfile') renderPerFile();
    } catch(e){
      AppLog('refreshViews ERROR:', e.message);
    }
  }

  function refreshStatsOnly(){
    try {
      const { stats } = scopedStats();
      renderLiveStats(stats);
      renderStatusBar(stats);
      if (state.view === 'overview') renderDashboard();
      if (state.view === 'characters') renderCharacters();
    } catch(e){
      AppLog('refreshStatsOnly ERROR:', e.message);
    }
  }

  function topEntry(obj){
    let best = null, bestN = 0;
    if (obj instanceof Map){
      for (const [k,v] of obj) if (v > bestN){ best = k; bestN = v; }
    } else {
      for (const k in obj) if (obj[k] > bestN){ best = k; bestN = obj[k]; }
    }
    return best !== null ? [best, bestN] : null;
  }

  function renderLiveStats(s){
    const el = $('#liveStats');
    if (!el) return;
    const mostWord = topEntry(s.freq);
    const mostLetter = topEntry(s.letterFreq);
    const rows = [
      ['Words', s.words.toLocaleString()],
      ['Unique Words', s.uniqueWords.toLocaleString()],
      ['Letters', s.letters.toLocaleString()],
      ['Characters', s.chars.toLocaleString()],
      ['Characters (no spaces)', s.charsNoSpace.toLocaleString()],
      ['Sentences', s.sentences.toLocaleString()],
      ['Paragraphs', s.paragraphs.toLocaleString()],
      ['Lines', s.lines.toLocaleString()],
      ['Numbers', s.numbers.toLocaleString()],
      ['Symbols', s.symbols.toLocaleString()],
      ['Punctuation', s.punctuation.toLocaleString()],
      ['Spaces', s.spaces.toLocaleString()],
      ['Most Used Word', mostWord ? (mostWord[0] + ' (' + mostWord[1] + ')') : '—'],
      ['Most Used Letter', mostLetter ? (mostLetter[0].toUpperCase() + ' (' + mostLetter[1] + ')') : '—']
    ];
    el.innerHTML = rows.map(([k,v]) =>
      '<div class="stat-row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'
    ).join('');
  }

  function renderStatusBar(s){
    const el = $('#statusBar');
    if (!el) return;
    el.textContent = state.files.length + ' files • ' +
      s.words.toLocaleString() + ' words • ' +
      s.letters.toLocaleString() + ' letters • ' +
      s.sentences.toLocaleString() + ' sentences';
  }

  function renderDashboard(){
    const { stats } = scopedStats();
    if (window.Dashboard){
      Dashboard.renderDashboard(stats, state.files);
      return;
    }
    // fallback (original behaviour)
    const mostWord = topEntry(stats.freq);
    const mostLetter = topEntry(stats.letterFreq);
    const cards = [
      ['Files', state.files.length],
      ['Words', stats.words.toLocaleString()],
      ['Letters', stats.letters.toLocaleString()],
      ['Characters', stats.chars.toLocaleString()],
      ['Sentences', stats.sentences.toLocaleString()],
      ['Unique Words', stats.uniqueWords.toLocaleString()],
      ['Most Used Word', mostWord ? mostWord[0] : '—', true],
      ['Most Used Letter', mostLetter ? mostLetter[0].toUpperCase() : '—', true]
    ];
    const grid = $('#dashGrid');
    if (grid) grid.innerHTML = cards.map(([k,v,small]) =>
      '<div class="dash-card"><div class="dash-label">' + k + '</div><div class="dash-value ' + (small ? 'small' : '') + '">' + v + '</div></div>'
    ).join('');
  }

  function renderFrequency(){
    const { stats } = scopedStats();
    const ignore = $('#ignoreCommon').checked;
    let entries = Array.from(stats.freq.entries());
    if (ignore) entries = entries.filter(([w]) => !COMMON_WORDS.has(w) && w.length > 1);
    entries.sort((a,b) => b[1] - a[1]);

    const topSel = $('#freqTop').value;
    const visualEntries = topSel === 'all' ? entries : entries.slice(0, +topSel);

    const total = Array.from(stats.freq.values()).reduce((a,b) => a + b, 0) || 1;
    const max = visualEntries.length ? visualEntries[0][1] : 1;

    const tbody = $('#freqTable tbody');
    if (tbody){
      tbody.innerHTML = visualEntries.map(([w,c], i) =>
        '<tr><td>' + (i + 1) + '</td><td><button class="word-link" data-word="' + escapeHtml(w) + '">' + escapeHtml(w) + '</button></td><td>' + c.toLocaleString() + '</td><td>' + (c / total * 100).toFixed(2) + '%</td><td><div class="bar-mini" style="width:' + Math.min(120, c / max * 120) + 'px"></div></td></tr>'
      ).join('') || '<tr><td colspan="5">No words.</td></tr>';

      tbody.querySelectorAll('.word-link').forEach(b => {
        b.addEventListener('click', () => {
          const qs = $('#quickSearch');
          if (qs) qs.value = b.dataset.word;
          switchView('editor');
          performSearch(b.dataset.word, { scope: state.scope });
        });
      });
    }

    if (window.Dashboard) Dashboard.renderWordCloud(visualEntries);
  }

  function renderAllWords(){
    const { stats } = scopedStats();
    const q = $('#allWordsSearch').value.toLowerCase().trim();
    const sort = $('#allWordsSort').value;
    let entries = Array.from(stats.freq.entries());
    if (q) entries = entries.filter(([w]) => w.includes(q));

    if (sort === 'az') entries.sort((a,b) => a[0].localeCompare(b[0]));
    else if (sort === 'za') entries.sort((a,b) => b[0].localeCompare(a[0]));
    else if (sort === 'desc') entries.sort((a,b) => b[1] - a[1]);
    else entries.sort((a,b) => a[1] - b[1]);

    const host = $('#allWordsList');
    if (!host) return;
    host.innerHTML = entries.slice(0, 2000).map(([w,c]) =>
      '<button class="word-chip" data-word="' + escapeHtml(w) + '">' + escapeHtml(w) + '<b>' + c + '</b></button>'
    ).join('') || '<div style="color:var(--muted);font-size:12px;">No words.</div>';

    host.querySelectorAll('.word-chip').forEach(b => {
      b.addEventListener('click', () => {
        const qs = $('#quickSearch');
        if (qs) qs.value = b.dataset.word;
        switchView('editor');
        performSearch(b.dataset.word, { scope: state.scope });
      });
    });
  }

  function renderLetters(){
    const { stats } = scopedStats();
    const lf = stats.letterFreq;
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const total = letters.reduce((a,l) => a + (lf[l] || 0), 0) || 1;
    const max = Math.max.apply(null, letters.map(l => lf[l] || 0).concat([1]));
    const sorted = letters.slice().sort((a,b) => (lf[b] || 0) - (lf[a] || 0));
    const most = sorted[0];
    const least = sorted[sorted.length - 1];

    const summary = $('#letterSummary');
    if (summary) summary.innerHTML =
      '<div>Total Letters: <b>' + total.toLocaleString() + '</b></div>' +
      '<div>Most Frequent: <b>' + most.toUpperCase() + '</b> (' + (lf[most] || 0).toLocaleString() + ')</div>' +
      '<div>Least Frequent: <b>' + least.toUpperCase() + '</b> (' + (lf[least] || 0).toLocaleString() + ')</div>';

    const chart = $('#letterChart');
    if (chart) chart.innerHTML = letters.map(l => {
      const c = lf[l] || 0;
      const h = Math.max(2, Math.round(c / max * 120));
      return '<div class="letter-bar" style="height:' + h + 'px" title="' + l.toUpperCase() + ': ' + c + '"><span>' + l.toUpperCase() + '</span></div>';
    }).join('');

    const tbody = $('#letterTable tbody');
    if (tbody) tbody.innerHTML = sorted.map(l => {
      const c = lf[l] || 0;
      return '<tr><td>' + l.toUpperCase() + '</td><td>' + c.toLocaleString() + '</td><td>' + (c / total * 100).toFixed(2) + '%</td><td><div class="bar-mini" style="width:' + Math.min(140, c / max * 140) + 'px"></div></td></tr>';
    }).join('');

    if (window.Dashboard) Dashboard.renderLetterDonut(lf);
  }

  function renderSentences(){
    const targets = filesInScope();
    const all = [];
    for (const f of targets){
      const text = f.text || '';
      if (!text.trim()) continue;
      const re = /[^.!?\n]+[.!?]+/g;
      let m, idx = 0;
      while ((m = re.exec(text)) !== null){
        const s = m[0].trim();
        if (!s) continue;
        const words = countWords(s);
        let loc = 'Line ' + (text.slice(0, m.index).split('\n').length);
        const pm = text.slice(0, m.index).match(/\[Page (\d+)/g);
        if (pm && pm.length) loc = 'Page ' + pm[pm.length - 1].match(/\d+/)[0];
        all.push({ text: s, words, chars: s.length, file: f.name, loc, order: idx++ });
      }
      if (all.length === 0){
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          const s = line.trim();
          if (!s) return;
          all.push({ text: s, words: countWords(s), chars: s.length, file: f.name, loc: 'Line ' + (i + 1), order: idx++ });
        });
      }
    }

    const sort = $('#sentSort').value;
    const sorted = all.slice();
    if (sort === 'long') sorted.sort((a,b) => b.chars - a.chars);
    else if (sort === 'short') sorted.sort((a,b) => a.chars - b.chars);
    else if (sort === 'most') sorted.sort((a,b) => b.words - a.words);
    else if (sort === 'few') sorted.sort((a,b) => a.words - b.words);

    const total = $('#sentTotal');
    if (total) total.textContent = 'Total Sentences: ' + all.length.toLocaleString();

    const list = $('#sentList');
    if (list) list.innerHTML = sorted.slice(0, 2000).map(s =>
      '<li>' + escapeHtml(s.text.slice(0, 400)) + (s.text.length > 400 ? '…' : '') +
      '<div class="sent-meta"><span>' + s.words + ' words</span><span>' + s.chars + ' chars</span><span>' + escapeHtml(s.file) + '</span><span>' + escapeHtml(s.loc) + '</span></div></li>'
    ).join('') || '<li style="list-style:none;padding:0;">No sentences found.</li>';
  }

  function renderCharacters(){
    const { stats } = scopedStats();
    const cards = [
      ['Letters', stats.letters],
      ['Numbers', stats.numbers],
      ['Spaces', stats.spaces],
      ['Punctuation', stats.punctuation],
      ['Symbols', stats.symbols],
      ['New Lines', stats.newlines],
      ['Total Characters', stats.chars],
      ['Chars (no spaces)', stats.charsNoSpace]
    ];
    const grid = $('#charGrid');
    if (grid) grid.innerHTML = cards.map(([k,v]) =>
      '<div class="char-card"><div class="k">' + k + '</div><div class="v">' + v.toLocaleString() + '</div></div>'
    ).join('');
  }

  function renderPerFile(){
    const rows = state.files.map(f => {
      const s = computeStats(f.text || '');
      return '<tr><td>' + escapeHtml(f.name) + '</td><td>' + (f.ext || '?').toUpperCase() + '</td><td>' + s.words.toLocaleString() + '</td><td>' + s.letters.toLocaleString() + '</td><td>' + s.sentences.toLocaleString() + '</td><td>' + s.chars.toLocaleString() + '</td></tr>';
    }).join('') || '<tr><td colspan="6">No files.</td></tr>';

    const tbody = $('#perFileTable tbody');
    if (tbody) tbody.innerHTML = rows;

    const total = computeStats(state.files.map(f => f.text || '').join('\n'));
    const totalRow = $('#perFileTotal');
    if (totalRow) totalRow.innerHTML =
      '<span>TOTAL</span><span>Words: ' + total.words.toLocaleString() + '</span><span>Letters: ' + total.letters.toLocaleString() + '</span><span>Sentences: ' + total.sentences.toLocaleString() + '</span><span>Characters: ' + total.chars.toLocaleString() + '</span>';
  }

  /* ============================================================
     EXPORT
     ============================================================ */
  function exportData(kind){
    const { stats } = scopedStats();

    if (kind === 'txt'){
      const text = filesInScope().map(f => '===== ' + f.name + ' =====\n' + f.text).join('\n\n');
      download('extracted_text.txt', text);
      toast('Exported extracted text', 'ok');
    }
    else if (kind === 'edited'){
      const f = activeFile();
      download((f ? f.name.replace(/\.[^.]+$/, '') : 'edited') + '_edited.txt', f ? f.text : '');
      toast('Exported edited text', 'ok');
    }
    else if (kind === 'freq'){
      const entries = Array.from(stats.freq.entries()).sort((a,b) => b[1] - a[1]);
      const total = entries.reduce((a,b) => a + b[1], 0) || 1;
      const rows = [['Rank','Word','Count','Percentage']];
      entries.forEach(([w,c], i) => rows.push([i + 1, w, c, (c / total * 100).toFixed(3) + '%']));
      download('word_frequency.csv', toCSV(rows), 'text/csv');
      toast('Exported frequency CSV', 'ok');
    }
    else if (kind === 'stats'){
      const rows = [['Metric','Value'],
        ['Files', state.files.length],
        ['Words', stats.words],
        ['Unique Words', stats.uniqueWords],
        ['Letters', stats.letters],
        ['Numbers', stats.numbers],
        ['Spaces', stats.spaces],
        ['Punctuation', stats.punctuation],
        ['Symbols', stats.symbols],
        ['Lines', stats.lines],
        ['Paragraphs', stats.paragraphs],
        ['Sentences', stats.sentences],
        ['Characters', stats.chars],
        ['Characters (no spaces)', stats.charsNoSpace]];
      download('statistics.csv', toCSV(rows), 'text/csv');
      toast('Exported statistics', 'ok');
    }
    else if (kind === 'results'){
      const rows = [['File','Location','Match','Context']];
      state.results.forEach(r => rows.push([r.fileName, r.loc, r.match, '…' + r.before + '[' + r.match + ']' + r.after + '…']));
      download('search_results.csv', toCSV(rows), 'text/csv');
      toast('Exported search results', 'ok');
    }
    else if (kind === 'words'){
      const entries = Array.from(stats.freq.entries()).sort((a,b) => a[0].localeCompare(b[0]));
      const rows = [['Word','Count']];
      entries.forEach(([w,c]) => rows.push([w,c]));
      download('all_words.csv', toCSV(rows), 'text/csv');
      toast('Exported all words', 'ok');
    }
    else if (kind === 'sentences'){
      const rows = [['#','File','Location','Words','Chars','Sentence']];
      let i = 1;
      filesInScope().forEach(f => {
        const text = f.text || '';
        const re = /[^.!?\n]+[.!?]+/g;
        let m;
        while ((m = re.exec(text)) !== null){
          const s = m[0].trim();
          if (!s) continue;
          const words = countWords(s);
          const loc = 'Line ' + (text.slice(0, m.index).split('\n').length);
          rows.push([i++, f.name, loc, words, s.length, s]);
        }
      });
      download('sentences.csv', toCSV(rows), 'text/csv');
      toast('Exported sentences', 'ok');
    }
    else if (kind === 'report'){
      const mostWord = topEntry(stats.freq);
      const mostLetter = topEntry(stats.letterFreq);
      const lines = [
        'WORDANALYZER — ANALYSIS REPORT',
        'Generated: ' + new Date().toLocaleString(),
        '',
        'FILES ANALYZED',
        ...state.files.map(f => '  ' + f.name + '  [' + f.ext.toUpperCase() + ']  ' + fmtSize(f.size) + '  ' + f.status + '  ' + f.wordCount + ' words' + (f.error ? ' (' + f.error + ')' : '')),
        '',
        'COMBINED STATISTICS',
        '  Words: ' + stats.words,
        '  Unique Words: ' + stats.uniqueWords,
        '  Letters: ' + stats.letters,
        '  Numbers: ' + stats.numbers,
        '  Spaces: ' + stats.spaces,
        '  Punctuation: ' + stats.punctuation,
        '  Symbols: ' + stats.symbols,
        '  Lines: ' + stats.lines,
        '  Paragraphs: ' + stats.paragraphs,
        '  Sentences: ' + stats.sentences,
        '  Characters: ' + stats.chars,
        '  Characters (no spaces): ' + stats.charsNoSpace,
        '',
        'Most Used Word: ' + (mostWord ? mostWord[0] + ' (' + mostWord[1] + ')' : '—'),
        'Most Used Letter: ' + (mostLetter ? mostLetter[0].toUpperCase() + ' (' + mostLetter[1] + ')' : '—'),
        '',
        'TOP 25 WORDS',
        ...Array.from(stats.freq.entries()).sort((a,b) => b[1] - a[1]).slice(0, 25)
          .map(([w,c], i) => '  ' + String(i + 1).padStart(3) + '. ' + w.padEnd(20) + ' ' + c)
      ];
      download('analysis_report.txt', lines.join('\n'));
      toast('Exported report', 'ok');
    }
    else if (kind === 'pdf'){
      generatePDF();
    }
  }

  function generatePDF(){
    if (!window.jspdf || !window.jspdf.jsPDF){ toast('PDF library not loaded', 'err'); return; }
    const { jsPDF } = window.jspdf;
    const f = activeFile();
    const text = f ? f.text : filesInScope().map(x => x.text).join('\n\n');
    if (!text.trim()){ toast('No text to export', 'err'); return; }

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 48;
    const maxW = pageW - margin * 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    let y = margin;
    const lineHeight = 14;

    for (const para of text.split(/\n/)){
      const lines = doc.splitTextToSize(para || ' ', maxW);
      for (const line of lines){
        if (y + lineHeight > pageH - margin){ doc.addPage(); y = margin; }
        doc.text(line, margin, y);
        y += lineHeight;
      }
    }
    doc.save('generated.pdf');
    toast('Generated PDF (original formatting not preserved)', 'ok');
  }

  /* ============================================================
     SCOPE SWITCH
     ============================================================ */
  function renderScopeSwitches(){
    $$('.scope-switch').forEach(el => {
      if (!el.dataset.rendered){
        el.dataset.rendered = '1';
        el.innerHTML =
          '<button data-scope="current">Current File</button>' +
          '<button data-scope="selected">Selected Files</button>' +
          '<button data-scope="all">All Files</button>';
      }
      el.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', b.dataset.scope === state.scope);
        if (!b.dataset.bound){
          b.dataset.bound = '1';
          b.addEventListener('click', () => {
            state.scope = b.dataset.scope;
            $$('.scope-switch button').forEach(x => x.classList.toggle('active', x.dataset.scope === state.scope));
            refreshViews();
            if (state.lastSearch) performSearch(state.lastSearch, { scope: state.scope });
          });
        }
      });
    });
  }

  /* ============================================================
     SELF TEST (preserved)
     ============================================================ */
  async function runSelfTest(){
    AppLog('===== SELF TEST START =====');
    const testText = 'Hello world. This is a test. One two three four five.';
    const expectedWords = 11;
    const expectedSentences = 3;

    try {
      AppLog('1) Creating test file');
      const blob = new Blob([testText], { type: 'text/plain' });
      const file = new File([blob], 'selftest.txt', { type: 'text/plain' });
      AppLog('   File:', file.name, file.size, 'bytes');

      AppLog('2) Reading with FileReader');
      const read = await readFile(file, 'text');
      AppLog('   Read ' + read.length + ' chars: "' + read.slice(0, 50) + '..."');

      AppLog('3) Word count');
      const wc = countWords(read);
      AppLog('   Result: ' + wc + ' (expected ' + expectedWords + ') ' + (wc === expectedWords ? 'PASS' : 'FAIL'));

      AppLog('4) Sentence count');
      const sc = countSentences(read);
      AppLog('   Result: ' + sc + ' (expected ' + expectedSentences + ') ' + (sc === expectedSentences ? 'PASS' : 'FAIL'));

      AppLog('5) Full stats');
      const stats = computeStats(read);
      AppLog('   words=' + stats.words + ' sentences=' + stats.sentences + ' letters=' + stats.letters + ' chars=' + stats.chars);

      AppLog('6) DOM elements');
      ['fileList','editor','liveStats','statusBar','debugLog','dashGrid','quickSearch','uploadStrip']
        .forEach(id => {
          const el = document.getElementById(id);
          AppLog('   #' + id + ': ' + (el ? 'OK' : 'MISSING'));
        });

      AppLog('7) Libraries');
      AppLog('   pdfjsLib: ' + (typeof pdfjsLib !== 'undefined'));
      AppLog('   Tesseract: ' + (typeof Tesseract !== 'undefined'));
      AppLog('   mammoth: ' + (typeof mammoth !== 'undefined'));
      AppLog('   XLSX: ' + (typeof XLSX !== 'undefined'));
      AppLog('   JSZip: ' + (typeof JSZip !== 'undefined'));
      AppLog('   jsPDF: ' + (typeof window.jspdf !== 'undefined'));
      AppLog('   THREE: ' + (typeof THREE !== 'undefined'));

      AppLog('===== SELF TEST PASSED =====');
      toast('Self-test passed — pipeline works', 'ok');
    } catch(e){
      AppLog('===== SELF TEST FAILED =====');
      AppLog('Error: ' + e.message);
      AppLog('Stack: ' + (e.stack || 'no stack'));
      toast('Self-test failed — see debug log', 'err');
    }
  }

  /* ============================================================
     BIND & INIT
     ============================================================ */
  function bindGlobal(){
    const uploadBtn = $('#btnUpload');
    const browseBtn = $('#btnBrowse');
    const fileInput = $('#fileInput');

    if (uploadBtn) uploadBtn.addEventListener('click', () => fileInput.click());
    if (browseBtn) browseBtn.addEventListener('click', () => fileInput.click());
    if (fileInput) fileInput.addEventListener('change', e => {
      addFiles(e.target.files);
      e.target.value = '';
    });

    const dz = $('#dropZone');
    if (dz){
      ['dragenter','dragover'].forEach(ev => document.addEventListener(ev, e => {
        e.preventDefault();
        dz.classList.remove('hidden');
        dz.classList.add('drag');
      }));
      ['dragleave','drop'].forEach(ev => document.addEventListener(ev, e => {
        e.preventDefault();
        if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files.length){
          addFiles(e.dataTransfer.files);
        }
        dz.classList.remove('drag');
        if (state.files.length) dz.classList.add('hidden');
      }));
    }

    $$('.side-nav[data-group="files"] .nav-item').forEach(n => {
      n.addEventListener('click', () => {
        $$('.side-nav[data-group="files"] .nav-item').forEach(x => x.classList.remove('active'));
        n.classList.add('active');
        state.filter = n.dataset.filter;
        renderFileList();
      });
    });

    $$('.side-nav[data-group="views"] .nav-item').forEach(n => {
      n.addEventListener('click', () => switchView(n.dataset.view));
    });

    const selAll = $('#selectAllFiles');
    if (selAll) selAll.addEventListener('change', e => {
      state.selected.clear();
      if (e.target.checked) state.files.forEach(f => state.selected.add(f.id));
      renderFileList();
      refreshViews();
    });

    const processAllBtn = $('#btnProcessAll');
    if (processAllBtn) processAllBtn.addEventListener('click', async () => {
      for (const f of state.files){
        if (f.status !== 'done'){
          f.text = '';
          f.status = 'pending';
          f.progress = 0;
          f.error = null;
          if (window.UploadManager) UploadManager.enqueue([f]);
          else await processFile(f);
        }
      }
      toast('All files processed', 'ok');
    });

    const removeAllBtn = $('#btnRemoveAll');
    if (removeAllBtn) removeAllBtn.addEventListener('click', async () => {
      if (!state.files.length) return;
      const ok = await confirmModal('Remove all files?', 'This clears all uploaded files and extracted text.');
      if (!ok) return;
      state.files = [];
      state.selected.clear();
      state.activeId = null;
      state.results = [];
      state.lastSearch = '';
      renderFileList();
      renderEditor();
      refreshViews();
      updateCounts();
      updateCenterVisibility();
      renderResults();
      syncResultUI();
    });

    const debugBtn = $('#btnDebug');
    if (debugBtn) debugBtn.addEventListener('click', () => {
      const dl = $('#debugLog');
      if (dl) dl.style.display = dl.style.display === 'block' ? 'none' : 'block';
    });

    const selfTest = $('#btnSelfTest');
    if (selfTest) selfTest.addEventListener('click', runSelfTest);

    const focusSearch = $('#btnFocusSearch');
    if (focusSearch) focusSearch.addEventListener('click', () => {
      switchView('editor');
      const qs = $('#quickSearch');
      if (qs) qs.focus();
    });

    const qs = $('#quickSearch');
    if (qs){
      const runSearch = debounce(() => performSearch(qs.value, { scope: state.scope }), 220);
      qs.addEventListener('input', runSearch);
      qs.addEventListener('keydown', e => {
        if (e.key === 'Enter'){ e.preventDefault(); e.shiftKey ? prevResult() : nextResult(); }
        if (e.key === 'Escape'){ qs.value = ''; performSearch('', {}); }
      });
    }
    const qPrev = $('#qPrev'); if (qPrev) qPrev.addEventListener('click', prevResult);
    const qNext = $('#qNext'); if (qNext) qNext.addEventListener('click', nextResult);
    const qClear = $('#qClear'); if (qClear) qClear.addEventListener('click', () => { if (qs) qs.value = ''; performSearch('', {}); });

    const editorUndo = $('#btnUndo');
    if (editorUndo) editorUndo.addEventListener('click', () => {
      const f = activeFile();
      if (!f || !state.editorUndo.length) return;
      state.editorRedo.push(f.text);
      f.text = state.editorUndo.pop();
      f.wordCount = countWords(f.text);
      f.charCount = f.text.length;
      renderEditor(); refreshStatsOnly(); renderFileList();
    });

    const editorRedo = $('#btnRedo');
    if (editorRedo) editorRedo.addEventListener('click', () => {
      const f = activeFile();
      if (!f || !state.editorRedo.length) return;
      state.editorUndo.push(f.text);
      f.text = state.editorRedo.pop();
      f.wordCount = countWords(f.text);
      f.charCount = f.text.length;
      renderEditor(); refreshStatsOnly(); renderFileList();
    });

    const copyBtn = $('#btnCopy');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const ta = $('#editor');
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      try {
        await navigator.clipboard.writeText(sel || ta.value);
        toast('Copied', 'ok');
      } catch(e){ toast('Clipboard unavailable', 'err'); }
    });

    const cutBtn = $('#btnCut');
    if (cutBtn) cutBtn.addEventListener('click', async () => {
      const ta = $('#editor');
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (!sel) return;
      try {
        await navigator.clipboard.writeText(sel);
        ta.setRangeText('', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
        toast('Cut', 'ok');
      } catch(e){ toast('Clipboard unavailable', 'err'); }
    });

    const pasteBtn = $('#btnPaste');
    if (pasteBtn) pasteBtn.addEventListener('click', async () => {
      try {
        const t = await navigator.clipboard.readText();
        const ta = $('#editor');
        ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      } catch(e){ toast('Clipboard read blocked by browser', 'err'); }
    });

    const selectAllBtn = $('#btnSelectAll');
    if (selectAllBtn) selectAllBtn.addEventListener('click', () => {
      const ta = $('#editor');
      ta.focus();
      ta.select();
    });

    const clearTextBtn = $('#btnClearText');
    if (clearTextBtn) clearTextBtn.addEventListener('click', async () => {
      const f = activeFile();
      if (!f) return;
      const ok = await confirmModal('Clear text?', 'This clears the extracted text for the current file.');
      if (!ok) return;
      state.editorUndo.push(f.text);
      f.text = '';
      f.wordCount = 0;
      f.charCount = 0;
      renderEditor();
      refreshViews();
      renderFileList();
    });

    const wrapBtn = $('#btnWrap');
    if (wrapBtn) wrapBtn.addEventListener('click', e => {
      state.wrap = !state.wrap;
      $('#editorWrap').classList.toggle('wrap', state.wrap);
      e.currentTarget.classList.toggle('active', state.wrap);
      $('#editor').setAttribute('wrap', state.wrap ? 'soft' : 'off');
      syncEditorScroll();
    });

    const linesBtn = $('#btnLines');
    if (linesBtn) linesBtn.addEventListener('click', e => {
      state.showLines = !state.showLines;
      e.currentTarget.classList.toggle('active', state.showLines);
      renderLineNumbers($('#editor').value);
      syncEditorScroll();
    });

    const hlBtn = $('#btnHighlightAll');
    if (hlBtn) hlBtn.addEventListener('click', e => {
      state.highlightAll = !state.highlightAll;
      e.currentTarget.classList.toggle('active', state.highlightAll);
      if (state.highlightAll && state.lastSearch) highlightInLayer();
      else renderHighlight($('#editor').value);
    });

    /* Find & replace */
    const frFindBtn = $('#frFindBtn');
    if (frFindBtn) frFindBtn.addEventListener('click', () => {
      switchView('editor');
      performSearch($('#frFind').value, {
        caseSensitive: $('#frCase').checked,
        wholeWord: $('#frWord').checked,
        useRegex: $('#frRegex').checked,
        scope: state.scope
      });
    });

    const frReplaceOne = $('#frReplaceOne');
    if (frReplaceOne) frReplaceOne.addEventListener('click', () => {
      const n = performReplace($('#frFind').value, $('#frReplace').value, {
        caseSensitive: $('#frCase').checked,
        wholeWord: $('#frWord').checked,
        useRegex: $('#frRegex').checked,
        scope: state.scope,
        all: false
      });
      $('#frStatus').textContent = n ? (n + ' replacement completed.') : 'No matches.';
      renderEditor();
      refreshViews();
      renderFileList();
    });

    const frReplaceAll = $('#frReplaceAll');
    if (frReplaceAll) frReplaceAll.addEventListener('click', async () => {
      const find = $('#frFind').value;
      const repl = $('#frReplace').value;
      if (!find){ toast('Enter text to find', 'err'); return; }
      const re = buildSearchRegex(find, $('#frCase').checked, $('#frWord').checked, $('#frRegex').checked);
      if (!re){ toast('Invalid regex', 'err'); return; }

      let count = 0, fileCount = 0;
      filesInScope().forEach(f => {
        re.lastIndex = 0;
        const m = (f.text || '').match(re);
        if (m){ count += m.length; fileCount++; }
      });

      const ok = await confirmModal('Replace all?', 'Replace ' + count + ' occurrence(s) across ' + fileCount + ' file(s)?');
      if (!ok) return;

      const n = performReplace(find, repl, {
        caseSensitive: $('#frCase').checked,
        wholeWord: $('#frWord').checked,
        useRegex: $('#frRegex').checked,
        scope: state.scope,
        all: true
      });
      $('#frStatus').textContent = n + ' replacements completed.';
      renderEditor();
      refreshViews();
      renderFileList();
      toast(n + ' replacements completed.', 'ok');
    });

    const frUndo = $('#frUndo');
    if (frUndo) frUndo.addEventListener('click', () => {
      const last = state.replaceStack.pop();
      if (!last){ toast('Nothing to undo', 'err'); return; }
      last.snapshots.forEach(s => {
        const f = state.files.find(x => x.id === s.id);
        if (f){
          f.text = s.text;
          f.wordCount = countWords(f.text);
          f.charCount = f.text.length;
        }
      });
      $('#frStatus').textContent = 'Replacement undone.';
      renderEditor();
      refreshViews();
      renderFileList();
    });

    const ignoreCommon = $('#ignoreCommon');
    if (ignoreCommon) ignoreCommon.addEventListener('change', renderFrequency);
    const freqTop = $('#freqTop');
    if (freqTop) freqTop.addEventListener('change', renderFrequency);
    const allWordsSearch = $('#allWordsSearch');
    if (allWordsSearch) allWordsSearch.addEventListener('input', debounce(renderAllWords, 150));
    const allWordsSort = $('#allWordsSort');
    if (allWordsSort) allWordsSort.addEventListener('change', renderAllWords);
    const sentSort = $('#sentSort');
    if (sentSort) sentSort.addEventListener('change', renderSentences);

    $$('[data-export]').forEach(b => b.addEventListener('click', () => exportData(b.dataset.export)));

    document.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'f'){
        e.preventDefault();
        switchView('editor');
        const q = $('#quickSearch');
        if (q){ q.focus(); q.select(); }
      }
      if (mod && e.key === 'h'){
        e.preventDefault();
        switchView('replace');
        const el = $('#frFind');
        if (el) el.focus();
      }
      if (mod && e.key === 's'){ e.preventDefault(); exportData('txt'); }
      if (e.key === 'F3'){ e.preventDefault(); e.shiftKey ? prevResult() : nextResult(); }
    });
  }

  /* Expose for UploadManager & cloud clicks */
  function searchFromCloud(word){
    switchView('editor');
    performSearch(word, { scope: state.scope });
  }

  function refreshAll(){
    renderFileList();
    updateCounts();
    updateCenterVisibility();
    renderEditor();
    refreshViews();
  }

  window.App = {
    state,
    processFile,
    countWords,
    searchFromCloud,
    refreshAll
  };

  /* ============================================================
     BOOT
     ============================================================ */
  window.addEventListener('error', e => {
    AppLog('!! WINDOW ERROR: ' + e.message + ' at ' + (e.filename || '') + ':' + e.lineno);
  });

  document.addEventListener('DOMContentLoaded', () => {
    try {
      AppLog('===== INIT =====');
      AppLog('Libraries: pdfjs=' + (typeof pdfjsLib !== 'undefined') +
        ' tesseract=' + (typeof Tesseract !== 'undefined') +
        ' mammoth=' + (typeof mammoth !== 'undefined') +
        ' xlsx=' + (typeof XLSX !== 'undefined') +
        ' jszip=' + (typeof JSZip !== 'undefined') +
        ' jspdf=' + (typeof window.jspdf !== 'undefined') +
        ' three=' + (typeof THREE !== 'undefined'));

      renderScopeSwitches();
      bindEditor();
      bindGlobal();
      renderFileList();
      renderEditor();
      updateCenterVisibility();
      refreshViews();
      syncResultUI();
      renderResults();

      // Module init hooks (modules also self-init; these are safe repeats)
      if (window.ThreeScene) ThreeScene.init();
      if (window.Animations) Animations.init();

      AppLog('===== INIT DONE =====');
    } catch(e){
      AppLog('INIT ERROR: ' + e.message);
      AppLog('Stack: ' + (e.stack || 'no stack'));
    }
  });
})();