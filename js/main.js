/* ============================================================
   Boot
   ============================================================ */
(function(){
  'use strict';

  const WA = window.WA;

  function boot(){
    WA.log('boot', {
      pdfjs: typeof pdfjsLib !== 'undefined',
      tesseract: typeof Tesseract !== 'undefined',
      mammoth: typeof mammoth !== 'undefined',
      xlsx: typeof XLSX !== 'undefined',
      jszip: typeof JSZip !== 'undefined',
      jspdf: typeof window.jspdf !== 'undefined'
    });

    if (WA.Analyzer){
      WA.Analyzer.refreshAll();
    }
    if (WA.UI){
      WA.UI.updateHomeStats();
    }
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();