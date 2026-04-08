const $ = (id) => document.getElementById(id);

async function init() {
  // Load settings
  const settings = await msg({ type: 'GET_SETTINGS' });
  $('enabledToggle').checked = settings.enabled;
  $('ollamaUrl').value = settings.ollamaUrl;
  $('modelInput').value = settings.model;

  // Ollama status
  checkOllama();

  // Load session mappings (stored by content script)
  chrome.storage.local.get(['sessionMappings'], ({ sessionMappings }) => {
    renderMappings(sessionMappings || []);
  });

  // Listen for mapping updates from the active tab's content script
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sessionMappings) {
      renderMappings(changes.sessionMappings.newValue || []);
    }
  });

  // ── Enabled toggle ──────────────────────────────────────
  $('enabledToggle').addEventListener('change', () => {
    msg({ type: 'SET_SETTINGS', settings: { enabled: $('enabledToggle').checked } });
  });

  // ── Refresh Ollama ──────────────────────────────────────
  $('refreshOllama').addEventListener('click', checkOllama);

  // ── Clear mappings ──────────────────────────────────────
  $('clearMappings').addEventListener('click', () => {
    chrome.storage.local.set({ sessionMappings: [] });
    renderMappings([]);
  });

  // ── Save settings ───────────────────────────────────────
  $('saveSettings').addEventListener('click', async () => {
    await msg({
      type: 'SET_SETTINGS',
      settings: {
        ollamaUrl: $('ollamaUrl').value.trim() || 'http://localhost:11434',
        model:     $('modelInput').value.trim() || 'llama3.2',
      },
    });
    // Show a brief "Saved" confirmation
    const btn = $('saveSettings');
    btn.textContent = 'Saved ✓';
    btn.style.background = '#22c55e';
    setTimeout(() => {
      btn.textContent = 'Save settings';
      btn.style.background = '';
    }, 1500);
    checkOllama();
  });
}

async function checkOllama() {
  const dot    = $('ollamaDot');
  const status = $('ollamaStatus');
  dot.className = 'dot checking';
  status.textContent = 'Checking Ollama…';

  try {
    const { ok } = await msg({ type: 'CHECK_OLLAMA' });
    if (ok) {
      dot.className = 'dot ok';
      status.textContent = 'Ollama connected';
    } else {
      throw new Error('not ok');
    }
  } catch {
    dot.className = 'dot error';
    status.textContent = 'Ollama not reachable';
  }
}

function renderMappings(mappings) {
  const list = $('mappingsList');
  if (!mappings || mappings.length === 0) {
    list.innerHTML = '<p class="empty">No replacements yet. Send a message with personal data to see mappings here.</p>';
    return;
  }

  list.innerHTML = mappings.map(({ fake, real }) => `
    <div class="mapping-row">
      <span class="mapping-real">${esc(real)}</span>
      <span class="mapping-arrow">→</span>
      <span class="mapping-fake">${esc(fake)}</span>
    </div>
  `).join('');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function msg(payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
}

init();
