/**
 * Google Gemini — content script
 */
class GeminiShield extends PrivacyShieldBase {
  getInput() {
    // Gemini uses a rich-text contenteditable (often a Quill editor)
    return (
      document.querySelector('div.ql-editor[contenteditable="true"]') ||
      document.querySelector('rich-textarea div[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][aria-label*="message" i]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  getSendButton() {
    return (
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button.send-button') ||
      document.querySelector('button[data-test-id="send-button"]') ||
      document.querySelector('button mat-icon[data-mat-icon-name="send"]')?.closest('button') ||
      null
    );
  }

  getInputText() {
    const el = this.getInput();
    return el ? el.innerText : '';
  }

  setInputText(text) {
    const el = this.getInput();
    if (el) this._setContentEditable(el, text);
  }

  getResponseRoot() {
    return (
      document.querySelector('model-response') ||
      document.querySelector('bard-zero-input-area') ||
      document.querySelector('main') ||
      document.body
    );
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

const _geminiShield = new GeminiShield();
_geminiShield.init();

let _lastGeminiUrl = location.href;
new MutationObserver(() => {
  if (location.href !== _lastGeminiUrl) {
    _lastGeminiUrl = location.href;
    setTimeout(() => {
      if (!_geminiShield._initDone) return;
      _geminiShield._initDone = false;
      _geminiShield._waitForUI();
    }, 800);
  }
}).observe(document, { subtree: true, childList: true });
