/**
 * PrivacyShieldBase
 *
 * Each platform script provides:
 *   getInput()        → live input element (contenteditable or textarea)
 *   getSendButton()   → send button element (may be null when input is empty)
 *   getInputText()    → current raw text
 *   setInputText(t)   → replace contents
 *   getResponseRoot() → element whose subtree contains AI responses
 */
class PrivacyShieldBase {
  constructor() {
    this.reverseMap  = new Map();   // fake (lc) → real
    this.forwardMap  = {};          // real → fake (passed to Ollama for consistency)
    this.enabled     = true;
    this.skipNextSend = false;
    this._responseObserver = null;
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────

  async init() {
    console.log('[PrivacyShield] init on', location.hostname);
    const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    this.enabled = settings.enabled;
    this._injectStyles();
    this._initPdfJs();
    this._attachInterceptors();
    this._attachFileInterceptors();
    this._pollForUI();
  }

  _pollForUI(attempts = 0) {
    if (attempts > 120) {
      console.warn('[PrivacyShield] gave up waiting for chat UI');
      return;
    }
    if (this.getInput()) {
      console.log('[PrivacyShield] chat UI found');
      this._injectToggleButton();
      this._startResponseObserver();
    } else {
      setTimeout(() => this._pollForUI(attempts + 1), 500);
    }
  }

  // ─── PDF.js setup ─────────────────────────────────────────────────────────

  _initPdfJs() {
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
      console.log('[PrivacyShield] pdf.js ready');
    } else {
      console.warn('[PrivacyShield] pdf.js not loaded — PDF support disabled');
    }
  }

  // ─── Send interceptors (window capture, survive re-renders) ───────────────

