/* ============================================================
   Analyzer — file state, extraction, statistics, search, replace
   TXT fix lives here: decode via TextDecoder, count via \p{L}
   ============================================================ */
(function(){
  'use strict';

  const WA = window.WA;
  const $  = WA.$;
  const $$ = WA.$$;

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
    results: [],
    resultIndex: -1,
    lastSearch: '',
    replaceStack: [],
    editorUndo: [],
    editorRedo: [],
    wrap: false,
    showLines: true,
    defaultDir: WA.Prefs.get('dir', 'ltr')
  };

  const COMMON_WORDS = new Set((
    'the a an is are was were be been being of to and or in on at for with as by from ' +
    'that this these those it its i you he she we they them their there here ' +
    'what which who whom whose when where why how not no nor so if then than too very ' +
    'can could should would may might must will shall do does did done have has had ' +
    'having but also just only more most some any all each every both few many much ' +
    'other another such own same'
  ).split(/\s+/));

  /* ============================================================
     UNICODE-AWARE COUNTING
     The old build used /[a-zA-Z0-9]/ which is why Urdu and
     accented text reported zero. These regexes cover every letter
     and number in every script supported by the engine.
     ============================================================ */
  let WORD_RE;
  try {
    WORD_RE = new RegExp('[\\p{L}\\p{N}_\\'-]+', 'gu');
    // Sanity check — if the engine silently ignores the flags, fall through.
    if (!WORD_RE.test('test')) throw new Error('Unicode property escapes unsupported');
    WORD_RE.lastIndex = 0;
  } catch(e){
    WA.log('[count] falling back to whitespace tokenisation');
    WORD_RE = /[^\s]+/g;
  }

  let LETTER_RE;
  try {
    LETTER_RE = new RegExp('\\p{L}', 'gu');
  } catch(e){
    LETTER_RE = /[a-zA-Z]/g;
  }

  // Sentence terminators: ASCII . ! ? plus Arabic/Urdu full stop and question mark.
  const SENTENCE_RE = /[^.!?\n\u061F\u06D4]+[.!?\u061F\u06D4]+(?=\s|$)/g;

  function countWords(text){
    if (!text) return 0;
    const trimmed = String(text).trim();
    if (!trimmed) return 0;
    const matches = trimmed.match(WORD_RE);
    return matches ? matches.length : 0;
  }

  function countLetters(text){
    if (!text) return 0;
    const matches = String(text).match(LETTER_RE);
    return matches ? matches.length : 0;
  }

  function countSentences(text){
    if (!text) return 0;
    const trimmed = String(text).trim();
    if (!trimmed) return 0;
    const matches = trimmed.match(SENTENCE_RE);
    if (matches && matches.length) return matches.length;
    // Fallback: count non-empty lines so plain lists still register.
    return trimmed.split('\n').filter(line => line.trim().length > 0).length;
  }

  /* ============================================================
     FILE SHAPE
     ============================================================ */
  const ACCEPTED = new Set([
    'pdf','jpg','jpeg','png','webp','gif',
    'txt','csv','md','markdown','json','log','html','htm','xml',
    'docx','xlsx','xls','pptx'
  ]);

  function fileKind(file){
    const ext = file.ext;
    if (ext === 'pdf') return 'pdf';
    if (['jpg','jpeg','png','webp','gif'].includes(ext)) return 'image';
    if (['docx','xlsx','xls','pptx'].includes(ext)) return 'doc';
    if (WA.TEXT_EXTENSIONS.has(ext)) return 'text';
    return 'other';
  }

  function activeFile(){
    return state.files.find(f => f.id === state.activeId) || null;
  }

  function filesInScope(scope){
    const s = scope || state.scope;
    if (s === 'current'){
      const file = activeFile();
      return file ? [file] : [];
    }
    if (s === 'selected'){
      return state.files.filter(f => state.selected.has(f.id));
    }
    return state.files.filter(f => f.text && f.text.length > 0);
  }

  /* ============================================================
     ADD FILES
     ============================================================ */
  function addFiles(fileList){
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    WA.log('addFiles', incoming.length);

    const accepted = [];

    incoming.forEach(raw => {
      const ext = WA.extOf(raw.name);
      const ok = ACCEPTED.has(ext) || WA.isTextFile(raw);

      const file = {
        id: WA.uid(),
        raw,
        name: raw.name,
        ext,
        size: raw.size,
        status: ok ? 'pending' : 'error',
        error: ok ? null : 'Unsupported file type',
        text: '',
        originalText: '',
        dir: state.defaultDir,
        pages: null,
        ocrConfidence: null,
        progress: 0,
        wordCount: 0,
        charCount: 0
      };

      state.files.push(file);
      if (ok) accepted.push(file);
      WA.log('queued', raw.name, ext, ok ? 'OK' : 'unsupported');
    });

    if (!state.activeId && state.files.length){
      state.activeId = state.files[0].id;
    }

    refreshAll();

    if (accepted.length) WA.Upload.enqueue(accepted);
  }

  /* ============================================================
     PROCESSING
     ============================================================ */
  const scheduleFileList = WA.rafThrottle(() => renderFileList());

  async function processFile(file, report){
    const emit = typeof report === 'function' ? report : function(){};

    WA.log('processFile START', file.name, '(' + file.ext + ')');
    file.status = 'processing';
    file.error = null;
    file.progress = 0;
    scheduleFileList();

    try {
      let text = '';
      const kind = fileKind(file);

      if (file.ext === 'pdf'){
        if (typeof pdfjsLib === 'undefined') throw new Error('PDF library not loaded');
        text = await extractPDF(file, emit);
      } else if (kind === 'image'){
        if (typeof Tesseract === 'undefined') throw new Error('OCR library not loaded');
        text = await extractImage(file, emit);
      } else if (file.ext === 'docx'){
        if (typeof mammoth === 'undefined') throw new Error('DOCX library not loaded');
        text = await extractDOCX(file, emit);
      } else if (['xlsx','xls'].includes(file.ext)){
        if (typeof XLSX === 'undefined') throw new Error('XLSX library not loaded');
        text = await extractXLSX(file, emit);
      } else if (file.ext === 'pptx'){
        if (typeof JSZip === 'undefined') throw new Error('ZIP library not loaded');
        text = await extractPPTX(file, emit);
      } else if (WA.isTextFile(file.raw) || file.ext === ''){
        text = await extractText(file, emit);
      } else {
        throw new Error('Unsupported file type');
      }

      if (file.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });

      file.text = text || '';
      file.originalText = file.text;
      file.wordCount = countWords(file.text);
      file.charCount = file.text.length;

      if (!file.text.trim()){
        file.status = 'error';
        file.error = file.ext === 'pdf'
          ? 'No selectable text (image-only PDF)'
          : kind === 'image'
            ? 'No text detected by OCR'
            : 'No readable text found';
        WA.log('empty text', file.name);
      } else {
        file.status = 'done';
        WA.log('DONE', file.name, file.wordCount, 'words');
      }
    } catch(err){
      if (err && err.cancelled){
        file.status = 'error';
        file.error = 'Cancelled';
        throw err;
      }
      file.status = 'error';
      file.error = (err && err.message) ? err.message : 'Processing failed';
      WA.log('ERROR', file.name, file.error);
      WA.toast('Failed: ' + file.name + ' — ' + file.error, 'err');
    }

    file.progress = 100;
    refreshAll();
  }

  /* ============================================================
     EXTRACTORS
     Every extractor receives emit({ pct, phase }).
     pct === null means "no measurable progress; show indeterminate".
     ============================================================ */
  async function extractText(file, emit){
    emit({ pct: 0, phase: 'Reading…' });

    const text = await WA.readTextFile(file.raw, fraction => {
      emit({ pct: Math.round(fraction * 100), phase: 'Uploading…' });
    });

    WA.log('extractText', file.name, text.length, 'chars, first 40:', text.slice(0, 40));
    return text;
  }

  async function extractDOCX(file, emit){
    const buffer = await WA.readBlob(file.raw, 'buffer', fraction => {
      emit({ pct: Math.round(fraction * 60), phase: 'Uploading…' });
    });
    emit({ pct: null, phase: 'Extracting…' });
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value || '';
  }

  async function extractXLSX(file, emit){
    const buffer = await WA.readBlob(file.raw, 'buffer', fraction => {
      emit({ pct: Math.round(fraction * 60), phase: 'Uploading…' });
    });
    emit({ pct: null, phase: 'Reading sheets…' });

    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const parts = [];
    workbook.SheetNames.forEach(name => {
      parts.push('=== Sheet: ' + name + ' ===');
      parts.push(XLSX.utils.sheet_to_csv(workbook.Sheets[name]));
    });
    return parts.join('\n');
  }

  async function extractPPTX(file, emit){
    const buffer = await WA.readBlob(file.raw, 'buffer', fraction => {
      emit({ pct: Math.round(fraction * 40), phase: 'Uploading…' });
    });
    emit({ pct: null, phase: 'Opening slides…' });

    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = Number(a.match(/slide(\d+)/)[1]);
        const nb = Number(b.match(/slide(\d+)/)[1]);
        return na - nb;
      });

    if (!slideNames.length) throw new Error('No slides found');

    const parts = [];
    for (let i = 0; i < slideNames.length; i++){
      const xml = await zip.files[slideNames[i]].async('string');
      const texts = [];
      const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
      let match;
      while ((match = re.exec(xml))){
        texts.push(match[1]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'"));
      }
      parts.push('--- Slide ' + (i + 1) + ' ---\n' + texts.join('\n'));
      emit({
        pct: 40 + Math.round(((i + 1) / slideNames.length) * 60),
        phase: 'Extracting…'
      });
    }
    return parts.join('\n\n');
  }

  async function extractPDF(file, emit){
    const buffer = await WA.readBlob(file.raw, 'buffer', fraction => {
      emit({ pct: Math.round(fraction * 40), phase: 'Uploading…' });
    });
    emit({ pct: null, phase: 'Opening PDF…' });

    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    } catch(err){
      if (/password/i.test(err.message || '')) throw new Error('Password-protected PDF');
      throw new Error('Corrupt or unreadable PDF');
    }

    file.pages = pdf.numPages;
    const pageTexts = [];
    let emptyPages = 0;

    for (let page = 1; page <= pdf.numPages; page++){
      const pageObj = await pdf.getPage(page);
      const content = await pageObj.getTextContent();
      const text = content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();

      if (text){
        pageTexts.push('[Page ' + page + ']\n' + text);
      } else {
        emptyPages++;
        pageTexts.push('[Page ' + page + ']\n[no selectable text]');
      }

      const pct = 40 + Math.round((page / pdf.numPages) * 60);
      file.progress = pct;
      emit({ pct, phase: 'Extracting page ' + page + '/' + pdf.numPages });
      scheduleFileList();
    }

    if (emptyPages === pdf.numPages && typeof Tesseract !== 'undefined'){
      WA.toast('Scanned PDF — running OCR…');
      emit({ pct: null, phase: 'OCR…' });
      const ocrTexts = [];

      for (let page = 1; page <= pdf.numPages; page++){
        const pageObj = await pdf.getPage(page);
        const viewport = pageObj.getViewport({ scale: 1.6 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await pageObj.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

        const result = await Tesseract.recognize(canvas, 'eng', {
          logger: message => {
            if (message.status === 'recognizing text'){
              const pct = 40 + Math.round(((page - 1 + message.progress) / pdf.numPages) * 60);
              file.progress = pct;
              emit({ pct, phase: 'OCR page ' + page + '/' + pdf.numPages });
              scheduleFileList();
            }
          }
        });

        ocrTexts.push('[Page ' + page + ' — OCR]\n' + result.data.text.trim());
        if (file.ocrConfidence === null) file.ocrConfidence = result.data.confidence;
      }
      return ocrTexts.join('\n\n');
    }

    return pageTexts.join('\n\n');
  }

  async function extractImage(file, emit){
    const buffer = await WA.readBlob(file.raw, 'buffer', fraction => {
      emit({ pct: Math.round(fraction * 30), phase: 'Uploading…' });
    });
    emit({ pct: null, phase: 'Decoding image…' });

    const blob = new Blob([buffer], { type: file.raw.type || 'image/png' });
    const url = URL.createObjectURL(blob);

    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    const maxDim = 2200;
    let width = image.width;
    let height = image.height;
    if (Math.max(width, height) > maxDim){
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    URL.revokeObjectURL(url);

    const result = await Tesseract.recognize(canvas, 'eng', {
      logger: message => {
        if (message.status === 'recognizing text'){
          const pct = 30 + Math.round(message.progress * 70);
          file.progress = pct;
          emit({ pct, phase: 'OCR…' });
          scheduleFileList();
        }
      }
    });

    file.ocrConfidence = result.data.confidence;
    return (result.data.text || '').trim();
  }

  /* ============================================================
     RENDER — FILE LIST
     ============================================================ */
  function renderFileList(){
    const list = $('#fileList');
    if (!list) return;

    const visible = state.files.filter(f => state.filter === 'all' || fileKind(f) === state.filter);

    if (!visible.length){
      list.innerHTML = '<li class="meta" style="padding:8px;">No files.</li>';
      return;
    }

    list.innerHTML = visible.map(file => {
      const statusLabel = {
        pending: 'Pending',
        processing: 'Processing…',
        done: 'Done',
        error: 'Error'
      }[file.status] || file.status;

      return '' +
        '<li class="file-item ' + (state.activeId === file.id ? 'active' : '') + '" data-id="' + file.id + '">' +
          '<span class="file-name">' + WA.escapeHtml(file.name) + '</span>' +
          '<span class="file-meta">' +
            '<span>' + (file.ext || '?').toUpperCase() + '</span>' +
            '<span>' + WA.fmtSize(file.size) + '</span>' +
            '<span><strong>' + file.wordCount + '</strong> words</span>' +
            '<span>' + file.charCount + ' chars</span>' +
          '</span>' +
          '<span class="file-status ' + file.status + '">' + statusLabel +
            (file.ocrConfidence != null ? ' · OCR ' + Math.round(file.ocrConfidence) + '%' : '') +
            (file.error ? ' · ' + WA.escapeHtml(file.error) : '') +
          '</span>' +
          '<span class="file-actions">' +
            '<button data-act="reprocess">Reprocess</button>' +
            '<button data-act="remove">Remove</button>' +
          '</span>' +
        '</li>';
    }).join('');

    list.querySelectorAll('.file-item').forEach(item => {
      const id = item.dataset.id;

      item.addEventListener('click', event => {
        if (event.target.closest('.file-actions')) return;
        if (event.ctrlKey || event.metaKey){
          state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
        } else {
          state.activeId = id;
        }
        renderFileList();
        renderEditor();
        refreshViews();
      });

      item.querySelectorAll('button[data-act]').forEach(button => {
        button.addEventListener('click', async event => {
          event.stopPropagation();
          const file = state.files.find(f => f.id === id);
          if (!file) return;

          if (button.dataset.act === 'remove'){
            state.files = state.files.filter(f => f.id !== id);
            state.selected.delete(id);
            if (state.activeId === id) state.activeId = state.files[0] ? state.files[0].id : null;
            refreshAll();
            return;
          }

          file.text = '';
          file.status = 'pending';
          file.progress = 0;
          file.error = null;
          file.wordCount = 0;
          file.charCount = 0;
          renderFileList();
          WA.Upload.enqueue([file]);
        });
      });
    });
  }

  function updateCounts(){
    const counts = { all: state.files.length, pdf: 0, image: 0, doc: 0, text: 0 };
    state.files.forEach(file => {
      const kind = fileKind(file);
      if (kind in counts) counts[kind]++;
    });
    Object.keys(counts).forEach(key => {
      const el = document.querySelector('[data-count="' + key + '"]');
      if (el) el.textContent = counts[key];
    });
  }

  function updateCenter(){
    const hasFiles = state.files.length > 0;
    const drop = $('#dropZone');
    const views = $('#views');
    if (drop) drop.classList.toggle('hidden', hasFiles);
    if (views) views.classList.toggle('hidden', !hasFiles);
  }

  /* ============================================================
     EDITOR
     ============================================================ */
  function renderEditor(){
    const file = activeFile();
    const editor = $('#editor');
    if (!editor) return;

    if (!file){
      editor.value = '';
      const highlight = $('#highlight');
      if (highlight) highlight.innerHTML = '';
      const gutter = $('#gutterInner');
      if (gutter) gutter.textContent = '';
      return;
    }

    editor.value = file.text || '';
    editor.dir = file.dir || 'ltr';
    const highlight = $('#highlight');
    if (highlight) highlight.setAttribute('dir', file.dir || 'ltr');

    renderHighlight(editor.value);
    renderGutter(editor.value);

    if (state.lastSearch) highlightMatches();
    syncScroll();
  }

  function renderGutter(text){
    const gutter = $('#gutter');
    if (!gutter) return;
    if (!state.showLines){ gutter.classList.add('hidden'); return; }
    gutter.classList.remove('hidden');

    const lines = (text.match(/\n/g) || []).length + 1;
    const parts = [];
    for (let i = 1; i <= lines; i++) parts.push(i);
    const inner = $('#gutterInner');
    if (inner) inner.textContent = parts.join('\n');
  }

  function renderHighlight(text){
    const highlight = $('#highlight');
    if (!highlight) return;
    if (text.length > 400000){ highlight.textContent = text; return; }
    highlight.innerHTML = WA.escapeHtml(text);
  }

  function buildRegex(query, caseSensitive, wholeWord, useRegex){
    if (!query) return null;
    let source = useRegex ? query : WA.escapeRegex(query);
    if (wholeWord && !useRegex) source = '\\b(?:' + source + ')\\b';
    try {
      return new RegExp(source, 'g' + (caseSensitive ? '' : 'i'));
    } catch(err){
      return null;
    }
  }

  function highlightMatches(){
    const file = activeFile();
    const highlight = $('#highlight');
    if (!file || !highlight) return;

    const query = state.lastSearch;
    if (!query){ renderHighlight(file.text); return; }

    const regex = buildRegex(query, false, false, false);
    if (!regex) return;

    const text = file.text || '';
    if (text.length > 400000){ highlight.textContent = text; return; }

    let html = '';
    let last = 0;
    let index = 0;
    let match;

    while ((match = regex.exec(text)) !== null){
      if (match.index === regex.lastIndex) regex.lastIndex++;
      html += WA.escapeHtml(text.slice(last, match.index));
      html += '<mark class="hl' + (index === state.resultIndex ? ' active' : '') + '">' +
              WA.escapeHtml(match[0]) + '</mark>';
      last = match.index + match[0].length;
      index++;
      if (index > 5000) break;
    }
    html += WA.escapeHtml(text.slice(last));
    highlight.innerHTML = html;
  }

  function syncScroll(){
    const editor = $('#editor');
    const highlight = $('#highlight');
    const gutter = $('#gutterInner');
    if (!editor || !highlight || !gutter) return;
    highlight.style.transform = 'translate(' + (-editor.scrollLeft) + 'px, ' + (-editor.scrollTop) + 'px)';
    gutter.style.transform = 'translateY(' + (-editor.scrollTop) + 'px)';
  }

  function bindEditor(){
    const editor = $('#editor');
    if (!editor) return;

    editor.addEventListener('input', WA.debounce(() => {
      const file = activeFile();
      if (!file) return;

      state.editorUndo.push(file.text);
      if (state.editorUndo.length > 200) state.editorUndo.shift();
      state.editorRedo.length = 0;

      file.text = editor.value;
      file.wordCount = countWords(file.text);
      file.charCount = file.text.length;

      renderGutter(file.text);
      if (state.lastSearch) highlightMatches();
      else renderHighlight(file.text);
      syncScroll();

      updateCounts();
      refreshStatsOnly();
      scheduleFileList();
    }, 160));

    editor.addEventListener('scroll', syncScroll);
    editor.addEventListener('keydown', event => {
      if (event.key === 'Tab'){
        event.preventDefault();
        editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
        editor.dispatchEvent(new Event('input'));
      }
    });

    window.addEventListener('resize', syncScroll);
  }

  /* ============================================================
     TEXT DIRECTION / REVERSAL
     ============================================================ */
  function setDirection(dir){
    const file = activeFile();
    if (!file) return;
    file.dir = dir;
    state.defaultDir = dir;
    WA.Prefs.set('dir', dir);

    const editor = $('#editor');
    if (editor) editor.dir = dir;
    const highlight = $('#highlight');
    if (highlight) highlight.setAttribute('dir', dir);

    WA.$$('#btnLtr, #btnRtl').forEach(btn => btn.classList.remove('active'));
    const active = dir === 'rtl' ? $('#btnRtl') : $('#btnLtr');
    if (active) active.classList.add('active');
  }

  function transformActive(transform, label){
    const file = activeFile();
    if (!file || !file.text) { WA.toast('No text to transform', 'err'); return; }

    state.editorUndo.push(file.text);
    file.text = transform(file.text);
    file.wordCount = countWords(file.text);
    file.charCount = file.text.length;

    renderEditor();
    refreshViews();
    renderFileList();
    WA.toast(label + ' applied', 'ok');
  }

  function restoreOriginal(){
    const file = activeFile();
    if (!file || !file.originalText){ WA.toast('No original text stored', 'err'); return; }
    state.editorUndo.push(file.text);
    file.text = file.originalText;
    file.wordCount = countWords(file.text);
    file.charCount = file.text.length;
    renderEditor();
    refreshViews();
    renderFileList();
    WA.toast('Original text restored', 'ok');
  }

  /* ============================================================
     STATISTICS
     ============================================================ */
  function computeStats(text){
    text = text || '';

    const words = text.match(WORD_RE) || [];
    const wordCount = words.length;

    const letters = countLetters(text);
    const numbers = (text.match(/\p{N}/gu) || (text.match(/[0-9]/g) || [])).length;

    const spaces = (text.match(/[ \t]/g) || []).length;
    const newlines = (text.match(/\n/g) || []).length;
    const lines = text.length ? text.split('\n').length : 0;
    const paragraphs = text.split(/\n\s*\n/).filter(block => block.trim().length).length;
    const sentences = countSentences(text);

    const punctuation = (text.match(/[.,;:!?'"()[\]{}\-–—…\/\\\u061F\u06D4]/g) || []).length;
    const symbols = (text.match(/[^\p{L}\p{N}\s.,;:!?'"()[\]{}\-–—…\/\\\u061F\u06D4]/gu) || []).length;

    const chars = text.length;
    const charsNoSpace = text.replace(/\s/g, '').length;

    const freq = new Map();
    words.forEach(word => {
      const key = word.toLowerCase();
      freq.set(key, (freq.get(key) || 0) + 1);
    });

    const letterFreq = new Map();
    const lower = text.toLowerCase();
    for (const char of lower){
      if (/\p{L}/u.test(char)){
        letterFreq.set(char, (letterFreq.get(char) || 0) + 1);
      }
    }

    return {
      words: wordCount,
      uniqueWords: freq.size,
      letters,
      numbers,
      spaces,
      newlines,
      lines,
      paragraphs,
      sentences,
      punctuation,
      symbols,
      chars,
      charsNoSpace,
      freq,
      letterFreq
    };
  }

  function scopedStats(scope){
    const files = filesInScope(scope);
    const text = files.map(file => file.text || '').join('\n');
    return { stats: computeStats(text), files };
  }

  /* ============================================================
     SEARCH
     ============================================================ */
  function performSearch(query, options){
    options = options || {};
    const caseSensitive = !!options.caseSensitive;
    const wholeWord = !!options.wholeWord;
    const useRegex = !!options.useRegex;
    const scope = options.scope || state.scope;

    state.lastSearch = query;
    state.results = [];
    state.resultIndex = -1;

    if (!query){
      renderResults();
      highlightMatches();
      syncResultUI();
      return;
    }

    const targets = filesInScope(scope);

    for (const file of targets){
      const text = file.text || '';
      if (!text) continue;

      const regex = buildRegex(query, caseSensitive, wholeWord, useRegex);
      if (!regex){ WA.toast('Invalid regular expression', 'err'); return; }

      let match;
      while ((match = regex.exec(text)) !== null){
        if (match.index === regex.lastIndex) regex.lastIndex++;

        const start = Math.max(0, match.index - 60);
        const end = Math.min(text.length, match.index + match[0].length + 60);

        let location = 'Line ' + (text.slice(0, match.index).split('\n').length);
        const pageMatches = text.slice(0, match.index).match(/\[Page (\d+)/g);
        if (pageMatches && pageMatches.length){
          location = 'Page ' + pageMatches[pageMatches.length - 1].match(/\d+/)[0];
        }

        state.results.push({
          fileId: file.id,
          fileName: file.name,
          loc: location,
          match: match[0],
          before: text.slice(start, match.index),
          after: text.slice(match.index + match[0].length, end),
          index: match.index,
          globalIndex: state.results.length
        });

        if (state.results.length > 5000) break;
      }
      if (state.results.length > 5000) break;
    }

    if (state.results.length) state.resultIndex = 0;

    renderResults();
    highlightMatches();
    syncResultUI();
  }

  function syncResultUI(){
    const total = state.results.length;
    const index = state.resultIndex;
    const label = total === 0 ? '0 results' : 'Result ' + (index + 1) + ' of ' + total;

    const counter = $('#quickCounter');
    if (counter) counter.textContent = label;

    const meta = $('#resultsMeta');
    if (meta){
      meta.textContent = total === 0
        ? (state.lastSearch ? 'No matches.' : 'No search yet.')
        : total + ' matches across ' + new Set(state.results.map(r => r.fileId)).size + ' file(s)';
    }
  }

  function renderResults(){
    const list = $('#resultsList');
    if (!list) return;

    list.innerHTML = state.results.slice(0, 300).map(result =>
      '<li class="result-item ' + (result.globalIndex === state.resultIndex ? 'active' : '') + '" data-index="' + result.globalIndex + '">' +
        '<span class="result-file">' + WA.escapeHtml(result.fileName) + ' · ' + WA.escapeHtml(result.loc) + '</span>' +
        '<span class="result-ctx">…' + WA.escapeHtml(result.before) +
          '<mark class="' + (result.globalIndex === state.resultIndex ? 'active' : '') + '">' +
          WA.escapeHtml(result.match) + '</mark>' +
          WA.escapeHtml(result.after) + '…</span>' +
      '</li>'
    ).join('');

    list.querySelectorAll('.result-item').forEach(item => {
      item.addEventListener('click', () => jumpToResult(Number(item.dataset.index)));
    });
  }

  function jumpToResult(index){
    if (index < 0 || index >= state.results.length) return;
    state.resultIndex = index;
    const result = state.results[index];

    if (result.fileId !== state.activeId){
      state.activeId = result.fileId;
      renderFileList();
      renderEditor();
    }

    const editor = $('#editor');
    if (!editor) return;

    editor.focus();
    editor.setSelectionRange(result.index, result.index + result.match.length);

    const line = editor.value.slice(0, result.index).split('\n').length;
    editor.scrollTop = Math.max(0, (line - 6) * 19.4);
    syncScroll();
    highlightMatches();
    renderResults();
    syncResultUI();
  }

  function nextResult(){
    if (!state.results.length) return;
    jumpToResult((state.resultIndex + 1) % state.results.length);
  }

  function prevResult(){
    if (!state.results.length) return;
    jumpToResult((state.resultIndex - 1 + state.results.length) % state.results.length);
  }

  /* ============================================================
     REPLACE
     ============================================================ */
  function performReplace(find, replacement, options){
    options = options || {};
    const caseSensitive = !!options.caseSensitive;
    const wholeWord = !!options.wholeWord;
    const useRegex = !!options.useRegex;
    const scope = options.scope || state.scope;
    const all = !!options.all;

    if (!find){ WA.toast('Enter text to find', 'err'); return 0; }

    const globalRegex = buildRegex(find, caseSensitive, wholeWord, useRegex);
    if (!globalRegex){ WA.toast('Invalid regular expression', 'err'); return 0; }

    const targets = filesInScope(scope);
    const snapshot = targets.map(file => ({ id: file.id, text: file.text }));
    let total = 0;

    const singleRegex = all
      ? globalRegex
      : new RegExp(globalRegex.source, globalRegex.flags.replace('g', ''));

    for (const file of targets){
      const text = file.text || '';
      if (!text) continue;

      const matches = text.match(globalRegex);
      if (!matches) continue;

      if (all){
        file.text = text.replace(globalRegex, replacement);
        total += matches.length;
      } else {
        file.text = text.replace(singleRegex, replacement);
        total += 1;
        if (scope === 'current') break;
      }

      file.wordCount = countWords(file.text);
      file.charCount = file.text.length;
    }

    if (total > 0){
      state.replaceStack.push({ snapshots: snapshot, label: total + ' replacement(s)' });
      if (state.replaceStack.length > 40) state.replaceStack.shift();
    }
    return total;
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

  function switchView(view){
    if (!VIEW_IDS[view]) return;
    state.view = view;

    WA.$$('.view').forEach(el => el.classList.add('hidden'));
    const el = document.getElementById(VIEW_IDS[view]);
    if (el) el.classList.remove('hidden');

    WA.$$('.side-nav .side-link[data-view]').forEach(link => {
      link.classList.toggle('active', link.dataset.view === view);
    });

    refreshViews();
  }

  function refreshViews(){
    try {
      const { stats } = scopedStats();
      renderLiveStats(stats);
      renderStatusBar(stats);

      if (state.view === 'overview') renderDashboard(stats);
      if (state.view === 'frequency') renderFrequency(stats);
      if (state.view === 'allwords') renderAllWords(stats);
      if (state.view === 'letters') renderLetters(stats);
      if (state.view === 'sentences') renderSentences();
      if (state.view === 'characters') renderCharacters(stats);
      if (state.view === 'perfile') renderPerFile();
    } catch(err){
      WA.log('refreshViews error', err);
    }
  }

  function refreshStatsOnly(){
    try {
      const { stats } = scopedStats();
      renderLiveStats(stats);
      renderStatusBar(stats);
      if (state.view === 'overview') renderDashboard(stats);
      if (state.view === 'characters') renderCharacters(stats);
    } catch(err){
      WA.log('refreshStatsOnly error', err);
    }
  }

  function topEntry(map){
    let bestKey = null;
    let bestValue = 0;
    if (map instanceof Map){
      for (const [key, value] of map){
        if (value > bestValue){ bestKey = key; bestValue = value; }
      }
    }
    return bestKey !== null ? [bestKey, bestValue] : null;
  }

  function renderLiveStats(stats){
    const el = $('#liveStats');
    if (!el) return;

    const mostWord = topEntry(stats.freq);
    const mostLetter = topEntry(stats.letterFreq);

    const rows = [
      ['Words', stats.words.toLocaleString()],
      ['Unique words', stats.uniqueWords.toLocaleString()],
      ['Letters', stats.letters.toLocaleString()],
      ['Characters', stats.chars.toLocaleString()],
      ['Characters (no spaces)', stats.charsNoSpace.toLocaleString()],
      ['Sentences', stats.sentences.toLocaleString()],
      ['Paragraphs', stats.paragraphs.toLocaleString()],
      ['Lines', stats.lines.toLocaleString()],
      ['Numbers', stats.numbers.toLocaleString()],
      ['Symbols', stats.symbols.toLocaleString()],
      ['Punctuation', stats.punctuation.toLocaleString()],
      ['Spaces', stats.spaces.toLocaleString()],
      ['Most used word', mostWord ? mostWord[0] + ' (' + mostWord[1] + ')' : '—'],
      ['Most used letter', mostLetter ? mostLetter[0] + ' (' + mostLetter[1] + ')' : '—']
    ];

    el.innerHTML = rows.map(([key, value]) =>
      '<div class="stat-row"><span class="k">' + key + '</span><span class="v">' + value + '</span></div>'
    ).join('');
  }

  function renderStatusBar(stats){
    const el = $('#statusBar');
    if (!el) return;
    el.textContent = state.files.length + ' files · ' +
      stats.words.toLocaleString() + ' words · ' +
      stats.letters.toLocaleString() + ' letters · ' +
      stats.sentences.toLocaleString() + ' sentences';
  }

  function renderDashboard(stats){
    const host = $('#dashGrid');
    if (!host) return;

    const avgWord = stats.words > 0 ? (stats.letters / stats.words) : 0;
    const readingMinutes = stats.words > 0 ? Math.max(1, Math.round(stats.words / 200)) : 0;
    const mostWord = topEntry(stats.freq);

    const cards = [
      ['Words', stats.words.toLocaleString()],
      ['Characters', stats.chars.toLocaleString()],
      ['Sentences', stats.sentences.toLocaleString()],
      ['Paragraphs', stats.paragraphs.toLocaleString()],
      ['Unique words', stats.uniqueWords.toLocaleString()],
      ['Avg word length', avgWord.toFixed(2)],
      ['Reading time', readingMinutes + ' min'],
      ['Files', state.files.length],
      ['Most used word', mostWord ? mostWord[0] : '—', true]
    ];

    host.innerHTML = cards.map(([label, value, small]) =>
      '<div class="dash-card">' +
        '<span class="dash-label">' + label + '</span>' +
        '<span class="dash-value ' + (small ? 'small' : '') + '">' + value + '</span>' +
      '</div>'
    ).join('');

    if (WA.UI && typeof WA.UI.drawDashboardCharts === 'function'){
      WA.UI.drawDashboardCharts(stats);
    }
  }

  function renderFrequency(stats){
    const ignore = $('#ignoreCommon') && $('#ignoreCommon').checked;
    let entries = Array.from(stats.freq.entries());

    if (ignore){
      entries = entries.filter(([word]) => !COMMON_WORDS.has(word) && word.length > 1);
    }
    entries.sort((a, b) => b[1] - a[1]);

    const topSelect = $('#freqTop');
    const limit = topSelect ? topSelect.value : '25';
    const visible = limit === 'all' ? entries : entries.slice(0, Number(limit));

    const total = Array.from(stats.freq.values()).reduce((sum, n) => sum + n, 0) || 1;
    const max = visible.length ? visible[0][1] : 1;

    const tbody = $('#freqTable tbody');
    if (tbody){
      tbody.innerHTML = visible.map(([word, count], index) =>
        '<tr>' +
          '<td>' + (index + 1) + '</td>' +
          '<td><button class="word-link" data-word="' + WA.escapeHtml(word) + '">' + WA.escapeHtml(word) + '</button></td>' +
          '<td>' + count.toLocaleString() + '</td>' +
          '<td>' + (count / total * 100).toFixed(2) + '%</td>' +
          '<td><div class="bar-mini" style="width:' + Math.min(110, count / max * 110) + 'px"></div></td>' +
        '</tr>'
      ).join('') || '<tr><td colspan="5">No words.</td></tr>';

      tbody.querySelectorAll('.word-link').forEach(button => {
        button.addEventListener('click', () => {
          const query = button.dataset.word;
          const input = $('#quickSearch');
          if (input) input.value = query;
          switchView('editor');
          performSearch(query, { scope: state.scope });
        });
      });
    }

    if (WA.UI && typeof WA.UI.drawWordCloud === 'function'){
      WA.UI.drawWordCloud(visible);
    }
  }

  function renderAllWords(stats){
    const host = $('#allWordsList');
    if (!host) return;

    const query = ($('#allWordsSearch') ? $('#allWordsSearch').value : '').toLowerCase().trim();
    const sort = $('#allWordsSort') ? $('#allWordsSort').value : 'az';

    let entries = Array.from(stats.freq.entries());
    if (query) entries = entries.filter(([word]) => word.includes(query));

    if (sort === 'az') entries.sort((a, b) => a[0].localeCompare(b[0]));
    else if (sort === 'za') entries.sort((a, b) => b[0].localeCompare(a[0]));
    else if (sort === 'desc') entries.sort((a, b) => b[1] - a[1]);
    else entries.sort((a, b) => a[1] - b[1]);

    host.innerHTML = entries.slice(0, 2000).map(([word, count]) =>
      '<button class="chip" data-word="' + WA.escapeHtml(word) + '">' +
        WA.escapeHtml(word) + '<b>' + count + '</b>' +
      '</button>'
    ).join('') || '<p class="meta">No words.</p>';

    host.querySelectorAll('.chip').forEach(button => {
      button.addEventListener('click', () => {
        const value = button.dataset.word;
        const input = $('#quickSearch');
        if (input) input.value = value;
        switchView('editor');
        performSearch(value, { scope: state.scope });
      });
    });
  }

  function renderLetters(stats){
    const summary = $('#letterSummary');
    const chart = $('#letterChart');
    const tbody = $('#letterTable tbody');

    const entries = Array.from(stats.letterFreq.entries()).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, count]) => sum + count, 0) || 1;
    const max = entries.length ? entries[0][1] : 1;

    if (summary){
      summary.innerHTML =
        '<span>Total letters: <b>' + total.toLocaleString() + '</b></span>' +
        '<span>Most frequent: <b>' + (entries[0] ? entries[0][0] : '—') + '</b></span>' +
        '<span>Least frequent: <b>' + (entries.length ? entries[entries.length - 1][0] : '—') + '</b></span>';
    }

    if (chart){
      chart.innerHTML = entries.slice(0, 26).map(([letter, count]) => {
        const height = Math.max(2, Math.round(count / max * 110));
        return '<div class="letter-bar" style="height:' + height + 'px" title="' + WA.escapeHtml(letter) + ': ' + count + '">' +
          '<span>' + WA.escapeHtml(letter.toUpperCase()) + '</span>' +
        '</div>';
      }).join('');
    }

    if (tbody){
      tbody.innerHTML = entries.slice(0, 100).map(([letter, count]) =>
        '<tr>' +
          '<td>' + WA.escapeHtml(letter.toUpperCase()) + '</td>' +
          '<td>' + count.toLocaleString() + '</td>' +
          '<td>' + (count / total * 100).toFixed(2) + '%</td>' +
          '<td><div class="bar-mini" style="width:' + Math.min(120, count / max * 120) + 'px"></div></td>' +
        '</tr>'
      ).join('') || '<tr><td colspan="4">No letters.</td></tr>';
    }
  }

  function renderSentences(){
    const files = filesInScope();
    const all = [];

    for (const file of files){
      const text = file.text || '';
      if (!text.trim()) continue;

      let match;
      let order = 0;
      const regex = new RegExp(SENTENCE_RE.source, 'g');

      while ((match = regex.exec(text)) !== null){
        const sentence = match[0].trim();
        if (!sentence) continue;

        let location = 'Line ' + (text.slice(0, match.index).split('\n').length);
        const pageMatches = text.slice(0, match.index).match(/\[Page (\d+)/g);
        if (pageMatches && pageMatches.length){
          location = 'Page ' + pageMatches[pageMatches.length - 1].match(/\d+/)[0];
        }

        all.push({
          text: sentence,
          words: countWords(sentence),
          chars: sentence.length,
          file: file.name,
          loc: location,
          order: order++
        });
      }

      if (all.length === 0){
        text.split('\n').forEach((line, index) => {
          const sentence = line.trim();
          if (!sentence) return;
          all.push({
            text: sentence,
            words: countWords(sentence),
            chars: sentence.length,
            file: file.name,
            loc: 'Line ' + (index + 1),
            order: order++
          });
        });
      }
    }

    const sort = $('#sentSort') ? $('#sentSort').value : 'orig';
    const sorted = all.slice();

    if (sort === 'long') sorted.sort((a, b) => b.chars - a.chars);
    else if (sort === 'short') sorted.sort((a, b) => a.chars - b.chars);
    else if (sort === 'most') sorted.sort((a, b) => b.words - a.words);
    else if (sort === 'few') sorted.sort((a, b) => a.words - b.words);

    const total = $('#sentTotal');
    if (total) total.textContent = 'Total sentences: ' + all.length.toLocaleString();

    const list = $('#sentList');
    if (!list) return;

    list.innerHTML = sorted.slice(0, 2000).map(sentence =>
      '<li>' +
        WA.escapeHtml(sentence.text.slice(0, 400)) + (sentence.text.length > 400 ? '…' : '') +
        '<div class="sent-meta">' +
          '<span>' + sentence.words + ' words</span>' +
          '<span>' + sentence.chars + ' chars</span>' +
          '<span>' + WA.escapeHtml(sentence.file) + '</span>' +
          '<span>' + WA.escapeHtml(sentence.loc) + '</span>' +
        '</div>' +
      '</li>'
    ).join('') || '<li style="list-style:none;padding:0;">No sentences found.</li>';
  }

  function renderCharacters(stats){
    const host = $('#charGrid');
    if (!host) return;

    const cards = [
      ['Letters', stats.letters],
      ['Numbers', stats.numbers],
      ['Spaces', stats.spaces],
      ['Punctuation', stats.punctuation],
      ['Symbols', stats.symbols],
      ['New lines', stats.newlines],
      ['Total characters', stats.chars],
      ['Characters (no spaces)', stats.charsNoSpace]
    ];

    host.innerHTML = cards.map(([label, value]) =>
      '<div class="char-card"><span class="k">' + label + '</span><span class="v">' + value.toLocaleString() + '</span></div>'
    ).join('');
  }

  function renderPerFile(){
    const tbody = $('#perFileTable tbody');
    if (!tbody) return;

    tbody.innerHTML = state.files.map(file => {
      const stats = computeStats(file.text || '');
      return '<tr>' +
        '<td>' + WA.escapeHtml(file.name) + '</td>' +
        '<td>' + (file.ext || '?').toUpperCase() + '</td>' +
        '<td>' + stats.words.toLocaleString() + '</td>' +
        '<td>' + stats.letters.toLocaleString() + '</td>' +
        '<td>' + stats.sentences.toLocaleString() + '</td>' +
        '<td>' + stats.chars.toLocaleString() + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="6">No files.</td></tr>';

    const total = computeStats(state.files.map(file => file.text || '').join('\n'));
    const totalRow = $('#perFileTotal');
    if (totalRow){
      totalRow.innerHTML =
        '<span>TOTAL</span>' +
        '<span>Words: ' + total.words.toLocaleString() + '</span>' +
        '<span>Letters: ' + total.letters.toLocaleString() + '</span>' +
        '<span>Sentences: ' + total.sentences.toLocaleString() + '</span>' +
        '<span>Characters: ' + total.chars.toLocaleString() + '</span>';
    }
  }

  /* ============================================================
     EXPORT
     ============================================================ */
  function exportData(kind){
    const { stats } = scopedStats();

    if (kind === 'txt'){
      const text = filesInScope().map(file => '===== ' + file.name + ' =====\n' + file.text).join('\n\n');
      WA.download('extracted_text.txt', text);
      WA.toast('Exported extracted text', 'ok');
    }
    else if (kind === 'edited'){
      const file = activeFile();
      WA.download((file ? file.name.replace(/\.[^.]+$/, '') : 'edited') + '_edited.txt', file ? file.text : '');
      WA.toast('Exported edited text', 'ok');
    }
    else if (kind === 'freq'){
      const entries = Array.from(stats.freq.entries()).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((sum, [, count]) => sum + count, 0) || 1;
      const rows = [['Rank', 'Word', 'Count', 'Percentage']];
      entries.forEach(([word, count], index) => {
        rows.push([index + 1, word, count, (count / total * 100).toFixed(3) + '%']);
      });
      WA.download('word_frequency.csv', WA.toCSV(rows), 'text/csv');
      WA.toast('Exported word frequency', 'ok');
    }
    else if (kind === 'stats'){
      const rows = [
        ['Metric', 'Value'],
        ['Files', state.files.length],
        ['Words', stats.words],
        ['Unique words', stats.uniqueWords],
        ['Letters', stats.letters],
        ['Numbers', stats.numbers],
        ['Spaces', stats.spaces],
        ['Punctuation', stats.punctuation],
        ['Symbols', stats.symbols],
        ['Lines', stats.lines],
        ['Paragraphs', stats.paragraphs],
        ['Sentences', stats.sentences],
        ['Characters', stats.chars],
        ['Characters (no spaces)', stats.charsNoSpace]
      ];
      WA.download('statistics.csv', WA.toCSV(rows), 'text/csv');
      WA.toast('Exported statistics', 'ok');
    }
    else if (kind === 'results'){
      const rows = [['File', 'Location', 'Match', 'Context']];
      state.results.forEach(result => {
        rows.push([result.fileName, result.loc, result.match, '…' + result.before + '[' + result.match + ']' + result.after + '…']);
      });
      WA.download('search_results.csv', WA.toCSV(rows), 'text/csv');
      WA.toast('Exported search results', 'ok');
    }
    else if (kind === 'words'){
      const entries = Array.from(stats.freq.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      const rows = [['Word', 'Count']];
      entries.forEach(([word, count]) => rows.push([word, count]));
      WA.download('all_words.csv', WA.toCSV(rows), 'text/csv');
      WA.toast('Exported all words', 'ok');
    }
    else if (kind === 'sentences'){
      const rows = [['#', 'File', 'Location', 'Words', 'Chars', 'Sentence']];
      let index = 1;
      filesInScope().forEach(file => {
        const text = file.text || '';
        let match;
        const regex = new RegExp(SENTENCE_RE.source, 'g');
        while ((match = regex.exec(text)) !== null){
          const sentence = match[0].trim();
          if (!sentence) continue;
          rows.push([index++, file.name, 'Line ' + (text.slice(0, match.index).split('\n').length), countWords(sentence), sentence.length, sentence]);
        }
      });
      WA.download('sentences.csv', WA.toCSV(rows), 'text/csv');
      WA.toast('Exported sentences', 'ok');
    }
    else if (kind === 'report'){
      const mostWord = topEntry(stats.freq);
      const mostLetter = topEntry(stats.letterFreq);
      const lines = [
        'WORDANALYZER — ANALYSIS REPORT',
        'Generated: ' + new Date().toLocaleString(),
        '',
        'FILES',
        ...state.files.map(file => '  ' + file.name + ' [' + file.ext.toUpperCase() + '] ' + file.status + ' ' + file.wordCount + ' words' + (file.error ? ' (' + file.error + ')' : '')),
        '',
        'STATISTICS',
        '  Words: ' + stats.words,
        '  Unique words: ' + stats.uniqueWords,
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
        'Most used word: ' + (mostWord ? mostWord[0] + ' (' + mostWord[1] + ')' : '—'),
        'Most used letter: ' + (mostLetter ? mostLetter[0] + ' (' + mostLetter[1] + ')' : '—'),
        '',
        'TOP 25 WORDS',
        ...Array.from(stats.freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 25)
          .map(([word, count], index) => '  ' + String(index + 1).padStart(3) + '. ' + word.padEnd(20) + ' ' + count)
      ];
      WA.download('analysis_report.txt', lines.join('\n'));
      WA.toast('Exported report', 'ok');
    }
    else if (kind === 'pdf'){
      generatePDF();
    }
  }

  function generatePDF(){
    if (!window.jspdf || !window.jspdf.jsPDF){ WA.toast('PDF library not loaded', 'err'); return; }

    const { jsPDF } = window.jspdf;
    const file = activeFile();
    const text = file ? file.text : filesInScope().map(f => f.text).join('\n\n');

    if (!text.trim()){ WA.toast('No text to export', 'err'); return; }

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 48;
    const maxWidth = pageWidth - margin * 2;
    const lineHeight = 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    let y = margin;

    for (const paragraph of text.split(/\n/)){
      const lines = doc.splitTextToSize(paragraph || ' ', maxWidth);
      for (const line of lines){
        if (y + lineHeight > pageHeight - margin){ doc.addPage(); y = margin; }
        doc.text(line, margin, y);
        y += lineHeight;
      }
    }

    doc.save('generated.pdf');
    WA.toast('Generated PDF (original layout not preserved)', 'ok');
  }

  /* ============================================================
     SCOPE SWITCH
     ============================================================ */
  function renderScopes(){
    WA.$$('.scope-switch').forEach(host => {
      if (!host.dataset.rendered){
        host.dataset.rendered = '1';
        host.innerHTML =
          '<button data-scope="current">Current file</button>' +
          '<button data-scope="selected">Selected files</button>' +
          '<button data-scope="all">All files</button>';
      }

      host.querySelectorAll('button').forEach(button => {
        button.classList.toggle('active', button.dataset.scope === state.scope);
        if (button.dataset.bound) return;
        button.dataset.bound = '1';
        button.addEventListener('click', () => {
          state.scope = button.dataset.scope;
          WA.$$('.scope-switch button').forEach(item => {
            item.classList.toggle('active', item.dataset.scope === state.scope);
          });
          refreshViews();
          if (state.lastSearch) performSearch(state.lastSearch, { scope: state.scope });
        });
      });
    });
  }

  /* ============================================================
     SELF TEST
     ============================================================ */
  async function selfTest(){
    WA.log('===== SELF TEST =====');
    const sample = 'Hello world. This is a test. اردو متن یہاں ہے۔ کیا یہ کام کرتا ہے؟';
    const expectedWords = 15;

    try {
      WA.log('Word count:', countWords(sample), '(expected ~' + expectedWords + ')');
      WA.log('Sentence count:', countSentences(sample));
      WA.log('Letter count:', countLetters(sample));
      WA.log('Reverse:', WA.reverseText('abc').slice(0, 3));
      WA.log('Reverse words:', WA.reverseWordOrder('one two three'));
      WA.log('Libraries', {
        pdfjs: typeof pdfjsLib !== 'undefined',
        tesseract: typeof Tesseract !== 'undefined',
        mammoth: typeof mammoth !== 'undefined',
        xlsx: typeof XLSX !== 'undefined',
        jszip: typeof JSZip !== 'undefined',
        jspdf: typeof window.jspdf !== 'undefined'
      });
      WA.log('===== SELF TEST DONE =====');
      WA.toast('Self-test written to debug log', 'ok');
    } catch(err){
      WA.log('SELF TEST FAILED', err);
      WA.toast('Self-test failed', 'err');
    }
  }

  /* ============================================================
     REFRESH
     ============================================================ */
  function refreshAll(){
    renderFileList();
    updateCounts();
    updateCenter();
    renderEditor();
    refreshViews();
    if (WA.UI && typeof WA.UI.updateHomeStats === 'function') WA.UI.updateHomeStats();
  }

  function bindAnalyzer(){
    const editor = $('#editor');
    if (editor){
      const buttons = {
        undo: $('#btnUndo'),
        redo: $('#btnRedo'),
        copy: $('#btnCopy'),
        cut: $('#btnCut'),
        paste: $('#btnPaste'),
        wrap: $('#btnWrap'),
        lines: $('#btnLines'),
        ltr: $('#btnLtr'),
        rtl: $('#btnRtl'),
        reverse: $('#btnReverse'),
        reverseWords: $('#btnReverseWords'),
        restore: $('#btnRestore')
      };

      if (buttons.undo) buttons.undo.addEventListener('click', () => {
        const file = activeFile();
        if (!file || !state.editorUndo.length) return;
        state.editorRedo.push(file.text);
        file.text = state.editorUndo.pop();
        file.wordCount = countWords(file.text);
        file.charCount = file.text.length;
        renderEditor();
        refreshStatsOnly();
        renderFileList();
      });

      if (buttons.redo) buttons.redo.addEventListener('click', () => {
        const file = activeFile();
        if (!file || !state.editorRedo.length) return;
        state.editorUndo.push(file.text);
        file.text = state.editorRedo.pop();
        file.wordCount = countWords(file.text);
        file.charCount = file.text.length;
        renderEditor();
        refreshStatsOnly();
        renderFileList();
      });

      if (buttons.copy) buttons.copy.addEventListener('click', async () => {
        const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
        try {
          await navigator.clipboard.writeText(selected || editor.value);
          WA.toast('Copied', 'ok');
        } catch(err){ WA.toast('Clipboard unavailable', 'err'); }
      });

      if (buttons.cut) buttons.cut.addEventListener('click', async () => {
        const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
        if (!selected) return;
        try {
          await navigator.clipboard.writeText(selected);
          editor.setRangeText('', editor.selectionStart, editor.selectionEnd, 'end');
          editor.dispatchEvent(new Event('input'));
          WA.toast('Cut', 'ok');
        } catch(err){ WA.toast('Clipboard unavailable', 'err'); }
      });

      if (buttons.paste) buttons.paste.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
          editor.dispatchEvent(new Event('input'));
        } catch(err){ WA.toast('Clipboard read blocked', 'err'); }
      });

      if (buttons.wrap) buttons.wrap.addEventListener('click', () => {
        state.wrap = !state.wrap;
        $('#editorWrap').classList.toggle('wrap', state.wrap);
        buttons.wrap.classList.toggle('active', state.wrap);
        editor.setAttribute('wrap', state.wrap ? 'soft' : 'off');
        syncScroll();
      });

      if (buttons.lines) buttons.lines.addEventListener('click', () => {
        state.showLines = !state.showLines;
        buttons.lines.classList.toggle('active', state.showLines);
        renderGutter(editor.value);
        syncScroll();
      });

      if (buttons.ltr) buttons.ltr.addEventListener('click', () => setDirection('ltr'));
      if (buttons.rtl) buttons.rtl.addEventListener('click', () => setDirection('rtl'));

      if (buttons.reverse) buttons.reverse.addEventListener('click', () => {
        transformActive(WA.reverseText, 'Reverse text');
      });

      if (buttons.reverseWords) buttons.reverseWords.addEventListener('click', () => {
        transformActive(WA.reverseWordOrder, 'Reverse word order');
      });

      if (buttons.restore) buttons.restore.addEventListener('click', restoreOriginal);
    }

    const quickSearch = $('#quickSearch');
    if (quickSearch){
      const run = WA.debounce(() => performSearch(quickSearch.value, { scope: state.scope }), 200);
      quickSearch.addEventListener('input', run);
      quickSearch.addEventListener('keydown', event => {
        if (event.key === 'Enter'){ event.preventDefault(); event.shiftKey ? prevResult() : nextResult(); }
        if (event.key === 'Escape'){ quickSearch.value = ''; performSearch('', {}); }
      });
    }

    const qPrev = $('#qPrev'); if (qPrev) qPrev.addEventListener('click', prevResult);
    const qNext = $('#qNext'); if (qNext) qNext.addEventListener('click', nextResult);
    const qClear = $('#qClear'); if (qClear) qClear.addEventListener('click', () => {
      const input = $('#quickSearch');
      if (input) input.value = '';
      performSearch('', {});
    });

    const frFind = $('#frFindBtn');
    if (frFind) frFind.addEventListener('click', () => {
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
      const count = performReplace($('#frFind').value, $('#frReplace').value, {
        caseSensitive: $('#frCase').checked,
        wholeWord: $('#frWord').checked,
        useRegex: $('#frRegex').checked,
        scope: state.scope,
        all: false
      });
      $('#frStatus').textContent = count ? count + ' replacement completed.' : 'No matches.';
      renderEditor();
      refreshViews();
      renderFileList();
    });

    const frReplaceAll = $('#frReplaceAll');
    if (frReplaceAll) frReplaceAll.addEventListener('click', async () => {
      const find = $('#frFind').value;
      const replacement = $('#frReplace').value;
      if (!find){ WA.toast('Enter text to find', 'err'); return; }

      const regex = buildRegex(find, $('#frCase').checked, $('#frWord').checked, $('#frRegex').checked);
      if (!regex){ WA.toast('Invalid regular expression', 'err'); return; }

      let count = 0;
      let fileCount = 0;
      filesInScope().forEach(file => {
        regex.lastIndex = 0;
        const matches = (file.text || '').match(regex);
        if (matches){ count += matches.length; fileCount++; }
      });

      const ok = await WA.confirmModal('Replace all?', 'Replace ' + count + ' occurrence(s) across ' + fileCount + ' file(s)?');
      if (!ok) return;

      const replaced = performReplace(find, replacement, {
        caseSensitive: $('#frCase').checked,
        wholeWord: $('#frWord').checked,
        useRegex: $('#frRegex').checked,
        scope: state.scope,
        all: true
      });
      $('#frStatus').textContent = replaced + ' replacements completed.';
      renderEditor();
      refreshViews();
      renderFileList();
      WA.toast(replaced + ' replacements completed.', 'ok');
    });

    const frUndo = $('#frUndo');
    if (frUndo) frUndo.addEventListener('click', () => {
      const last = state.replaceStack.pop();
      if (!last){ WA.toast('Nothing to undo', 'err'); return; }
      last.snapshots.forEach(snapshot => {
        const file = state.files.find(f => f.id === snapshot.id);
        if (file){
          file.text = snapshot.text;
          file.wordCount = countWords(file.text);
          file.charCount = file.text.length;
        }
      });
      $('#frStatus').textContent = 'Replacement undone.';
      renderEditor();
      refreshViews();
      renderFileList();
      WA.toast('Replacement undone', 'ok');
    });

    const ignoreCommon = $('#ignoreCommon');
    if (ignoreCommon) ignoreCommon.addEventListener('change', refreshViews);
    const freqTop = $('#freqTop');
    if (freqTop) freqTop.addEventListener('change', refreshViews);

    const allWordsSearch = $('#allWordsSearch');
    if (allWordsSearch) allWordsSearch.addEventListener('input', WA.debounce(refreshViews, 150));
    const allWordsSort = $('#allWordsSort');
    if (allWordsSort) allWordsSort.addEventListener('change', refreshViews);

    const sentSort = $('#sentSort');
    if (sentSort) sentSort.addEventListener('change', renderSentences);

    WA.$$('[data-export]').forEach(button => {
      button.addEventListener('click', () => exportData(button.dataset.export));
    });

    const selfTestBtn = $('#btnSelfTest');
    if (selfTestBtn) selfTestBtn.addEventListener('click', selfTest);

    const debugBtn = $('#btnDebug');
    if (debugBtn) debugBtn.addEventListener('click', () => {
      const log = $('#debugLog');
      if (log) log.style.display = log.style.display === 'block' ? 'none' : 'block';
    });

    // side nav — filters
    WA.$$('.side-link[data-filter]').forEach(link => {
      link.addEventListener('click', () => {
        WA.$$('.side-link[data-filter]').forEach(item => item.classList.remove('active'));
        link.classList.add('active');
        state.filter = link.dataset.filter;
        renderFileList();
      });
    });

    // side nav — views
    WA.$$('.side-link[data-view]').forEach(link => {
      link.addEventListener('click', () => switchView(link.dataset.view));
    });

    const selectAll = $('#selectAll');
    if (selectAll) selectAll.addEventListener('change', event => {
      state.selected.clear();
      if (event.target.checked) state.files.forEach(file => state.selected.add(file.id));
      renderFileList();
      refreshViews();
    });

    const processAll = $('#btnProcessAll');
    if (processAll) processAll.addEventListener('click', () => {
      state.files.forEach(file => {
        if (file.status !== 'done'){
          file.text = '';
          file.status = 'pending';
          file.progress = 0;
          file.error = null;
          WA.Upload.enqueue([file]);
        }
      });
      WA.toast('Reprocessing all files', 'ok');
    });

    const clearAll = $('#btnClearAll');
    if (clearAll) clearAll.addEventListener('click', async () => {
      if (!state.files.length) return;
      const ok = await WA.confirmModal('Remove all files?', 'This clears all uploaded files and extracted text.');
      if (!ok) return;
      state.files = [];
      state.selected.clear();
      state.activeId = null;
      state.results = [];
      state.lastSearch = '';
      refreshAll();
      renderResults();
      syncResultUI();
    });

    // upload bindings
    const fileInput = $('#fileInput');
    const openUpload = () => fileInput && fileInput.click();

    ['btnUpload', 'btnBrowse', 'heroUpload'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', openUpload);
    });

    if (fileInput){
      fileInput.addEventListener('change', event => {
        addFiles(event.target.files);
        event.target.value = '';
      });
    }

    // drop zones
    ['homeDrop', 'dropZone'].forEach(id => {
      const zone = document.getElementById(id);
      if (!zone) return;

      zone.addEventListener('click', event => {
        if (event.target.closest('button')) return;
        openUpload();
      });

      zone.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' '){
          event.preventDefault();
          openUpload();
        }
      });

      ['dragenter', 'dragover'].forEach(type => {
        zone.addEventListener(type, event => {
          event.preventDefault();
          zone.classList.add('drag');
        });
      });

      ['dragleave', 'drop'].forEach(type => {
        zone.addEventListener(type, event => {
          event.preventDefault();
          zone.classList.remove('drag');
          if (type === 'drop' && event.dataTransfer && event.dataTransfer.files.length){
            addFiles(event.dataTransfer.files);
          }
        });
      });
    }

    // global drop guard so the browser doesn't navigate away
    ['dragover', 'drop'].forEach(type => {
      document.addEventListener(type, event => {
        if (!event.target.closest('.dropzone')) event.preventDefault();
      });
    });

    renderScopes();
  }

  WA.Analyzer = {
    state,
    addFiles,
    processFile,
    countWords,
    countLetters,
    countSentences,
    computeStats,
    scopedStats,
    performSearch,
    performReplace,
    switchView,
    refreshViews,
    refreshStatsOnly,
    refreshAll,
    renderFileList,
    renderEditor,
    syncScroll,
    bind: bindAnalyzer,
    setDirection,
    restoreOriginal,
    exportData
  };

  document.addEventListener('DOMContentLoaded', () => {
    bindEditor();
    bindAnalyzer();
  });
})();