// options.js — AI Web Assistant Settings Page

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────

  const DEFAULT_SERVER_URL = 'https://webai.pc.am';

  const DEFAULTS = {
    model: 'claude-opus-4-6',
    theme: 'dark',
  };

  // ─── DOM References ──────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);

  const elExtVersion = $('#ext-version');
  const elServerUrl = $('#server-url-input');
  const elModelSelect = $('#model-select');
  const elThemeSelect = $('#theme-select');
  const elResetAllBtn = $('#reset-all-btn');
  const elToast = $('#toast');

  // ─── State ───────────────────────────────────────────────────

  let currentSettings = { ...DEFAULTS };
  let toastTimer = null;

  // ─── Init ────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    setVersion();
    loadSettings().then(renderSettings);
    bindEvents();
  }

  // ─── Version ─────────────────────────────────────────────────

  function setVersion() {
    let version = '1.0.0';
    try {
      if (chrome && chrome.runtime && chrome.runtime.getManifest) {
        version = chrome.runtime.getManifest().version;
      }
    } catch (e) {
      // fallback
    }
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
      chrome.runtime.sendMessage(msg, (response) => {
        resolve(response);
      });
    });
  }

  // ─── Load Settings ───────────────────────────────────────────

  async function loadSettings() {
    try {
      const [settingsResult, storageResult] = await Promise.all([
        sendMessage({ type: 'GET_SETTINGS' }).catch(() => null),
        storageGet(['model', 'theme', 'serverUrl']),
      ]);

      if (settingsResult && settingsResult.model !== undefined) {
        currentSettings.model = settingsResult.model || DEFAULTS.model;
        currentSettings.theme = settingsResult.theme || DEFAULTS.theme;
      } else {
        currentSettings.model = storageResult.model || DEFAULTS.model;
        currentSettings.theme = storageResult.theme || DEFAULTS.theme;
      }
      currentSettings.serverUrl = storageResult.serverUrl || DEFAULT_SERVER_URL;
    } catch (e) {
      const storageResult = await storageGet(['model', 'theme', 'serverUrl']);
      currentSettings.model = storageResult.model || DEFAULTS.model;
      currentSettings.theme = storageResult.theme || DEFAULTS.theme;
      currentSettings.serverUrl = storageResult.serverUrl || DEFAULT_SERVER_URL;
    }
  }

  // ─── Render ──────────────────────────────────────────────────

  function renderSettings() {
    elServerUrl.value = currentSettings.serverUrl;
    elModelSelect.value = currentSettings.model;
    elThemeSelect.value = currentSettings.theme;
    applyTheme(currentSettings.theme);
  }

  function applyTheme(theme) {
    document.body.classList.remove('light');
    if (theme === 'light') document.body.classList.add('light');
  }

  // ─── Bind Events ─────────────────────────────────────────────

  let serverUrlTimer = null;

  function bindEvents() {
    elServerUrl.addEventListener('input', () => {
      clearTimeout(serverUrlTimer);
      serverUrlTimer = setTimeout(() => {
        let url = elServerUrl.value.trim().replace(/\/+$/, '');
        if (!url) url = DEFAULT_SERVER_URL;
        currentSettings.serverUrl = url;
        storageSet({ serverUrl: url });
        showToast('Server URL updated to ' + url, 'success');
      }, 600);
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
    if (!confirm('Are you sure you want to reset ALL settings? This cannot be undone.')) {
      return;
    }

    try {
      await sendMessage({ type: 'RESET_ALL' }).catch(() => null);
      await storageClearAll();

      currentSettings = { ...DEFAULTS, serverUrl: DEFAULT_SERVER_URL };
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

    toastTimer = setTimeout(() => {
      elToast.classList.remove('visible');
    }, 3000);
  }
})();
