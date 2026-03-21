// sidepanel.js — AI Web Assistant Side Panel (Multi-Container Session Architecture)

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let isStreaming = false;
  let conversationHistory = [];
  let currentStreamText = '';
  let chatSessionId = null; // CLI session ID — server manages context
  let currentTabId = null;
  let currentTabInfo = { url: '', title: '' };
  let _stepSendTime = 0; // Profiling: timestamp when SSE request was sent

  // ---------------------------------------------------------------------------
  // Auth State
  // ---------------------------------------------------------------------------
  let SERVER_URL = 'https://webai.pc.am';
  const authState = {
    accessToken: null,
    refreshToken: null,
    user: null,
    isAuthenticated: false,
  };
  // currentAbortController is stored per-session as session.abortController

  // ---------------------------------------------------------------------------
  // Session State (multi-container architecture)
  // ---------------------------------------------------------------------------
  // Each session has its own DOM container that persists in the wrapper.
  // sessionId → { el, history, isStreaming, streamText, tabId, model, title }
  const sessions = new Map();
  let activeSessionId = null;

  // Note: streaming state is per-session (session.isStreaming, session.streamText, session.abortController)
  // No global streamingSessionId — each SSE connection captures its target via closure

  // Pending file/image attachments: Array of { name, type, dataUrl, base64, mediaType }
  let pendingAttachments = [];

  // Context window limits (approximate tokens) per model
  const MODEL_CONTEXT_LIMITS = {
    'claude-opus-4-6': 200000,
    'claude-sonnet-4-6': 200000,
    'claude-haiku-4-5': 200000
  };

  // ---------------------------------------------------------------------------
  // Tab switch detection
  // ---------------------------------------------------------------------------
  async function updateCurrentTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) return;

    const oldTabId = currentTabId;
    const tabChanged = oldTabId !== null && oldTabId !== tab.id;

    currentTabId = tab.id;
    currentTabInfo = { url: tab.url || '', title: tab.title || '' };

    if (tabChanged) {
      // Save current session state before switching
      saveActiveSessionState();

      // Find session associated with the new tab
      const sessionForTab = findSessionByTabId(tab.id);
      if (sessionForTab) {
        switchToSession(sessionForTab);
      } else {
        // No session for this tab — show welcome
        switchToSession(null);
      }
    }

    // Update indicator AFTER session switch so it shows correct session
    updateTabIndicator();
  }

  function updateTabIndicator() {
    let indicator = document.getElementById('claude-tab-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'claude-tab-indicator';
      indicator.style.cssText = 'padding:4px 14px;font-size:11px;color:#64748b;background:rgba(124,58,237,0.05);border-bottom:1px solid rgba(124,58,237,0.1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;';
      const header = document.getElementById('claude-panel-header');
      header.parentNode.insertBefore(indicator, header.nextSibling);
    }
    let host = '';
    try { host = currentTabInfo.url ? new URL(currentTabInfo.url).hostname : ''; } catch (e) {}
    var sid = activeSessionId || chatSessionId;
    indicator.textContent = (host || currentTabInfo.title || 'No page') + '  ·  tab:' + (currentTabId || '?') + (sid ? '  ·  ' + sid.slice(0, 8) : '');
    indicator.title = (currentTabInfo.url || '') + '\nTab ID: ' + (currentTabId || '?') + (sid ? '\nSession: ' + sid : '');

    const tabContextLabel = document.getElementById('claude-tab-context-label');
    if (tabContextLabel) {
      const title = currentTabInfo.title || '';
      const label = host ? host + (title ? ' — ' + title : '') : title || 'No page';
      tabContextLabel.textContent = label;
      tabContextLabel.title = currentTabInfo.url;
    }
  }

  // Listen for tab switches
  chrome.tabs.onActivated.addListener(() => updateCurrentTab());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === currentTabId && (changeInfo.url || changeInfo.title)) {
      updateCurrentTab();
    }
  });

  // Init current tab
  updateCurrentTab();

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------
  function createSessionContainer(sessionId) {
    const el = document.createElement('div');
    el.className = 'session-container';
    el.dataset.sessionId = sessionId;
    sessionsWrapper.appendChild(el);
    // Scroll listener per container
    el.addEventListener('scroll', function () {
      var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      _autoScroll = atBottom;
    });
    return el;
  }

  function saveActiveSessionState() {
    if (activeSessionId && sessions.has(activeSessionId)) {
      const s = sessions.get(activeSessionId);
      s.history = conversationHistory;
      s.isStreaming = isStreaming;
      s.streamText = currentStreamText;
      s.inputValue = inputEl.value;
      s.inputAttachments = [...pendingAttachments];
      s.model = modelSelect.value; // save current model for this session
    }
  }

  function switchToSession(sessionId) {
    // Save state of current session
    saveActiveSessionState();

    // Hide all session containers
    sessionsWrapper.querySelectorAll('.session-container').forEach(function (c) {
      c.classList.remove('active');
    });

    if (!sessionId || !sessions.has(sessionId)) {
      // Show welcome
      welcomeContainer.classList.add('active');
      messagesEl = welcomeContainer;
      activeSessionId = null;
      conversationHistory = [];
      chatSessionId = null;
      isStreaming = false;
      currentStreamText = '';
      pendingAttachments = [];
      renderAttachments();
      // Restore default model for new chats
      chrome.storage.sync.get(['model'], (result) => {
        if (result.model && modelSelect) {
          modelSelect.value = result.model;
          _prevModel = result.model;
        }
      });
    } else {
      // Show session
      welcomeContainer.classList.remove('active');
      const session = sessions.get(sessionId);
      session.el.classList.add('active');
      messagesEl = session.el;
      activeSessionId = sessionId;
      conversationHistory = session.history;
      chatSessionId = sessionId;
      isStreaming = session.isStreaming || false;
      currentStreamText = session.streamText || '';
      // Restore input state
      inputEl.value = session.inputValue || '';
      inputEl.style.height = 'auto';
      pendingAttachments = session.inputAttachments || [];
      renderAttachments();
      // Restore session's model
      if (session.model && modelSelect) {
        modelSelect.value = session.model;
        _prevModel = session.model;
      }
    }

    // Update selector and indicator to match
    if (sessionSelect) sessionSelect.value = sessionId || '';
    updateTabIndicator();
    updateSendButton();
    updateContextMeter();
    scrollToBottom();
  }

  function findSessionByTabId(tabId) {
    for (const [sid, s] of sessions) {
      if (s.tabId === tabId) return sid;
    }
    return null;
  }

  function addSessionToSelector(sessionId, title) {
    if (!sessionSelect) return;
    // Check if option already exists
    for (const opt of sessionSelect.options) {
      if (opt.value === sessionId) {
        opt.textContent = title || sessionId.slice(0, 8);
        return;
      }
    }
    const option = document.createElement('option');
    option.value = sessionId;
    option.textContent = title || sessionId.slice(0, 8);
    sessionSelect.appendChild(option);
  }

  function removeSessionFromSelector(sessionId) {
    if (!sessionSelect) return;
    for (const opt of sessionSelect.options) {
      if (opt.value === sessionId) {
        opt.remove();
        return;
      }
    }
  }

  function updateSessionSelector() {
    if (!sessionSelect) return;
    // Clear all except the "New Chat" option
    while (sessionSelect.options.length > 1) {
      sessionSelect.options[1].remove();
    }
    // Add all sessions
    for (const [sid, s] of sessions) {
      addSessionToSelector(sid, s.title);
    }
    sessionSelect.value = activeSessionId || '';
  }

  async function loadUserSessions() {
    if (!authState.accessToken) return;
    try {
      const res = await fetch(SERVER_URL + '/api/user/chat-sessions', {
        headers: getAuthHeaders()
      });
      if (!res.ok) return;
      const data = await res.json();
      const serverSessions = data.sessions || [];
      for (const s of serverSessions) {
        if (!sessions.has(s.id)) {
          // Create a container for this session (messages will be loaded lazily)
          const el = createSessionContainer(s.id);
          el.innerHTML = '<div class="claude-welcome"><p style="color:#64748b;font-size:12px;">Chat: ' + escapeHtml(s.title || 'Untitled') + '</p><p style="color:#475569;font-size:11px;">Switch here to continue this chat</p></div>';
          sessions.set(s.id, {
            el: el,
            history: [],
            isStreaming: false,
            streamText: '',
            tabId: null, // Don't set tabId for server-loaded sessions (stale tab mappings)
            model: s.model || '',
            title: s.title || s.id.slice(0, 8),
            firstMessage: s.first_message || '',
            loaded: false, // messages not yet loaded from server
            inputValue: '',
            inputAttachments: [],
          });
        }
      }
      updateSessionSelector();
    } catch (e) { /* silent */ }
  }

  // Get container/history for a specific session (used by streaming handlers via closure)
  function getSessionContainer(sid) {
    if (sid && sessions.has(sid)) return sessions.get(sid).el;
    return messagesEl;
  }

  function getSessionHistory(sid) {
    if (sid && sessions.has(sid)) return sessions.get(sid).history;
    return conversationHistory;
  }

  // ---------------------------------------------------------------------------
  // SVG Icons (inline)
  // ---------------------------------------------------------------------------
  const ICONS = {
    error: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`,
    highlight: `<svg viewBox="0 0 24 24"><path d="M6 14l3 3v5h6v-5l3-3V9H6v5zm5-12h2v3h-2V2zM3.5 5.88l1.41-1.41 2.12 2.12L5.62 8 3.5 5.88zm13.46.71l2.12-2.12 1.41 1.41L18.38 8l-1.42-1.41z"/></svg>`
  };

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  let _autoScroll = true;

  function scrollToBottom() {
    if (!_autoScroll) return;
    requestAnimationFrame(() => {
      if (messagesEl) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    });
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return fallbackCopy(text);
      });
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    return new Promise(function (resolve, reject) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(textarea);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Welcome HTML
  // ---------------------------------------------------------------------------
  function getWelcomeHTML() {
    return `
      <div class="claude-welcome">
        <div class="claude-welcome-icon"><img src="../icons/wai-logo-text.svg" width="48" height="48" alt="wAi"></div>
        <h3>AI Web Assistant</h3>
        <p>Ask anything — Claude has full access to this page.</p>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Element references
  // ---------------------------------------------------------------------------
  const sessionsWrapper = document.getElementById('claude-sessions-wrapper');
  const inputEl = document.getElementById('claude-chat-input');
  const sendBtn = document.getElementById('claude-send-btn');
  const clearBtn = document.getElementById('claude-clear-btn');
  const modelSelect = document.getElementById('claude-model-select');
  const sessionSelect = document.getElementById('claude-session-select');
  const contextFill = document.getElementById('claude-context-fill');
  const contextLabel = document.getElementById('claude-context-label');
  const compactBtn = document.getElementById('claude-compact-btn');
  const uploadBtn = document.getElementById('claude-upload-btn');
  const fileInput = document.getElementById('claude-file-input');
  const attachmentsEl = document.getElementById('claude-attachments');

  // Create the welcome container (default view when no session is active)
  const welcomeContainer = document.createElement('div');
  welcomeContainer.className = 'session-container active';
  welcomeContainer.dataset.sessionId = '';
  welcomeContainer.innerHTML = getWelcomeHTML();
  sessionsWrapper.appendChild(welcomeContainer);

  // messagesEl points to the active session's container (starts as welcome)
  let messagesEl = welcomeContainer;

  // Init auto-scroll listener for welcome container
  welcomeContainer.addEventListener('scroll', function () {
    var atBottom = welcomeContainer.scrollHeight - welcomeContainer.scrollTop - welcomeContainer.clientHeight < 40;
    _autoScroll = atBottom;
  });

  // Auth overlay elements
  const authOverlay = document.getElementById('claude-auth-overlay');
  const authError = document.getElementById('claude-auth-error');
  const authSuccess = document.getElementById('claude-auth-success');
  const authSubtitle = document.getElementById('claude-auth-subtitle');
  const userBadge = document.getElementById('claude-user-badge');
  const userBadgeText = document.getElementById('claude-user-badge-text');

  // Load saved model preference (local cache, then sync from server after auth)
  chrome.storage.sync.get(['model'], (result) => {
    if (result.model && modelSelect) {
      modelSelect.value = result.model;
    }
  });

  // Fetch user's model preference from server (called after auth)
  async function syncModelFromServer() {
    try {
      const resp = await fetch(SERVER_URL + '/api/user/settings', { headers: getAuthHeaders() });
      if (resp.ok) {
        const settings = await resp.json();
        if (settings.model) {
          modelSelect.value = settings.model;
          chrome.storage.sync.set({ model: settings.model });
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Model change — per-tab: ends current chat, starts fresh with new model on this tab only
  let _prevModel = modelSelect.value;
  modelSelect.addEventListener('change', async () => {
    const model = modelSelect.value;
    const hasActiveChat = activeSessionId;

    if (hasActiveChat) {
      if (!confirm('Changing model will end the current chat on this tab. Continue?')) {
        modelSelect.value = _prevModel;
        return;
      }
      clearChat();
    }

    _prevModel = model;
    // Save as default for NEW chats (doesn't affect other tabs with existing sessions)
    chrome.storage.sync.set({ model });
    pingServer();
    try {
      await fetch(SERVER_URL + '/api/user/settings/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ value: model }),
      });
    } catch (e) { /* ignore */ }
  });

  // Session selector — switch between chat sessions
  sessionSelect.addEventListener('change', () => {
    const selectedId = sessionSelect.value;
    if (selectedId === '') {
      // "New Chat" selected
      switchToSession(null);
    } else {
      switchToSession(selectedId);
    }
  });

  // ---------------------------------------------------------------------------
  // Auth: Initialization
  // ---------------------------------------------------------------------------
  async function loadServerUrl() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['devMode'], (result) => {
        if (result.devMode) SERVER_URL = 'http://localhost:3466';
        resolve(SERVER_URL);
      });
    });
  }

  function loadTheme() {
    chrome.storage.sync.get(['theme'], (result) => {
      if (result.theme === 'light') document.body.classList.add('light');
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.theme) {
      document.body.classList.remove('light');
      if (changes.theme.newValue === 'light') document.body.classList.add('light');
    }
    if (area === 'sync' && (changes.devMode || changes.devUser)) {
      window.location.reload();
    }
  });

  async function initAuth() {
    loadTheme();
    await loadServerUrl();
    await clearAuthState();

    const syncData = await storageGet(['devMode', 'devUser']);
    if (syncData.devMode) {
      const userParts = (syncData.devUser || 'pars5555@yahoo.com|admin123').split('|');
      const devEmail = userParts[0];
      const devPassword = userParts[1];
      try {
        const res = await fetch(SERVER_URL + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: devEmail, password: devPassword }),
        });
        if (res.ok) {
          const data = await res.json();
          authState.accessToken = data.accessToken;
          authState.refreshToken = data.refreshToken;
          authState.user = data.user;
          authState.isAuthenticated = true;
          await saveAuthState();
          showChatUI();
          return true;
        }
      } catch (e) {
        console.warn('Dev auto-login failed:', e.message);
      }
      showChatUI();
      return true;
    }

    return new Promise((resolve) => {
      chrome.storage.local.get(['authAccessToken', 'authRefreshToken', 'authUser'], async (result) => {
        if (result.authAccessToken) {
          authState.accessToken = result.authAccessToken;
          authState.refreshToken = result.authRefreshToken || null;
          authState.user = result.authUser || null;
          authState.isAuthenticated = true;

          try {
            const res = await fetch(SERVER_URL + '/api/auth/me', {
              headers: getAuthHeaders()
            });
            if (res.ok) {
              const data = await res.json();
              authState.user = data.user;
              showChatUI();
              resolve(true);
              return;
            } else if (res.status === 401) {
              const refreshed = await refreshAccessToken();
              if (refreshed) {
                showChatUI();
                resolve(true);
                return;
              }
            }
          } catch (e) {
            console.warn('Auth check failed (server may be down):', e.message);
            showChatUI();
            resolve(true);
            return;
          }
        }

        if (!authState.isAuthenticated) {
          showAuthOverlay();
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(keys, (result) => resolve(result));
    });
  }

  function getAuthHeaders() {
    const headers = {};
    if (authState.accessToken) {
      headers['Authorization'] = 'Bearer ' + authState.accessToken;
    }
    return headers;
  }

  function pingServer() {
    if (!authState.accessToken) return;
    fetch(SERVER_URL + '/api/ping', {
      method: 'POST',
      headers: getAuthHeaders(),
    }).catch(() => {});
  }

  function saveAuthState() {
    chrome.storage.local.set({
      authAccessToken: authState.accessToken,
      authRefreshToken: authState.refreshToken,
      authUser: authState.user,
    });
  }

  function clearAuthState() {
    authState.accessToken = null;
    authState.refreshToken = null;
    authState.user = null;
    authState.isAuthenticated = false;
    return new Promise((resolve) => {
      chrome.storage.local.remove(['authAccessToken', 'authRefreshToken', 'authUser'], resolve);
    });
  }

  // ---------------------------------------------------------------------------
  // Auth: OAuth / Refresh / Logout
  // ---------------------------------------------------------------------------
  async function refreshAccessToken() {
    if (!authState.refreshToken) return false;
    try {
      const res = await fetch(SERVER_URL + '/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: authState.refreshToken })
      });
      if (!res.ok) return false;
      const data = await res.json();
      authState.accessToken = data.accessToken;
      authState.refreshToken = data.refreshToken;
      authState.user = data.user;
      saveAuthState();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function logout() {
    try {
      if (authState.refreshToken) {
        await fetch(SERVER_URL + '/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ refreshToken: authState.refreshToken })
        }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
    clearAuthState();
    showAuthOverlay();
  }

  function handleOAuth(provider) {
    chrome.runtime.sendMessage({ type: 'OAUTH_FLOW', provider, serverUrl: SERVER_URL }, (response) => {
      if (chrome.runtime.lastError) {
        showAuthError('OAuth flow failed: ' + chrome.runtime.lastError.message);
        return;
      }
      if (response && response.error) {
        showAuthError(response.error);
        return;
      }
      if (response && response.accessToken) {
        authState.accessToken = response.accessToken;
        authState.refreshToken = response.refreshToken;
        authState.user = response.user;
        authState.isAuthenticated = true;
        saveAuthState();
        showChatUI();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Auth: UI Controls
  // ---------------------------------------------------------------------------
  function showAuthOverlay() {
    if (authOverlay) authOverlay.style.display = 'flex';
    hideAuthError();
    hideAuthSuccess();
    authSubtitle.textContent = 'Sign in to start chatting';
    if (userBadge) userBadge.style.display = 'none';
  }

  function showChatUI() {
    if (authOverlay) authOverlay.style.display = 'none';
    updateUserBadge();
    syncModelFromServer();
    pingServer();
    loadUserSessions(); // Load active sessions from server
  }

  const userBalanceEl = document.getElementById('claude-user-balance');

  function updateUserBadge() {
    if (!userBadge) return;
    chrome.storage.sync.get(['devMode'], (result) => {
      if (result.devMode) {
        userBadge.style.display = 'none';
        if (userBalanceEl) userBalanceEl.style.display = 'none';
        return;
      }
      if (authState.isAuthenticated) {
        userBadge.style.display = 'flex';
        if (authState.user) {
          userBadgeText.textContent = authState.user.email || authState.user.displayName || 'User';
          fetchBalance();
        } else {
          userBadgeText.textContent = 'Signed in';
        }
      } else {
        userBadge.style.display = 'none';
        if (userBalanceEl) userBalanceEl.style.display = 'none';
      }
    });
  }

  async function fetchBalance() {
    if (!authState.accessToken) return;
    try {
      const res = await fetch(SERVER_URL + '/api/billing/balance', {
        headers: { 'Authorization': 'Bearer ' + authState.accessToken }
      });
      if (res.ok) {
        const data = await res.json();
        if (userBalanceEl) {
          userBalanceEl.textContent = '$' + (data.balanceUsd || 0).toFixed(2);
          userBalanceEl.style.display = 'inline-block';
        }
      }
    } catch (e) { /* silent */ }
  }

  function showAuthError(msg) {
    if (authError) {
      authError.textContent = msg;
      authError.style.display = 'block';
    }
    if (authSuccess) authSuccess.style.display = 'none';
  }

  function hideAuthError() {
    if (authError) authError.style.display = 'none';
  }

  function hideAuthSuccess() {
    if (authSuccess) authSuccess.style.display = 'none';
  }

  // Auth overlay event listeners
  document.getElementById('claude-oauth-google')?.addEventListener('click', () => handleOAuth('google'));
  document.getElementById('claude-oauth-apple')?.addEventListener('click', () => handleOAuth('apple'));
  document.getElementById('claude-oauth-github')?.addEventListener('click', () => handleOAuth('github'));

  userBadge?.addEventListener('click', () => {
    chrome.storage.sync.get(['devMode'], (result) => {
      if (result.devMode) return;
      if (confirm('Sign out?')) logout();
    });
  });

  // Init auth on load
  chrome.storage.local.get(['disclaimerAccepted'], (result) => {
    if (result.disclaimerAccepted) {
      initAuth();
    } else {
      const overlay = document.getElementById('disclaimer-overlay');
      if (overlay) {
        overlay.style.display = 'flex';
        document.getElementById('disclaimer-accept-btn').addEventListener('click', () => {
          chrome.storage.local.set({ disclaimerAccepted: true });
          overlay.style.display = 'none';
          initAuth();
        });
      } else {
        initAuth();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------
  clearBtn.addEventListener('click', clearChat);
  sendBtn.addEventListener('click', () => {
    if (isStreaming && !inputEl.value.trim()) {
      stopCurrentStream();
    } else {
      sendMessage();
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  // ---------------------------------------------------------------------------
  // Context meter logic
  // ---------------------------------------------------------------------------
  function estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
  }

  function getContextLimit() {
    const model = modelSelect ? modelSelect.value : 'claude-opus-4-6';
    return MODEL_CONTEXT_LIMITS[model] || 200000;
  }

  function updateContextMeter() {
    let totalTokens = 0;
    for (const msg of conversationHistory) {
      if (typeof msg.content === 'string') {
        totalTokens += estimateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') totalTokens += estimateTokens(part.text);
          else if (part.type === 'image') totalTokens += 1600;
        }
      }
    }

    const limit = getContextLimit();
    const usedPct = Math.min((totalTokens / limit) * 100, 100);
    const remainPct = Math.max(100 - usedPct, 0);

    if (contextFill) {
      contextFill.style.width = usedPct + '%';
      contextFill.classList.remove('warn', 'critical');
      if (remainPct <= 10) contextFill.classList.add('critical');
      else if (remainPct <= 30) contextFill.classList.add('warn');
    }

    if (contextLabel) {
      contextLabel.textContent = Math.round(remainPct) + '% remaining';
    }

    if (compactBtn) {
      compactBtn.disabled = conversationHistory.length < 4;
    }
  }

  compactBtn.addEventListener('click', () => {
    if (conversationHistory.length < 4) return;

    const keepCount = 4;
    const oldMessages = conversationHistory.slice(0, -keepCount);
    const recentMessages = conversationHistory.slice(-keepCount);

    let summaryParts = [];
    for (const msg of oldMessages) {
      const text = typeof msg.content === 'string' ? msg.content : '[multimodal]';
      const preview = text.substring(0, 100).replace(/\n/g, ' ');
      summaryParts.push(msg.role + ': ' + preview);
    }

    const summaryMsg = {
      role: 'user',
      content: '[Context compacted — ' + oldMessages.length + ' earlier messages summarized]\n' +
        'Previous conversation summary:\n' + summaryParts.join('\n')
    };

    conversationHistory = [summaryMsg, ...recentMessages];
    if (activeSessionId && sessions.has(activeSessionId)) {
      sessions.get(activeSessionId).history = conversationHistory;
    }
    updateContextMeter();
    addSystemMessage('Context compacted: ' + oldMessages.length + ' messages summarized.');
  });

  // ---------------------------------------------------------------------------
  // File/Image upload & paste
  // ---------------------------------------------------------------------------
  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    fileInput.value = '';
  });

  inputEl.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  });

  inputEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    inputEl.style.borderColor = 'rgba(124, 58, 237, 0.6)';
  });

  inputEl.addEventListener('dragleave', () => {
    inputEl.style.borderColor = '';
  });

  inputEl.addEventListener('drop', (e) => {
    e.preventDefault();
    inputEl.style.borderColor = '';
    if (e.dataTransfer?.files?.length) {
      handleFiles(e.dataTransfer.files);
    }
  });

  function handleFiles(fileList) {
    for (const file of fileList) {
      if (file.size > 20 * 1024 * 1024) {
        addSystemMessage('File too large: ' + file.name + ' (max 20MB)');
        continue;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        const isImage = file.type.startsWith('image/');

        pendingAttachments.push({
          name: file.name,
          type: file.type,
          dataUrl: dataUrl,
          base64: base64,
          mediaType: file.type,
          isImage: isImage
        });

        renderAttachments();
      };
      reader.readAsDataURL(file);
    }
  }

  function renderAttachments() {
    if (pendingAttachments.length === 0) {
      attachmentsEl.style.display = 'none';
      return;
    }

    attachmentsEl.style.display = 'flex';
    attachmentsEl.innerHTML = '';

    pendingAttachments.forEach((att, idx) => {
      const item = document.createElement('div');
      item.className = 'claude-attachment-item';

      if (att.isImage) {
        const img = document.createElement('img');
        img.src = att.dataUrl;
        img.alt = att.name;
        item.appendChild(img);
      }

      const nameEl = document.createElement('span');
      nameEl.className = 'claude-attachment-name';
      nameEl.textContent = att.name;
      nameEl.title = att.name;
      item.appendChild(nameEl);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'claude-attachment-remove';
      removeBtn.textContent = '\u00D7';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => {
        pendingAttachments.splice(idx, 1);
        renderAttachments();
      });
      item.appendChild(removeBtn);

      attachmentsEl.appendChild(item);
    });
  }

  // ---------------------------------------------------------------------------
  // Helper: get active tab ID
  // ---------------------------------------------------------------------------
  async function getActiveTabId() {
    if (currentTabId) return currentTabId;
    await updateCurrentTab();
    return currentTabId;
  }

  // ---------------------------------------------------------------------------
  // Helper: get brief page context for the AI
  // ---------------------------------------------------------------------------
  function getPageContext(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          resolve(null);
          return;
        }
        resolve({
          url: tab.url || '',
          title: tab.title || '',
          tabId: tab.id,
        });
      });
    });
  }

  // Collect rich page context via CDP
  async function collectRichPageContext(tabId) {
    const ctx = {};
    try {
      const res = await sendCdpCommand(tabId, 'Runtime.evaluate', {
        expression: `(function(){
          var h = []; document.querySelectorAll('h1,h2,h3').forEach(function(e){ h.push(e.tagName + ': ' + e.textContent.trim().substring(0,80)); });
          var forms = document.querySelectorAll('form').length;
          var els = []; document.querySelectorAll('a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="tab"],[role="menuitem"]').forEach(function(e){
            var r = e.getBoundingClientRect();
            if(r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0) {
              var text = (e.textContent || e.value || e.placeholder || e.getAttribute('aria-label') || e.getAttribute('data-testid') || '').trim().substring(0,60);
              if(!text && e.title) text = e.title.substring(0,60);
              els.push({
                tag: e.tagName.toLowerCase(),
                type: e.type || e.getAttribute('role') || e.getAttribute('contenteditable') || '',
                id: e.id || '',
                text: text,
                cx: Math.round(r.x + r.width/2),
                cy: Math.round(r.y + r.height/2),
                w: Math.round(r.width),
                h: Math.round(r.height)
              });
            }
          });
          var links = document.querySelectorAll('a').length;
          var imgs = document.querySelectorAll('img').length;
          var sel = window.getSelection().toString().substring(0,500);
          var body = (document.body && document.body.innerText || '').substring(0, 3000);
          return JSON.stringify({headings: h.slice(0,15), forms: forms, visibleElements: els.slice(0,40), links: links, images: imgs, selectedText: sel, bodyText: body});
        })()`,
        returnByValue: true, awaitPromise: false,
      });
      if (res.status === 'ok' && res.result?.result?.value) {
        try { Object.assign(ctx, JSON.parse(res.result.result.value)); } catch (e) {}
      }
    } catch (e) { /* non-critical */ }

    try {
      const cookieRes = await sendCdpCommand(tabId, 'Network.getCookies', {});
      if (cookieRes.status === 'ok' && cookieRes.result?.cookies) {
        ctx.cookies = cookieRes.result.cookies.slice(0, 10).map(function(c) {
          return c.name + '=' + (c.value || '').substring(0, 30) + (c.value?.length > 30 ? '...' : '');
        });
        ctx.cookieCount = cookieRes.result.cookies.length;
      }
    } catch (e) { /* non-critical */ }

    return ctx;
  }

  // ---------------------------------------------------------------------------
  // Helper: request command data from content script
  // ---------------------------------------------------------------------------
  function requestCommandData(tabId, command, arg) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_COMMAND', command, arg }, (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ error: 'Content script not available' });
          return;
        }
        resolve(response);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Clear chat (end current session)
  // ---------------------------------------------------------------------------
  function clearChat() {
    // Kill persistent CLI process on server
    var sidToKill = activeSessionId || chatSessionId;
    if (sidToKill) {
      fetch(SERVER_URL + '/api/chat/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ sessionId: sidToKill }),
      }).catch(function() {});

      // End session on server
      fetch(SERVER_URL + '/api/user/chat-sessions/' + sidToKill + '/end', {
        method: 'POST',
        headers: getAuthHeaders(),
      }).catch(function() {});

      // Remove session container from DOM
      if (sessions.has(sidToKill)) {
        const session = sessions.get(sidToKill);
        session.el.remove();
        sessions.delete(sidToKill);
      }
      removeSessionFromSelector(sidToKill);
    }

    // Reset state
    conversationHistory = [];
    chatSessionId = null;
    activeSessionId = null;
    isStreaming = false;
    currentStreamText = '';
    pendingAttachments = [];
    renderAttachments();

    // Switch to welcome
    switchToSession(null);

    chrome.runtime.sendMessage({ type: 'CLEAR_SESSION', tabId: currentTabId }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }

  // ---------------------------------------------------------------------------
  // Send button icon management
  // ---------------------------------------------------------------------------
  const SEND_ICON = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  const STOP_ICON = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

  function updateSendButton() {
    if (isStreaming) {
      sendBtn.innerHTML = STOP_ICON;
      sendBtn.title = 'Stop response';
      sendBtn.classList.add('stop-mode');
    } else {
      sendBtn.innerHTML = SEND_ICON;
      sendBtn.title = 'Send';
      sendBtn.classList.remove('stop-mode');
    }
    sendBtn.disabled = false;
  }

  function stopCurrentStream() {
    if (!activeSessionId || !sessions.has(activeSessionId)) return;
    const session = sessions.get(activeSessionId);
    if (!session.isStreaming) return;

    autoExecCancelled = true;
    if (session.abortController) {
      session.abortController.abort();
      session.abortController = null;
    }
    chrome.runtime.sendMessage({ type: 'CANCEL_STREAM', tabId: taskTabId || currentTabId }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
    autoFollowUpCount = 0;
    taskTabId = null;
    session.isStreaming = false;
    isStreaming = false;
    updateSendButton();
    addSystemMessage('Stopped by user.');
  }

  // ---------------------------------------------------------------------------
  // Message queue (per-session)
  // ---------------------------------------------------------------------------
  // Queue is stored on each session object as session.messageQueue = []
  // Global fallback for edge cases
  const globalMessageQueue = [];

  function getMessageQueue() {
    if (activeSessionId && sessions.has(activeSessionId)) {
      const s = sessions.get(activeSessionId);
      if (!s.messageQueue) s.messageQueue = [];
      return s.messageQueue;
    }
    return globalMessageQueue;
  }

  function processQueue() {
    const queue = getMessageQueue();
    if (isStreaming || queue.length === 0) return;
    const next = queue.shift();
    doSendMessage(next.text, next.attachments, true);
  }

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------
  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = '';
    inputEl.style.height = 'auto';

    if (isStreaming) {
      const queuedAttachments = [...pendingAttachments];
      pendingAttachments = [];
      renderAttachments();
      getMessageQueue().push({ text, attachments: queuedAttachments });
      const welcome = messagesEl.querySelector('.claude-welcome');
      if (welcome) welcome.remove();
      addMessageToUI('user', text);
      scrollToBottom();
      return;
    }

    doSendMessage(text, pendingAttachments, false);
    pendingAttachments = [];
    renderAttachments();
  }

  async function doSendMessage(text, attachments, alreadyShown) {
    autoFollowUpCount = 0;
    let tabId = currentTabId;
    if (!tabId) {
      tabId = await getActiveTabId();
    }
    if (!tabId) {
      addSystemMessage('No active tab found.');
      processQueue();
      return;
    }

    if (!authState.isAuthenticated) {
      showAuthOverlay();
      processQueue();
      return;
    }

    const commandResult = await handleCommand(text, tabId);
    if (commandResult === true) { processQueue(); return; }

    let userMessage = text;
    let extraContext = '';
    if (commandResult && typeof commandResult === 'string') {
      extraContext = commandResult;
    }

    // If no active session, create one (first message on this tab)
    const isNewSession = !activeSessionId;
    if (isNewSession) {
      const tempId = 'pending-' + tabId + '-' + Date.now();
      const el = createSessionContainer(tempId);
      sessions.set(tempId, {
        el: el,
        history: [],
        isStreaming: true,
        streamText: '',
        tabId: tabId,
        model: modelSelect.value,
        title: text.substring(0, 50),
        loaded: true,
        inputValue: '',
        inputAttachments: [],
      });
      addSessionToSelector(tempId, text.substring(0, 30) + (text.length > 30 ? '...' : ''));
      switchToSession(tempId);
    }

    // Clear welcome message on first send
    const welcome = messagesEl.querySelector('.claude-welcome');
    if (welcome) welcome.remove();

    // Add user message to UI
    const atts = attachments || [];
    if (!alreadyShown) {
      const msgEl = addMessageToUI('user', text);
      if (atts.length > 0) {
        const bubble = msgEl.querySelector('.claude-message-bubble');
        if (bubble) {
          const imgRow = document.createElement('div');
          imgRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';
          for (const att of atts) {
            if (att.isImage) {
              const img = document.createElement('img');
              img.src = att.dataUrl;
              img.style.cssText = 'max-width:120px;max-height:80px;border-radius:6px;object-fit:cover;';
              imgRow.appendChild(img);
            } else {
              const tag = document.createElement('span');
              tag.style.cssText = 'font-size:10px;background:rgba(255,255,255,0.15);padding:2px 6px;border-radius:4px;';
              tag.textContent = att.name;
              imgRow.appendChild(tag);
            }
          }
          bubble.appendChild(imgRow);
        }
      }
    }

    // Build conversation entry
    const fullUserContent = userMessage + (extraContext ? '\n\n[Context: ' + extraContext + ']' : '');

    const imageAttachments = atts.filter(a => a.isImage);
    const textAttachments = atts.filter(a => !a.isImage);

    let historyContent = fullUserContent;
    if (textAttachments.length > 0) {
      const textParts = textAttachments.map(a => {
        try {
          return '\n\n[File: ' + a.name + ']\n' + atob(a.base64);
        } catch (e) {
          return '\n\n[File: ' + a.name + ' (binary, ' + Math.round(a.base64.length * 3 / 4 / 1024) + 'KB)]';
        }
      });
      historyContent = fullUserContent + textParts.join('');
    }

    if (imageAttachments.length > 0) {
      const contentParts = [];
      for (const img of imageAttachments) {
        contentParts.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
        });
      }
      contentParts.push({ type: 'text', text: historyContent });
      conversationHistory.push({ role: 'user', content: contentParts });
    } else {
      conversationHistory.push({ role: 'user', content: historyContent });
    }

    // Lock task to this tab
    taskTabId = tabId;

    // On first message, collect rich page context
    const isFirstMessage = isNewSession;
    let pageContext = null;
    if (isFirstMessage) {
      try {
        const pageCtx = await getPageContext(tabId);
        const rich = await collectRichPageContext(tabId);
        pageContext = Object.assign({}, pageCtx || {}, rich || {});
      } catch (e) { /* non-critical */ }
    }

    _stepSendTime = Date.now();
    sendViaServerSSE(historyContent, tabId, 0, pageContext);

    isStreaming = true;
    if (activeSessionId && sessions.has(activeSessionId)) {
      sessions.get(activeSessionId).isStreaming = true;
    }
    updateSendButton();
    updateContextMeter();
  }

  // ---------------------------------------------------------------------------
  // Server SSE Chat
  // ---------------------------------------------------------------------------
  async function sendViaServerSSE(userMessage, tabId, retryCount, pageContext, isExec, forSessionId) {
    retryCount = retryCount || 0;

    // Capture target session in closure — this SSE connection belongs to this session
    let targetSid = forSessionId || activeSessionId;

    // Resolve the real sessionId for the server (pending- IDs are local-only)
    const serverSessionId = (targetSid && !targetSid.startsWith('pending-')) ? targetSid : undefined;

    const body = {
      message: userMessage,
      tabId: tabId,
      sessionId: serverSessionId,
    };
    if (pageContext) body.pageContext = pageContext;
    if (isExec) body.isExec = true;

    const controller = new AbortController();
    // Store controller on the session for stopCurrentStream()
    if (targetSid && sessions.has(targetSid)) {
      sessions.get(targetSid).abortController = controller;
    }

    onStreamStart(targetSid);

    try {
      const response = await fetch(SERVER_URL + '/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const status = response.status;

        if (status === 401 && retryCount < 1) {
          const refreshed = await refreshAccessToken();
          if (refreshed) {
            const container = getSessionContainer(targetSid);
            const streamingMsg = container.querySelector('.streaming-msg');
            if (streamingMsg) streamingMsg.remove();
            return sendViaServerSSE(userMessage, tabId, retryCount + 1, pageContext, isExec, targetSid);
          } else {
            clearAuthState();
            showAuthOverlay();
            onStreamError('Session expired. Please sign in again.', targetSid);
            return;
          }
        } else if (status === 402) {
          onStreamError('Insufficient balance. Please add credits to continue.', targetSid);
          return;
        } else if (status === 403) {
          clearAuthState();
          showAuthOverlay();
          onStreamError('Access denied. Please sign in to continue.', targetSid);
          return;
        }

        onStreamError(errorData.error || errorData.message || 'Server error ' + status, targetSid);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullResponse = '';
      let streamEnded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            if (event.type === 'session') {
              const realSessionId = event.sessionId;

              // Upgrade temp session to real session (using closure-captured targetSid)
              if (targetSid && targetSid.startsWith('pending-') && sessions.has(targetSid)) {
                const session = sessions.get(targetSid);
                sessions.delete(targetSid);
                session.el.dataset.sessionId = realSessionId;
                sessions.set(realSessionId, session);

                // Update selector
                removeSessionFromSelector(targetSid);
                addSessionToSelector(realSessionId, session.title);

                // Update active refs if this is the currently viewed session
                if (activeSessionId === targetSid) {
                  activeSessionId = realSessionId;
                  chatSessionId = realSessionId;
                  if (sessionSelect) sessionSelect.value = realSessionId;
                }

                // Update closure target
                targetSid = realSessionId;
              } else {
                // Not a pending upgrade — just record the sessionId
                if (targetSid === activeSessionId) {
                  chatSessionId = realSessionId;
                }
              }
            } else if (event.type === 'delta') {
              fullResponse += event.text;
              onStreamDelta(event.text, targetSid);
            } else if (event.type === 'done' && !streamEnded) {
              const finalText = event.fullText || fullResponse;
              if (event.balance !== undefined && event.balance !== null && userBalanceEl) {
                userBalanceEl.textContent = '$' + event.balance.toFixed(2);
                userBalanceEl.style.display = 'inline-block';
              }
              onStreamEnd(finalText, false, targetSid);
              streamEnded = true;
            } else if (event.type === 'error') {
              onStreamError(event.error || event.message || 'Stream error', targetSid);
              streamEnded = true;
            }
          } catch (e) { /* skip malformed JSON */ }
        }
      }

      if (!streamEnded) {
        onStreamEnd(fullResponse, false, targetSid);
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        const session = sessions.get(targetSid);
        const streamText = session ? session.streamText || '' : '';
        onStreamEnd(streamText, true, targetSid);
      } else {
        let errMsg = error.message || 'Unknown error';
        if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError') || errMsg.includes('ERR_CONNECTION_REFUSED')) {
          errMsg = 'Cannot connect to server at ' + SERVER_URL + '. Is the server running?';
        }
        onStreamError(errMsg, targetSid);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Command handling
  // ---------------------------------------------------------------------------
  async function handleCommand(text, tabId) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (cmd) {
      case '/dom':
      case '/styles':
      case '/errors':
      case '/select':
      case '/structure':
      case '/query':
      case '/storage':
      case '/performance':
      case '/sources': {
        const result = await requestCommandData(tabId, cmd, arg);
        if (result.error) {
          addSystemMessage(result.error);
          return true;
        }
        if (result.displayOnly) {
          addSystemMessage(result.text);
          return true;
        }
        return result.context || null;
      }

      case '/highlight': {
        if (!arg) {
          addSystemMessage('Usage: /highlight <css-selector>');
          return true;
        }
        const result = await requestCommandData(tabId, cmd, arg);
        if (result.error) {
          addSystemMessage('Highlight error: ' + result.error);
        } else {
          addSystemMessage('Highlighted ' + result.highlighted + ' element(s)');
        }
        return true;
      }

      case '/clear': {
        clearChat();
        return true;
      }

      case '/network': {
        chrome.runtime.sendMessage({ type: 'GET_NETWORK_LOG', tabId }, (res) => {
          if (chrome.runtime.lastError) {
            addSystemMessage('Could not retrieve network log.');
            return;
          }
          const log = (res && (res.log || res.entries)) || [];
          if (log.length === 0) {
            addSystemMessage('Network log: No requests captured.');
          } else {
            const w = messagesEl.querySelector('.claude-welcome');
            if (w) w.remove();
            addMessageToUI('user', '/network');
            const contextStr = 'Network log (' + log.length + ' requests):\n' + JSON.stringify(log.slice(0, 50), null, 2);
            const userContent = '/network\n\n[Context: ' + contextStr + ']';
            conversationHistory.push({ role: 'user', content: userContent });
            sendViaServerSSE(userContent, tabId);
            isStreaming = true;
            updateSendButton();
          }
        });
        return true;
      }

      case '/cookies': {
        const docCookies = await requestCommandData(tabId, '/cookies', '');
        chrome.runtime.sendMessage({ type: 'GET_COOKIES', url: docCookies.url || '' }, (res) => {
          if (chrome.runtime.lastError) return;
          const chromeCookies = (res && res.cookies) || [];
          const combined = {
            documentCookies: docCookies.cookies || [],
            chromeCookies: chromeCookies
          };
          const contextStr = 'Cookies for this page:\n' + JSON.stringify(combined, null, 2);

          const w = messagesEl.querySelector('.claude-welcome');
          if (w) w.remove();
          addMessageToUI('user', '/cookies');
          const userContent = '/cookies\n\n[Context: ' + contextStr + ']';
          conversationHistory.push({ role: 'user', content: userContent });
          sendViaServerSSE(userContent, tabId);
          isStreaming = true;
          updateSendButton();
        });
        return true;
      }

      case '/cdp': {
        if (!arg) {
          addSystemMessage('Usage: /cdp <method> [params JSON]\nExample: /cdp Runtime.evaluate {"expression": "1+1"}');
          return true;
        }
        const cdpParts = arg.match(/^(\S+)\s*(.*)?$/);
        const cdpMethod = cdpParts ? cdpParts[1] : arg;
        let cdpParams = {};
        if (cdpParts && cdpParts[2]) {
          try {
            cdpParams = JSON.parse(cdpParts[2]);
          } catch (e) {
            addSystemMessage('Invalid JSON params: ' + e.message);
            return true;
          }
        }

        chrome.runtime.sendMessage({
          type: 'CDP_COMMAND',
          method: cdpMethod,
          params: cdpParams
        }, (res) => {
          if (chrome.runtime.lastError) {
            addSystemMessage('CDP error: ' + chrome.runtime.lastError.message);
            return;
          }
          const contextStr = 'CDP ' + cdpMethod + ' result:\n' + JSON.stringify(res, null, 2);

          const w = messagesEl.querySelector('.claude-welcome');
          if (w) w.remove();
          addMessageToUI('user', '/cdp ' + arg);
          const userContent = '/cdp ' + arg + '\n\n[Context: ' + contextStr + ']';
          conversationHistory.push({ role: 'user', content: userContent });
          sendViaServerSSE(userContent, tabId);
          isStreaming = true;
          updateSendButton();
        });
        return true;
      }

      case '/logs': {
        chrome.runtime.sendMessage({ type: 'GET_EXTENSION_LOGS', count: 50 }, (res) => {
          if (chrome.runtime.lastError) {
            addSystemMessage('Could not retrieve logs: ' + chrome.runtime.lastError.message);
            return;
          }
          const logs = (res && res.logs) || 'No logs';
          addSystemMessage('Extension Logs:\n' + logs);
        });
        return true;
      }

      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Streaming handlers
  // ---------------------------------------------------------------------------
  function onStreamStart(targetSid) {
    if (targetSid && sessions.has(targetSid)) {
      sessions.get(targetSid).streamText = '';
    }
    autoExecCancelled = false;
    const container = getSessionContainer(targetSid);
    const msgEl = createMessageElement('assistant', '');
    msgEl.classList.add('streaming-msg');
    container.appendChild(msgEl);
    if (targetSid === activeSessionId) {
      isStreaming = true;
      updateSendButton();
      scrollToBottom();
    }
  }

  function onStreamContinue(iteration, targetSid) {
    if (targetSid && sessions.has(targetSid)) {
      sessions.get(targetSid).isStreaming = true;
    }
    if (targetSid === activeSessionId) {
      isStreaming = true;
      updateSendButton();
    }
    const container = getSessionContainer(targetSid);
    let msgEl = container.querySelector('.streaming-msg');
    if (!msgEl) {
      msgEl = createMessageElement('assistant', '');
      msgEl.classList.add('streaming-msg');
      container.appendChild(msgEl);
    }
    const session = sessions.get(targetSid);
    const streamText = session ? (session.streamText || '') + '\n\n' : '\n\n';
    if (session) session.streamText = streamText;
    const bubble = msgEl.querySelector('.claude-message-bubble');
    if (bubble) {
      bubble.innerHTML = renderMarkdown(streamText) +
        '<div class="claude-auto-exec-status">Executing step ' + iteration + '...</div>';
    }
    if (targetSid === activeSessionId) scrollToBottom();
  }

  function onStreamDelta(text, targetSid) {
    const session = sessions.get(targetSid);
    const streamText = session ? (session.streamText || '') + text : text;
    if (session) session.streamText = streamText;
    const container = getSessionContainer(targetSid);
    const msgEl = container.querySelector('.streaming-msg');
    if (msgEl) {
      const bubble = msgEl.querySelector('.claude-message-bubble');
      if (bubble) {
        bubble.innerHTML = renderMarkdown(streamText);
        attachCodeActions(bubble);
      }
    }
    if (targetSid === activeSessionId) scrollToBottom();
  }

  // ── Auto-execution loop state ──────────────────────────────────────────────
  let autoFollowUpCount = 0;
  const MAX_AUTO_FOLLOW_UPS = 40;
  let taskTabId = null;
  let autoExecCancelled = false;

  function finishTask(targetSid) {
    autoFollowUpCount = 0;
    taskTabId = null;

    // Update session state
    if (targetSid && sessions.has(targetSid)) {
      const s = sessions.get(targetSid);
      s.isStreaming = false;
      s.streamText = '';
      s.abortController = null;
    }

    // Always update global isStreaming to reflect active session
    if (targetSid === activeSessionId) {
      isStreaming = false;
      updateSendButton();
      updateContextMeter();
    }

    // Process queued messages for the session that just finished
    // (must happen even if user switched away from it)
    if (targetSid && sessions.has(targetSid)) {
      const s = sessions.get(targetSid);
      if (s.messageQueue && s.messageQueue.length > 0) {
        const next = s.messageQueue.shift();
        // Switch back to this session to process the queued message
        if (targetSid !== activeSessionId) {
          switchToSession(targetSid);
        }
        doSendMessage(next.text, next.attachments, true);
        return; // don't call processQueue again
      }
    }

    inputEl.focus();
    processQueue();
  }

  function onStreamEnd(fullText, cancelled, targetSid) {
    const hist = getSessionHistory(targetSid);
    const container = getSessionContainer(targetSid);
    const msgEl = container.querySelector('.streaming-msg');
    if (msgEl) {
      msgEl.classList.remove('streaming-msg');
      if (fullText) {
        const bubble = msgEl.querySelector('.claude-message-bubble');
        if (bubble) {
          bubble.innerHTML = renderMarkdown(fullText);
          attachCodeActions(bubble);
        }
      }
    }

    if (fullText && !cancelled) {
      hist.push({ role: 'assistant', content: fullText });
    }

    if (targetSid === activeSessionId) {
      updateContextMeter();
      scrollToBottom();
    }

    // Auto-execute CDP/JS commands from AI response
    const execTabId = taskTabId || currentTabId;
    const aiResponseMs = _stepSendTime ? (Date.now() - _stepSendTime) : 0;

    if (fullText && !cancelled && execTabId) {
      const execStart = Date.now();
      executeCdpFromResponse(fullText, execTabId).then(cdpResults => {
        const execMs = Date.now() - execStart;
        if (autoExecCancelled) {
          addSystemMessageToContainer(container, 'Stopped by user.');
          finishTask(targetSid);
          return;
        }
        if (cdpResults && cdpResults.length > 0) {
          autoFollowUpCount++;
          if (autoFollowUpCount > MAX_AUTO_FOLLOW_UPS) {
            addSystemMessageToContainer(container, 'Auto-execution limit reached (' + MAX_AUTO_FOLLOW_UPS + ' steps). Type a message to continue.');
            finishTask(targetSid);
            return;
          }

          const stepTotalMs = aiResponseMs + execMs;
          const profile = 'AI: ' + (aiResponseMs / 1000).toFixed(1) + 's | Exec: ' + (execMs / 1000).toFixed(1) + 's | Total: ' + (stepTotalMs / 1000).toFixed(1) + 's';

          const chatResults = formatCdpResultsForChat(cdpResults);
          addSystemMessageToContainer(container, 'Step ' + autoFollowUpCount + ' executed — ' + cdpResults.length + ' command(s) — ' + profile + chatResults);

          const curHist = getSessionHistory(targetSid);
          if (curHist.length > 0) {
            const last = curHist[curHist.length - 1];
            if (last.role === 'assistant') {
              last.content += chatResults;
            }
          }

          const followUpPrompt = formatCdpResultsAsPrompt(cdpResults);
          curHist.push({ role: 'user', content: followUpPrompt });

          if (targetSid && sessions.has(targetSid)) {
            sessions.get(targetSid).isStreaming = true;
          }
          if (targetSid === activeSessionId) {
            isStreaming = true;
            updateSendButton();
          }
          _stepSendTime = Date.now();
          sendViaServerSSE(followUpPrompt, execTabId, 0, null, true, targetSid);
        } else {
          finishTask(targetSid);
        }
      }).catch(e => {
        console.error('CDP auto-exec error:', e);
        finishTask(targetSid);
      });
    } else {
      finishTask(targetSid);
    }
  }

  // ── CDP/JS auto-execution from AI response ─────────────────────────────────

  async function executeCdpFromResponse(responseText, tabId) {
    if (!responseText || !tabId) return null;
    if (autoExecCancelled) return null;

    const results = [];

    const allBlocksRegex = /```(cdp|js|javascript|ext)\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = allBlocksRegex.exec(responseText)) !== null) {
      if (autoExecCancelled) return results;
      const blockType = match[1] === 'javascript' ? 'js' : match[1];
      const rawCmd = match[2].trim();

      if (blockType === 'ext') {
        try {
          const cmd = JSON.parse(rawCmd);
          const res = await handleExtInAutoExec(cmd);
          results.push({ type: 'ext', action: cmd.action, result: JSON.stringify(res, null, 2).substring(0, 5000) });
          if (res.tabId) {
            tabId = res.tabId;
            taskTabId = res.tabId;
          }
        } catch (e) {
          results.push({ type: 'ext_error', action: rawCmd.substring(0, 50), error: e.message });
        }

      } else if (blockType === 'js') {
        try {
          let safeCode = rawCmd.replace(/\b(const|let)\s+/g, 'var ');
          const res = await sendCdpCommand(tabId, 'Runtime.evaluate', {
            expression: safeCode,
            returnByValue: true,
            awaitPromise: true,
            generatePreview: true,
          });
          if (res.status === 'ok') {
            const result = res.result;
            if (result?.exceptionDetails) {
              results.push({ type: 'js_error', error: 'Error: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Unknown error') });
            } else {
              const value = result?.result?.value;
              const preview = result?.result?.preview;
              const desc = result?.result?.description;
              let display;
              if (value !== undefined && value !== null) {
                display = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
              } else if (preview) {
                display = JSON.stringify(preview, null, 2);
              } else if (desc) {
                display = desc;
              } else {
                display = '(' + (result?.result?.type || 'undefined') + ')';
              }
              results.push({ type: 'js', result: display.substring(0, 5000) });
            }
          } else {
            results.push({ type: 'js_error', error: res.error || 'Unknown error' });
          }
        } catch (e) {
          results.push({ type: 'js_error', error: e.message });
        }

      } else if (blockType === 'cdp') {
        try {
          let cmd;
          try {
            cmd = JSON.parse(rawCmd);
          } catch (jsonErr) {
            if (/^(await\s|document\.|window\.|var |let |const |function |\(|Array\.)/.test(rawCmd)) {
              let safeExpr = rawCmd.replace(/\b(const|let)\s+/g, 'var ');
              const res = await sendCdpCommand(tabId, 'Runtime.evaluate', { expression: safeExpr, returnByValue: true, awaitPromise: true });
              if (res.status === 'ok' && !res.result?.exceptionDetails) {
                const val = res.result?.result?.value;
                results.push({ type: 'js', result: (val !== undefined ? (typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)) : '(undefined)').substring(0, 5000) });
              } else {
                results.push({ type: 'js_error', error: res.result?.exceptionDetails?.exception?.description || res.error || 'Unknown error' });
              }
              continue;
            }
            const methodMatch = rawCmd.match(/^([A-Z][a-zA-Z]+\.[a-zA-Z]+)\s*(\{[\s\S]*\})?$/);
            if (methodMatch) {
              const method = methodMatch[1];
              let params = {};
              if (methodMatch[2]) { try { params = JSON.parse(methodMatch[2]); } catch (e) {} }
              const res = await sendCdpCommand(tabId, method, params);
              results.push(res.status === 'ok'
                ? { type: 'cdp', method, result: JSON.stringify(res.result, null, 2).substring(0, 5000) }
                : { type: 'cdp_error', method, error: res.error || 'Unknown error' });
              continue;
            }
            results.push({ type: 'cdp_error', method: rawCmd.substring(0, 50), error: 'Invalid JSON. Use: {"method": "...", "params": {...}}' });
            continue;
          }
          if (cmd.action && !cmd.method) {
            const res = await handleExtInAutoExec(cmd);
            results.push({ type: 'ext', action: cmd.action, result: JSON.stringify(res, null, 2).substring(0, 5000) });
            if (res.tabId) { tabId = res.tabId; taskTabId = res.tabId; }
            continue;
          }
          if (cmd.method) {
            const targetTab = cmd.tabId || tabId;
            if (cmd.method === 'Runtime.evaluate' && cmd.params?.expression) {
              cmd.params.expression = cmd.params.expression.replace(/\b(const|let)\s+/g, 'var ');
            }
            const res = await sendCdpCommand(targetTab, cmd.method, cmd.params || {});
            if (res.status === 'ok') {
              let displayResult = JSON.stringify(res.result, null, 2);
              if (cmd.method === 'Page.captureScreenshot' && res.result?.data) {
                displayResult = '{"screenshot": "captured", "size": ' + res.result.data.length + '}';
              }
              results.push({ type: 'cdp', method: cmd.method, result: (displayResult || '').substring(0, 5000) });
            } else {
              results.push({ type: 'cdp_error', method: cmd.method, error: res.error || 'Unknown error' });
            }
          }
        } catch (e) {
          results.push({ type: 'cdp_error', method: rawCmd.substring(0, 50), error: e.message });
        }
      }
    }

    return results.length > 0 ? results : null;
  }

  async function handleExtInAutoExec(cmd) {
    const action = (cmd.action || '').toLowerCase().replace(/[_\-\s]/g, '');
    if (['switchtab', 'activatetab', 'focustab', 'activate', 'focus', 'selecttab'].includes(action)) {
      const tid = cmd.tabId || cmd.id;
      if (!tid) return { error: 'No tabId provided for ' + cmd.action };
      const tabInfo = await new Promise(resolve => {
        chrome.tabs.update(tid, { active: true }, (tab) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
          } else {
            resolve({ tabId: tab.id, url: tab.url, title: tab.title, status: 'targeted' });
          }
        });
      });
      if (tabInfo.error) return tabInfo;
      try {
        const domRes = await sendCdpCommand(tid, 'Runtime.evaluate', {
          expression: '(function(){ var t = document.title; var u = window.location.href; var text = (document.body && document.body.innerText || "").slice(0, 1000); return JSON.stringify({title: t, url: u, bodyText: text}); })()',
          returnByValue: true,
          awaitPromise: false,
        });
        if (domRes.status === 'ok' && domRes.result?.result?.value) {
          try {
            tabInfo.pageSnapshot = JSON.parse(domRes.result.result.value);
          } catch (e) {
            tabInfo.pageSnapshot = domRes.result.result.value;
          }
        }
      } catch (e) { /* non-critical */ }
      return tabInfo;
    }
    return executeExtCommand(cmd);
  }

  function executeExtCommand(cmd) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'EXT_COMMAND', ...cmd }, response => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { error: 'No response' });
        }
      });
    });
  }

  function sendCdpCommand(tabId, method, params) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'CDP_COMMAND', method, params, tabId }, response => {
        if (chrome.runtime.lastError) {
          resolve({ status: 'error', error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { status: 'error', error: 'No response' });
        }
      });
    });
  }

  function formatCdpResultsForChat(results) {
    return results.map(function (r) {
      if (r.type === 'cdp') return '\n\n---\n**CDP Result** (`' + r.method + '`):\n```json\n' + r.result + '\n```';
      if (r.type === 'cdp_error') return '\n\n---\n**CDP Error** (`' + r.method + '`): ' + r.error;
      if (r.type === 'js') return '\n\n---\n**JS Result:**\n```\n' + r.result + '\n```';
      if (r.type === 'js_error') return '\n\n---\n**JS Error:** ' + r.error;
      if (r.type === 'ext') return '\n\n---\n**Extension** (`' + r.action + '`):\n```json\n' + r.result + '\n```';
      if (r.type === 'ext_error') return '\n\n---\n**Extension Error** (`' + r.action + '`): ' + r.error;
      return '';
    }).join('');
  }

  function formatCdpResultsAsPrompt(results) {
    let prompt = 'Here are the execution results from the commands you provided:\n\n';
    for (const r of results) {
      if (r.type === 'cdp') prompt += 'CDP ' + r.method + ' returned:\n' + r.result + '\n\n';
      if (r.type === 'cdp_error') prompt += 'CDP ' + r.method + ' ERROR: ' + r.error + '\n\n';
      if (r.type === 'js') prompt += 'JS execution returned:\n' + r.result + '\n\n';
      if (r.type === 'js_error') prompt += 'JS execution ERROR: ' + r.error + '\n\n';
      if (r.type === 'ext') prompt += 'Extension ' + r.action + ' returned:\n' + r.result + '\n\n';
      if (r.type === 'ext_error') prompt += 'Extension ' + r.action + ' ERROR: ' + r.error + '\n\n';
    }
    prompt += 'Based on these results, continue with the task. If the task is complete, summarize what was done. If more steps are needed, provide the next CDP/JS commands to execute.';
    return prompt;
  }

  function onStreamError(error, targetSid) {
    if (targetSid && sessions.has(targetSid)) {
      const s = sessions.get(targetSid);
      s.isStreaming = false;
      s.abortController = null;
    }
    if (targetSid === activeSessionId) {
      isStreaming = false;
      updateSendButton();
    }

    const container = getSessionContainer(targetSid);
    const streamingMsg = container.querySelector('.streaming-msg');
    if (streamingMsg) streamingMsg.remove();

    const errorEl = document.createElement('div');
    errorEl.className = 'claude-error-msg';
    errorEl.innerHTML = ICONS.error + '<span>' + escapeHtml(error) + '</span>';
    container.appendChild(errorEl);
    if (targetSid === activeSessionId) scrollToBottom();

    inputEl.focus();
    processQueue();
  }

  // ---------------------------------------------------------------------------
  // Message UI helpers
  // ---------------------------------------------------------------------------
  function addMessageToUI(role, text) {
    const msgEl = createMessageElement(role, text);
    messagesEl.appendChild(msgEl);
    scrollToBottom();
    return msgEl;
  }

  function addSystemMessage(text) {
    addSystemMessageToContainer(messagesEl, text);
  }

  function addSystemMessageToContainer(container, text) {
    const el = document.createElement('div');
    el.className = 'claude-system-msg';
    el.textContent = text;
    container.appendChild(el);
    if (container === messagesEl) scrollToBottom();
  }

  function createMessageElement(role, text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'claude-message claude-message-' + role;

    const label = document.createElement('div');
    label.className = 'claude-message-label';
    label.textContent = role === 'user' ? 'You' : 'AI';
    wrapper.appendChild(label);

    const bubble = document.createElement('div');
    bubble.className = 'claude-message-bubble';

    if (role === 'user') {
      bubble.textContent = text;
    } else {
      if (text) {
        bubble.innerHTML = renderMarkdown(text);
      } else {
        bubble.innerHTML = '<div class="claude-typing"><div class="claude-typing-dot"></div><div class="claude-typing-dot"></div><div class="claude-typing-dot"></div></div>';
      }
    }

    wrapper.appendChild(bubble);

    var timeEl = document.createElement('div');
    timeEl.className = 'claude-message-time';
    var now = new Date();
    timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    wrapper.appendChild(timeEl);

    if (role === 'assistant') {
      const actions = document.createElement('div');
      actions.className = 'claude-message-actions';
      const copyMsgBtn = document.createElement('button');
      copyMsgBtn.className = 'claude-msg-copy-btn';
      copyMsgBtn.title = 'Copy response';
      copyMsgBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
      copyMsgBtn.addEventListener('click', function () {
        const rawText = bubble.innerText || bubble.textContent || '';
        copyToClipboard(rawText).then(function () {
          copyMsgBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
          setTimeout(function () {
            copyMsgBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
          }, 1500);
        });
      });
      actions.appendChild(copyMsgBtn);
      wrapper.appendChild(actions);

      if (text) attachCodeActions(bubble);
    }

    return wrapper;
  }

  // ---------------------------------------------------------------------------
  // Code block actions
  // ---------------------------------------------------------------------------
  function attachCodeActions(bubble) {
    bubble.querySelectorAll('.claude-code-block').forEach(function (block) {
      const copyBtn = block.querySelector('.claude-code-copy');
      if (copyBtn && !copyBtn._bound) {
        copyBtn._bound = true;
        copyBtn.addEventListener('click', function () {
          const code = block.querySelector('pre') ? block.querySelector('pre').textContent : '';
          copyToClipboard(code).then(function () {
            copyBtn.textContent = 'Copied!';
            setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
          }).catch(function () {
            copyBtn.textContent = 'Failed';
            setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
          });
        });
      }

      const header = block.querySelector('.claude-code-header');
      const lang = header ? (header.textContent || '').trim().toLowerCase() : '';
      if (lang.indexOf('query') !== -1 && !block.querySelector('.claude-execute-query')) {
        const code = block.querySelector('pre') ? block.querySelector('pre').textContent.trim() : '';
        const execBtn = document.createElement('button');
        execBtn.className = 'claude-execute-query';
        execBtn.innerHTML = ICONS.highlight + ' Run Query';
        execBtn.addEventListener('click', async function () {
          const tabId = await getActiveTabId();
          if (!tabId) return;
          const result = await requestCommandData(tabId, '/query', code);
          addSystemMessage('Query result: ' + JSON.stringify(result.result || result.error, null, 2).substring(0, 500));
          scrollToBottom();
        });
        block.appendChild(execBtn);
      }
    });

    bubble.querySelectorAll('code:not(.claude-code-block code)').forEach(function (codeEl) {
      const codeText = codeEl.textContent;
      if (/^[.#\[\w][\w\-.\[\]#:= >"'*+~,()]+$/.test(codeText) && codeText.length < 100) {
        if (!codeEl._bound) {
          codeEl._bound = true;
          codeEl.style.cursor = 'pointer';
          codeEl.title = 'Click to highlight on page';
          codeEl.addEventListener('click', async function () {
            const tabId = await getActiveTabId();
            if (!tabId) return;
            await requestCommandData(tabId, '/highlight', codeText);
          });
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Markdown renderer
  // ---------------------------------------------------------------------------
  const AGENT_LANGS = ['cdp', 'js', 'javascript', 'json', 'query'];

  function renderMarkdown(text) {
    if (!text) return '';

    let html = escapeHtml(text);

    html = html.replace(/---\n\*\*(CDP Result|JS Result|CDP Error|JS Error)\*\*[^\n]*\n```(?:\w*)\n([\s\S]*?)```/g, function (match, label, content) {
      const shortLabel = label.replace(' Result', '').replace(' Error', ' Err');
      const icon = label.includes('Error') ? '&#9888;' : '&#9889;';
      const cls = label.includes('Error') ? 'claude-tool-error' : 'claude-tool-ok';
      const preview = content.trim().substring(0, 60).replace(/\n/g, ' ');
      return '<details class="claude-tool-block ' + cls + '"><summary>' +
        '<span class="claude-tool-icon">' + icon + '</span> ' +
        '<span class="claude-tool-label">' + escapeHtml(shortLabel) + '</span>' +
        '<span class="claude-tool-preview">' + escapeHtml(preview) + (content.trim().length > 60 ? '...' : '') + '</span>' +
        '</summary><pre class="claude-tool-content"><code>' + content.trim() + '</code></pre></details>';
    });

    html = html.replace(/---\n\*\*(CDP Error|JS Error)\*\*[^:]*:\s*([^\n]+)/g, function (match, label, errMsg) {
      return '<details class="claude-tool-block claude-tool-error"><summary>' +
        '<span class="claude-tool-icon">&#9888;</span> ' +
        '<span class="claude-tool-label">' + label + '</span>' +
        '<span class="claude-tool-preview">' + escapeHtml(errMsg.substring(0, 60)) + '</span>' +
        '</summary><div class="claude-tool-content">' + escapeHtml(errMsg) + '</div></details>';
    });

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
      const l = (lang || '').toLowerCase();
      const highlighted = highlightSyntax(code.trim(), lang);

      if (AGENT_LANGS.indexOf(l) !== -1) {
        const lines = code.trim().split('\n');
        let summaryText = l.toUpperCase();
        if (l === 'cdp') {
          try {
            const parsed = JSON.parse(code.trim());
            if (parsed.method) summaryText = 'CDP: ' + parsed.method;
          } catch (e) { /* not JSON */ }
        } else if (l === 'js' || l === 'javascript') {
          const firstLine = lines[0].replace(/\/\/\s*/, '').trim();
          summaryText = firstLine.length > 50 ? firstLine.substring(0, 50) + '...' : firstLine;
          if (!summaryText) summaryText = 'JavaScript';
        }

        return '<details class="claude-tool-block claude-tool-code"><summary>' +
          '<span class="claude-tool-icon">&#9881;</span> ' +
          '<span class="claude-tool-label">' + escapeHtml(summaryText) + '</span>' +
          '<span class="claude-tool-lines">' + lines.length + ' line' + (lines.length > 1 ? 's' : '') + '</span>' +
          '</summary><div class="claude-code-block"><div class="claude-code-header"><span>' +
          (lang || 'code') +
          '</span><button class="claude-code-copy">Copy</button></div><pre><code>' +
          highlighted + '</code></pre></div></details>';
      }

      return '<div class="claude-code-block"><div class="claude-code-header"><span>' +
        (lang || 'code') +
        '</span><button class="claude-code-copy">Copy</button></div><pre><code>' +
        highlighted + '</code></pre></div>';
    });

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = '<p>' + html + '</p>';

    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p>(<h[1-4]>)/g, '$1');
    html = html.replace(/(<\/h[1-4]>)<\/p>/g, '$1');
    html = html.replace(/<p>(<div class="claude-code-block">)/g, '$1');
    html = html.replace(/(<\/div>)<\/p>/g, '$1');
    html = html.replace(/<p>(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)<\/p>/g, '$1');
    html = html.replace(/<p>(<details)/g, '$1');
    html = html.replace(/(<\/details>)<\/p>/g, '$1');

    return html;
  }

  // ---------------------------------------------------------------------------
  // Syntax highlighter
  // ---------------------------------------------------------------------------
  function highlightSyntax(code, lang) {
    if (!lang) return code;

    const l = lang.toLowerCase();

    if (['js', 'javascript', 'typescript', 'ts', 'query'].indexOf(l) !== -1) {
      code = code.replace(/\/\/.*/g, function (m) { return '<span class="cm">' + m + '</span>'; });
      code = code.replace(/\/\*[\s\S]*?\*\//g, function (m) { return '<span class="cm">' + m + '</span>'; });
      code = code.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, function (m) { return '<span class="str">' + m + '</span>'; });
      code = code.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
      code = code.replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|typeof|instanceof|try|catch|throw|switch|case|break|default|null|undefined|true|false)\b/g, '<span class="kw">$1</span>');
      code = code.replace(/\b(\w+)\s*(?=\()/g, '<span class="fn">$1</span>');
      code = code.replace(/([\=\+\-\*\/\%\!\&\|\<\>\?]+)/g, '<span class="op">$1</span>');
    } else if (['html', 'xml', 'svg'].indexOf(l) !== -1) {
      code = code.replace(/(&lt;\/?)([\w\-]+)/g, '$1<span class="tag">$2</span>');
      code = code.replace(/(\w+)=(&quot;|&apos;)(.*?)\2/g, '<span class="attr">$1</span>=<span class="str">$2$3$2</span>');
    } else if (['css', 'scss', 'less'].indexOf(l) !== -1) {
      code = code.replace(/\/\*[\s\S]*?\*\//g, function (m) { return '<span class="cm">' + m + '</span>'; });
      code = code.replace(/([\.\#\:\[\]][\w\-\=\~\^\$\*\"\]]+)/g, '<span class="tag">$1</span>');
      code = code.replace(/([\w\-]+)\s*:/g, '<span class="attr">$1</span>:');
      code = code.replace(/:(.+?)(;|$)/g, ':<span class="str">$1</span>$2');
    } else if (['python', 'py'].indexOf(l) !== -1) {
      code = code.replace(/#.*/g, function (m) { return '<span class="cm">' + m + '</span>'; });
      code = code.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, function (m) { return '<span class="str">' + m + '</span>'; });
      code = code.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
      code = code.replace(/\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|raise|with|in|not|and|or|is|None|True|False|self|lambda|yield|pass|break|continue)\b/g, '<span class="kw">$1</span>');
      code = code.replace(/\b(\w+)\s*(?=\()/g, '<span class="fn">$1</span>');
    }

    return code;
  }

  // ---------------------------------------------------------------------------
  // Init context meter on load
  // ---------------------------------------------------------------------------
  updateContextMeter();

})();
