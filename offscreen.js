/**
 * Offscreen document — runs in extension origin so it can create Workers
 * from chrome-extension:// URLs. Handles Tesseract OCR requests relayed
 * from the background service worker.
 */
let tesseractWorker = null;

async function getWorker() {
  if (tesseractWorker) return tesseractWorker;

  const base = chrome.runtime.getURL('lib/tesseract/');
  console.log('[PrivacyShield/offscreen] loading Tesseract, base:', base);

  tesseractWorker = await Tesseract.createWorker('eng', 1, {
    workerPath:    base + 'worker.min.js',
    corePath:      base,
    langPath:      base,
    workerBlobURL: false,
    gzip:          true,
  });

  console.log('[PrivacyShield/offscreen] Tesseract worker ready');
  return tesseractWorker;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'DO_OCR') return;

  (async () => {
    try {
      const worker = await getWorker();

      // Reconstruct image from base64 data URL
      const img = new Image();
      img.src = msg.dataUrl;
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });

      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);

      const { data: { text } } = await worker.recognize(canvas);
      console.log('[PrivacyShield/offscreen] OCR done, chars:', text.trim().length);
      sendResponse({ text: text.trim() });
    } catch (err) {
      console.error('[PrivacyShield/offscreen] OCR error:', err);
      sendResponse({ error: err.message });
    }
  })();

  return true; // keep channel open for async response
});

console.log('[PrivacyShield/offscreen] ready');
