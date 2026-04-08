/**
 * Claude.ai — content script
 */
class ClaudeShield extends PrivacyShieldBase {
  getInput() {
    return (
      document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][data-placeholder]') ||
      document.querySelector('[data-testid="chat-input"] div[contenteditable]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  getSendButton() {
    // Claude's send button aria-label has changed over time — try all variants
    return (
      document.querySelector('button[aria-label="Send Message"]') ||
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      // Find any enabled button that is a sibling/descendant of the input's container
      (() => {
        const input = this.getInput();
        if (!input) return null;
        const form = input.closest('form') || input.closest('[role="region"]') || input.parentElement?.parentElement;
        return form?.querySelector('button[type="button"]:not([disabled])') || null;
      })()
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
    return document.querySelector('main') || document.body;
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

const _claudeShield = new ClaudeShield();
_claudeShield.init();

// Re-poll on SPA navigation
let _lastClaudeUrl = location.href;
new MutationObserver(() => {
  if (location.href !== _lastClaudeUrl) {
    _lastClaudeUrl = location.href;
    setTimeout(() => _claudeShield._pollForUI(), 800);
  }
}).observe(document, { subtree: true, childList: true });
