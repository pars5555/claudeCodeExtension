// popup.js — AI Web Assistant popup script

// Load theme
chrome.storage.sync.get(['theme'], (result) => {
  if (result.theme === 'light') document.body.classList.add('light');
});

document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const authStatusDot = document.getElementById('auth-status-dot');
  const authStatusText = document.getElementById('auth-status-text');
  const openSidePanelBtn = document.getElementById('open-sidepanel-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const versionText = document.getElementById('version-text');

  // Show extension version from manifest
  const manifest = chrome.runtime.getManifest();
  versionText.textContent = 'v' + manifest.version;

  // ── Auth status ───────────────────────────────────────────────────────────
  chrome.storage.local.get(['authAccessToken', 'authUser'], (result) => {
    if (result.authAccessToken) {
      if (result.authUser) {
        authStatusDot.classList.add('connected');
        const email = result.authUser.email || result.authUser.displayName || 'User';
        authStatusText.textContent = 'Signed in as ' + email;
      } else {
        authStatusDot.classList.add('connected');
        authStatusText.textContent = 'Signed in';
      }
    } else {
      authStatusText.textContent = 'Not signed in';
    }
  });

  // ── Server connection status + presence ping ────────────────────────────────
  chrome.storage.sync.get(['devMode'], (result) => {
    const serverUrl = result.devMode ? 'http://localhost:3466' : 'https://webai.pc.am';
    statusText.textContent = 'Checking server...';

    // Ping server for presence (popup opened = user is active)
    chrome.storage.local.get(['authAccessToken'], (auth) => {
      if (auth.authAccessToken) {
        fetch(serverUrl + '/api/ping', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + auth.authAccessToken },
        }).catch(() => {});
      }
    });

    fetch(serverUrl + '/api/auth/me', {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    }).then(res => {
      // Any response means server is reachable
      statusDot.classList.add('connected');
      statusText.textContent = 'Server connected (' + serverUrl + ')';
    }).catch(err => {
      statusText.textContent = 'Server not reachable';
    });
  });

  // ── Open Chat (Side Panel) ─────────────────────────────────────────────────
  openSidePanelBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.sidePanel.open({ tabId: tabs[0].id });
      }
    });
    window.close();
  });

  // ── Settings link ──────────────────────────────────────────────────────────
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
});
