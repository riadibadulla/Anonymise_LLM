/**
 * ChatGPT / OpenAI — content script
 * Works on chatgpt.com and chat.openai.com
 */
class ChatGPTShield extends PrivacyShieldBase {
  getInput() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][id^="prompt"]') ||
      document.querySelector('div[contenteditable="true"][data-virtualkeyboard-target]') ||
      document.querySelector('textarea[data-id="root"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  getSendButton() {
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('form button[type="submit"]')
    );
  }

  getInputText() {
    const el = this.getInput();
    if (!el) return '';
    return el.tagName === 'TEXTAREA' ? el.value : el.innerText;
  }

  setInputText(text) {
    const el = this.getInput();
    if (!el) return;
    if (el.tagName === 'TEXTAREA') {
      this._setTextareaValue(el, text);
    } else {
      this._setContentEditable(el, text);
    }
  }

  getResponseRoot() {
    return document.querySelector('main') || document.querySelector('#__next') || document.body;
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

const _chatgptShield = new ChatGPTShield();
_chatgptShield.init();

let _lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== _lastUrl) {
    _lastUrl = location.href;
    setTimeout(() => _chatgptShield._pollForUI(), 800);
  }
}).observe(document, { subtree: true, childList: true });
