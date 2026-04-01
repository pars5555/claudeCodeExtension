// options.js — AI Web Assistant Settings Page

(function () {
  'use strict';

  const DEFAULTS = {
    model: 'claude-opus-4-6',
    theme: 'dark',
    devMode: false,
  };

  const $ = (sel) => document.querySelector(sel);

  // ── Tab switching ─────────────────────────────────────────────────────
  document.querySelectorAll('.options-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.options-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
      tab.classList.add('active');
      const target = document.getElementById('tab-' + tab.dataset.tab);
      if (target) target.style.display = '';
      if (tab.dataset.tab === 'sessions') loadSessions();
    });
  });

  // ── Sessions tab ──────────────────────────────────────────────────────
  async function getServerUrl() {
    return new Promise(resolve => {
      chrome.storage.local.get(['devConfig'], result => {
        resolve(result.devConfig?.server || 'https://webai.pc.am');
      });
    });
  }

  async function getAuthHeaders() {
    return new Promise(resolve => {
      chrome.storage.local.get(['authAccessToken'], result => {
        resolve(result.authAccessToken ? { Authorization: 'Bearer ' + result.authAccessToken } : {});
      });
    });
  }

  async function loadSessions() {
    const SERVER = await getServerUrl();
    const headers = await getAuthHeaders();
    const listEl = $('#session-list');
    const chatEl = $('#session-chat');
    const emptyEl = $('#session-empty');

    try {
      const res = await fetch(SERVER + '/api/user/chat-sessions', { headers });
      if (!res.ok) { emptyEl.textContent = 'Please log in to view sessions'; return; }
      const data = await res.json();
      const sessions = data.sessions || [];

      // Clear and populate
      while (listEl.options.length > 1) listEl.options[1].remove();
      sessions.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        const date = new Date(s.started_at || s.created_at).toLocaleDateString();
        opt.textContent = (s.title || s.first_message || 'Untitled').substring(0, 40) + ' — ' + (s.model || '').split('-').slice(0,2).join('-') + ' · ' + date;
        listEl.appendChild(opt);
      });
    } catch (e) {
      emptyEl.textContent = 'Could not load sessions';
    }
  }

  // Session select → load messages
  $('#session-list')?.addEventListener('change', async () => {
    const sid = $('#session-list').value;
    const chatEl = $('#session-chat');
    const emptyEl = $('#session-empty');
    if (!sid) { chatEl.style.display = 'none'; emptyEl.style.display = ''; return; }

    const SERVER = await getServerUrl();
    const headers = await getAuthHeaders();

    try {
      chatEl.innerHTML = '<p style="padding:20px;text-align:center;color:#64748b;">Loading...</p>';
      chatEl.style.display = '';
      emptyEl.style.display = 'none';

      const res = await fetch(SERVER + '/api/user/chat-sessions/' + sid + '/messages', { headers });
      if (!res.ok) { chatEl.innerHTML = '<p style="padding:20px;color:#f87171;">Could not load messages</p>'; return; }
      const data = await res.json();
      const msgs = (data.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');

      if (msgs.length === 0) {
        chatEl.innerHTML = '<p style="padding:20px;text-align:center;color:#64748b;">No messages</p>';
        return;
      }

      chatEl.innerHTML = msgs.map(m => {
        const role = m.role === 'user' ? 'You' : 'AI';
        const cls = m.role === 'user' ? 'session-msg-user' : 'session-msg-assistant';
        const text = (m.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        return '<div class="session-msg ' + cls + '"><div class="session-msg-role">' + role + '</div>' + text + '</div>';
      }).join('');
    } catch (e) {
      chatEl.innerHTML = '<p style="padding:20px;color:#f87171;">Error: ' + e.message + '</p>';
    }
  });

  const elExtVersion = $('#ext-version');
  const elDevMode = $('#dev-mode-toggle');
  const elDevUserGroup = $('#dev-user-group');
  const elDevUserSelect = $('#dev-user-select');
  const elModelSelect = $('#model-select');
  const elThemeSelect = $('#theme-select');
  const elResetAllBtn = $('#reset-all-btn');
  const elToast = $('#toast');

  let currentSettings = { ...DEFAULTS };
  let toastTimer = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    setVersion();
    loadSettings().then(renderSettings);
    bindEvents();
  }

  function setVersion() {
    let version = '1.0.0';
    try {
      if (chrome && chrome.runtime && chrome.runtime.getManifest) {
        version = chrome.runtime.getManifest().version;
      }
    } catch (e) {}
    elExtVersion.textContent = version;
  }

  // ─── Storage helpers ─────────────────────────────────────────

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(keys, (result) => resolve(result));
    });
  }

  function storageSet(data) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(data, () => resolve());
    });
  }

  function storageClearAll() {
    return Promise.all([
      new Promise((resolve) => chrome.storage.sync.clear(resolve)),
      new Promise((resolve) => chrome.storage.local.clear(resolve)),
    ]);
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => resolve(response));
    });
  }

  // ─── Load Settings ───────────────────────────────────────────

  async function loadSettings() {
    try {
      const [settingsResult, storageResult] = await Promise.all([
        sendMessage({ type: 'GET_SETTINGS' }).catch(() => null),
        storageGet(['model', 'theme', 'devMode', 'devUser']),
      ]);

      if (settingsResult && settingsResult.model !== undefined) {
        currentSettings.model = settingsResult.model || DEFAULTS.model;
        currentSettings.theme = settingsResult.theme || DEFAULTS.theme;
      } else {
        currentSettings.model = storageResult.model || DEFAULTS.model;
        currentSettings.theme = storageResult.theme || DEFAULTS.theme;
      }
      currentSettings.devMode = storageResult.devMode === true;
      currentSettings.devUser = storageResult.devUser || '';
    } catch (e) {
      const storageResult = await storageGet(['model', 'theme', 'devMode', 'devUser']);
      currentSettings.model = storageResult.model || DEFAULTS.model;
      currentSettings.theme = storageResult.theme || DEFAULTS.theme;
      currentSettings.devMode = storageResult.devMode === true;
      currentSettings.devUser = storageResult.devUser || '';
    }
  }

  // ─── Render ──────────────────────────────────────────────────

  function renderSettings() {
    elDevMode.checked = currentSettings.devMode;
    // Only show dev mode section if already enabled
    var devSection = document.getElementById('dev-mode-section');
    if (devSection) devSection.style.display = currentSettings.devMode ? '' : 'none';
    elDevUserGroup.style.display = currentSettings.devMode ? '' : 'none';
    elDevUserSelect.value = currentSettings.devUser;
    elModelSelect.value = currentSettings.model;
    elThemeSelect.value = currentSettings.theme;
    applyTheme(currentSettings.theme);
  }

  function applyTheme(theme) {
    document.body.classList.remove('light');
    if (theme === 'light') document.body.classList.add('light');
  }

  // ─── Bind Events ─────────────────────────────────────────────

  function bindEvents() {
    elDevMode.addEventListener('change', () => {
      currentSettings.devMode = elDevMode.checked;
      elDevUserGroup.style.display = currentSettings.devMode ? '' : 'none';
      storageSet({ devMode: currentSettings.devMode });
      showToast(currentSettings.devMode ? 'Dev mode ON — using localhost:3466' : 'Dev mode OFF — using production', 'success');
    });

    elDevUserSelect.addEventListener('change', () => {
      currentSettings.devUser = elDevUserSelect.value;
      storageSet({ devUser: currentSettings.devUser });
      showToast('Dev user changed — reload sidepanel to apply', 'success');
    });

    elModelSelect.addEventListener('change', () => {
      currentSettings.model = elModelSelect.value;
      saveSettings();
      showToast('Model updated', 'success');
    });

    elThemeSelect.addEventListener('change', () => {
      currentSettings.theme = elThemeSelect.value;
      applyTheme(currentSettings.theme);
      saveSettings();
      showToast('Theme updated', 'success');
    });

    elResetAllBtn.addEventListener('click', resetAll);
  }

  // ─── Save ────────────────────────────────────────────────────

  async function saveSettings() {
    try {
      await sendMessage({
        type: 'SET_SETTINGS',
        model: currentSettings.model,
        theme: currentSettings.theme,
      }).catch(() => null);

      await storageSet(currentSettings);
    } catch (e) {
      showToast('Failed to save settings', 'error');
    }
  }

  // ─── Reset All ───────────────────────────────────────────────

  async function resetAll() {
    if (!confirm('Are you sure you want to reset ALL settings? This cannot be undone.')) return;

    try {
      await sendMessage({ type: 'RESET_ALL' }).catch(() => null);
      await storageClearAll();
      currentSettings = { ...DEFAULTS };
      renderSettings();
      showToast('All settings have been reset', 'success');
    } catch (e) {
      showToast('Failed to reset settings', 'error');
    }
  }

  // ─── Toast ───────────────────────────────────────────────────

  function showToast(message, type) {
    clearTimeout(toastTimer);
    elToast.textContent = message;
    elToast.className = 'toast ' + type;
    void elToast.offsetWidth;
    elToast.classList.add('visible');
    toastTimer = setTimeout(() => { elToast.classList.remove('visible'); }, 3000);
  }
})();