  _attachInterceptors() {
    window.addEventListener('click', (e) => {
      const btn = this.getSendButton();
      if (!btn || !(e.target === btn || btn.contains(e.target))) return;
      if (this.skipNextSend) { this.skipNextSend = false; return; }
      if (!this.enabled) return;
      console.log('[PrivacyShield] send button clicked — intercepting');
      this._onSendAttempt(e, 'click');
    }, true);

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (!e.target.isContentEditable) return;
      if (this.skipNextSend) { this.skipNextSend = false; return; }
      if (!this.enabled) return;
      console.log('[PrivacyShield] Enter in contenteditable — intercepting');
      this._onSendAttempt(e, 'keydown');
    }, true);

    console.log('[PrivacyShield] send interceptors attached');
  }

  async _onSendAttempt(e, kind) {
    e.preventDefault();
    e.stopImmediatePropagation();

    const raw = this.getInputText().trim();
    console.log('[PrivacyShield] intercepted text:', raw.slice(0, 80));

    if (!raw) {
      this.skipNextSend = true;
      this._doTriggerSend();
      return;
    }

    this._showBadge('Anonymizing…', 'working');

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ANONYMIZE',
        text: raw,
        existingMappings: this.forwardMap,
      });

      if (!result.success) throw new Error(result.error);

      console.log('[PrivacyShield] mappings:', result.mappings);
      this._addMappings(result.mappings);
      this.setInputText(result.anonymized);
      chrome.storage.local.set({ sessionMappings: this._serializeMappings() });

      const n = result.mappings.length;
      this._showBadge(n > 0 ? `${n} item${n > 1 ? 's' : ''} hidden` : 'No PII found', n > 0 ? 'ok' : 'neutral');
    } catch (err) {
      console.error('[PrivacyShield] Ollama error:', err);
      this._showBadge('Ollama error — sending original', 'error');
    }

    setTimeout(() => {
      this.skipNextSend = true;
      this._doTriggerSend();
    }, 80);
  }

  _doTriggerSend() {
    const input = this.getInput();
    if (input) {
      console.log('[PrivacyShield] dispatching Enter on input');
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13,
        bubbles: true, cancelable: true,
      }));
      return;
    }
    const btn = this.getSendButton();
    if (btn) {
      console.log('[PrivacyShield] clicking send button');
      btn.click();
    }
  }

  // ─── File interception (drag-drop + file input) ───────────────────────────

  _attachFileInterceptors() {
    // Intercept file drops
    window.addEventListener('drop', (e) => this._onFileDrop(e), true);

    // Intercept <input type="file"> changes
    window.addEventListener('change', (e) => {
      if (e.target?.type === 'file') this._onFileInput(e);
    }, true);

    console.log('[PrivacyShield] file interceptors attached');
  }

  async _onFileDrop(e) {
    if (!this.enabled) return;
    const files = Array.from(e.dataTransfer?.files || []);
    const readable = files.filter(f => this._isReadableFile(f));
    if (!readable.length) return; // images, etc. — let through

    e.preventDefault();
    e.stopImmediatePropagation();

    // Dismiss the site's drag-overlay (it listens for dragleave/dragend to close)
    // Without this the "Add anything" modal stays frozen on screen.
    const cleanup = () => {
      [e.target, document.body].forEach(el => {
        el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new DragEvent('dragend',   { bubbles: true, cancelable: true }));
      });
    };
    cleanup();
    setTimeout(cleanup, 50); // second pass for slower React state updates

    console.log('[PrivacyShield] intercepted file drop:', readable.map(f => f.name));
    await this._extractAndPaste(readable);
  }

  async _onFileInput(e) {
    if (!this.enabled) return;
    const files = Array.from(e.target?.files || []);
    const readable = files.filter(f => this._isReadableFile(f));
    if (!readable.length) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    console.log('[PrivacyShield] intercepted file input:', readable.map(f => f.name));
    await this._extractAndPaste(readable);
  }

  _isReadableFile(file) {
    if (file.type === 'application/pdf') return true;
    if (file.type.startsWith('text/')) return true;
    if (/\.(txt|csv|tsv|md|json|xml|html|log|rtf)$/i.test(file.name)) return true;
    return false;
  }

  async _extractAndPaste(files) {
    this._showBadge(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`, 'working');

    try {
      const parts = [];
      for (const file of files) {
        const text = await this._extractText(file);
        if (text?.trim()) {
          parts.push(`--- ${file.name} ---\n${text.trim()}`);
        }
      }

      if (!parts.length) {
        this._showBadge('No text found in file', 'neutral');
        return;
      }

      const extracted = parts.join('\n\n');
      const existing = this.getInputText().trim();
      const combined = existing
        ? `${existing}\n\n${extracted}`
        : extracted;

      this.setInputText(combined);

      const totalChars = extracted.length;
      this._showBadge(
        `Pasted ${totalChars.toLocaleString()} chars from ${files.length} file${files.length > 1 ? 's' : ''} — will anonymize on send`,
        'ok', 4000,
      );
      console.log('[PrivacyShield] pasted', totalChars, 'chars from', files.length, 'file(s)');
    } catch (err) {
      console.error('[PrivacyShield] file extraction error:', err);
      this._showBadge('Failed to read file: ' + err.message, 'error', 4000);
    }
  }

  async _extractText(file) {
    if (file.type === 'application/pdf') {
      return this._extractPdfText(file);
    }
    // Plain text / CSV / MD / etc.
    return file.text();
  }

  async _extractPdfText(file) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('PDF.js not loaded — cannot read PDFs');
    }

    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map(item => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) pages.push(text);
    }

    console.log('[PrivacyShield] extracted', pages.length, 'pages from PDF');
    return pages.join('\n\n');
  }

  // ─── Mapping helpers ───────────────────────────────────────────────────────

  _addMappings(arr) {
    for (const { original, replacement } of (arr || [])) {
      if (!original || !replacement) continue;
      this.reverseMap.set(replacement.toLowerCase(), original);
      if (!this.forwardMap[original]) this.forwardMap[original] = replacement;
    }
  }

  _serializeMappings() {
    return Array.from(this.reverseMap.entries()).map(([fake, real]) => ({ fake, real }));
  }

  reverseMapText(text) {
    if (!this.reverseMap.size) return text;
    let out = text;
    for (const [fake, real] of this.reverseMap) {
      out = out.replace(new RegExp(this._esc(fake), 'gi'), (m) => this._matchCase(real, m));
    }
    return out;
  }

  _matchCase(real, matched) {
    if (!matched) return real;
    if (matched === matched.toUpperCase()) return real.toUpperCase();
    if (matched[0] === matched[0].toUpperCase()) return real[0].toUpperCase() + real.slice(1).toLowerCase();
    return real.toLowerCase();
  }

  _esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // ─── Response observer ─────────────────────────────────────────────────────

  _startResponseObserver() {
    if (this._responseObserver) this._responseObserver.disconnect();
    let debounce;
    this._responseObserver = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this._applyReverse(), 800);
    });
    const root = this.getResponseRoot?.() || document.body;
    this._responseObserver.observe(root, { childList: true, subtree: true, characterData: true });
  }

  _applyReverse() {
    if (!this.reverseMap.size) return;
    this._walk(this.getResponseRoot?.() || document.body);
  }

  _walk(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const next = this.reverseMapText(node.textContent);
      if (next !== node.textContent) node.textContent = next;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName?.toLowerCase();
      if (tag === 'script' || tag === 'style' || node.id === 'ps-toggle' || node.id === 'ps-badge') return;
      for (const c of Array.from(node.childNodes)) this._walk(c);
    }
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById('ps-styles')) return;
    const s = document.createElement('style');
    s.id = 'ps-styles';
    s.textContent = `
      #ps-toggle {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 4px 10px; border-radius: 6px;
        font-size: 12px; font-family: system-ui, sans-serif; font-weight: 600;
        cursor: pointer; border: 1.5px solid; background: transparent;
        transition: opacity .15s; user-select: none; flex-shrink: 0;
        position: fixed; bottom: 70px; right: 16px; z-index: 2147483647;
      }
      #ps-toggle:hover { opacity: .75; }
      #ps-toggle.on  { border-color: #22c55e; color: #22c55e; background: rgba(34,197,94,.08); }
      #ps-toggle.off { border-color: #94a3b8; color: #94a3b8; }
      #ps-badge {
        position: fixed; bottom: 22px; right: 22px;
        padding: 7px 14px; border-radius: 8px;
        font-size: 13px; font-family: system-ui, sans-serif; font-weight: 500;
        color: #fff; z-index: 2147483647; pointer-events: none;
        opacity: 0; transition: opacity .25s; max-width: 280px;
      }
      #ps-badge.show { opacity: 1; }
      #ps-badge.ok      { background: rgba(22,163,74,.92); }
      #ps-badge.error   { background: rgba(220,38,38,.92); }
      #ps-badge.working { background: rgba(37,99,235,.92); }
      #ps-badge.neutral { background: rgba(75,85,99,.88); }
    `;
    document.head.appendChild(s);
  }

  _injectToggleButton() {
    if (document.getElementById('ps-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'ps-toggle';
    btn.type = 'button';
    btn.className = `${this.enabled ? 'on' : 'off'}`;
    btn.title = 'Privacy Shield — click to toggle';
    btn.innerHTML = this._svg() + `<span>${this.enabled ? 'Shield ON' : 'Shield OFF'}</span>`;
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.enabled = !this.enabled;
      btn.className = this.enabled ? 'on' : 'off';
      btn.querySelector('span').textContent = this.enabled ? 'Shield ON' : 'Shield OFF';
      chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { enabled: this.enabled } });
      this._showBadge(this.enabled ? 'Privacy Shield enabled' : 'Privacy Shield disabled', 'neutral', 1800);
    });
    document.body.appendChild(btn);
  }

  _showBadge(text, kind = 'ok', duration = 2500) {
    let b = document.getElementById('ps-badge');
    if (!b) { b = document.createElement('div'); b.id = 'ps-badge'; document.body.appendChild(b); }
    b.textContent = '🛡 ' + text;
    b.className = `show ${kind}`;
    clearTimeout(this._bt);
    this._bt = setTimeout(() => b.classList.remove('show'), duration);
  }

  _svg() {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
  }

  // ─── React-safe text setters ───────────────────────────────────────────────

  _setTextareaValue(el, value) {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  _setContentEditable(el, value) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('insertText', false, value);
    if (!ok || el.innerText.trim() !== value.trim()) {
      el.innerText = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
  }
}
