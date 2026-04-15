const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANONYMIZE') {
    anonymizeText(message.text, message.existingMappings)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    chrome.storage.sync.get(['ollamaUrl', 'model', 'enabled'], (s) => {
      sendResponse({
        ollamaUrl: s.ollamaUrl || DEFAULT_OLLAMA_URL,
        model: s.model || DEFAULT_MODEL,
        enabled: s.enabled !== false,
      });
    });
    return true;
  }

  if (message.type === 'SET_SETTINGS') {
    chrome.storage.sync.set(message.settings, () => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'CHECK_OLLAMA') {
    checkOllama()
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // OCR relay: content script can't spawn workers from chrome-extension:// URLs,
  // so it sends rendered page images here; we forward to the offscreen document
  // which runs in extension origin and CAN create workers.
  if (message.type === 'OCR_IMAGE') {
    (async () => {
      try {
        await ensureOffscreen();
        // Forward to offscreen and relay its response back
        const result = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'DO_OCR', dataUrl: message.dataUrl }, (res) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(res);
          });
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }
});

async function ensureOffscreen() {
  const contexts = await chrome.offscreen.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['WORKERS'],
      justification: 'Tesseract.js OCR for image-based PDFs',
    });
  }
}

async function checkOllama() {
  const { ollamaUrl } = await chrome.storage.sync.get(['ollamaUrl']);
  const base = ollamaUrl || DEFAULT_OLLAMA_URL;
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}

async function anonymizeText(text, existingMappings = {}) {
  const { ollamaUrl, model } = await chrome.storage.sync.get(['ollamaUrl', 'model']);
  const base = ollamaUrl || DEFAULT_OLLAMA_URL;
  const mdl = model || DEFAULT_MODEL;

  const existingContext = Object.keys(existingMappings).length > 0
    ? `\nAlready established replacements — reuse these exactly if the same values appear again:\n${
        Object.entries(existingMappings)
          .map(([real, fake]) => `  "${real}" → "${fake}"`)
          .join('\n')
      }\n`
    : '';

  const prompt = `You are a privacy-protection assistant. Replace all personally identifiable information (PII) in the message below with realistic-sounding fake equivalents.

Replace:
- Personal names (first, last, or full)
- Physical addresses (street, city, postcode)
- Phone numbers
- Email addresses
- National ID / social security numbers
- Dates of birth
- Financial account numbers
- Any other direct personal identifiers
${existingContext}
Rules:
1. Use different but realistic names and addresses (any nationality/gender is fine).
2. If the same real value appears multiple times, always map it to the same fake value.
3. Keep the message grammatically correct and natural.
4. Do NOT replace generic place names (countries, famous cities used in general context).
5. Do NOT invent replacements for values that are not PII.

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "anonymized": "<full message with all PII replaced>",
  "mappings": [
    { "original": "<exact value from text>", "replacement": "<what it was replaced with>" }
  ]
}

If no PII is found return:
{ "anonymized": "<original message unchanged>", "mappings": [] }

Message:
${text}`;

  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: mdl,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();

  let parsed;
  try {
    parsed = JSON.parse(data.response);
  } catch {
    // Sometimes the model wraps in markdown fences — strip and retry
    const stripped = data.response.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
    parsed = JSON.parse(stripped);
  }

  if (typeof parsed.anonymized !== 'string' || !Array.isArray(parsed.mappings)) {
    throw new Error('Unexpected response shape from Ollama');
  }

  return parsed;
}
