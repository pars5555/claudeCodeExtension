// sessions.js — Session management, tab tracking, clear chat
'use strict';

// ---------------------------------------------------------------------------
// Tab switch detection
// ---------------------------------------------------------------------------
async function updateCurrentTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs[0];
  if (!tab) return;

  var oldTabId = currentTabId;
  var tabChanged = oldTabId !== null && oldTabId !== tab.id;

  currentTabId = tab.id;
  currentTabInfo = { url: tab.url || '', title: tab.title || '' };

  if (tabChanged || oldTabId === null) {
    if (tabChanged) saveActiveSessionState();

    var sessionForTab = findSessionByTabId(tab.id);
    if (sessionForTab) {
      switchToSession(sessionForTab);
    } else if (tabChanged) {
      switchToSession(null);
    }
  }

  updateTabIndicator();
  updateSessionSelector();
}

function updateTabIndicator() {
  var indicator = document.getElementById('wai-tab-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'wai-tab-indicator';
    indicator.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 14px;font-size:11px;color:#64748b;background:rgba(124,58,237,0.05);border-bottom:1px solid rgba(124,58,237,0.1);flex-shrink:0;';
    var header = document.getElementById('wai-panel-header');
    header.parentNode.insertBefore(indicator, header.nextSibling);

    var label = document.createElement('span');
    label.id = 'wai-tab-indicator-label';
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
    indicator.appendChild(label);

    if (sessionSelect) {
      sessionSelect.style.marginLeft = 'auto';
      sessionSelect.style.flexShrink = '0';
      indicator.appendChild(sessionSelect);
    }

    var filesBtn = document.createElement('button');
    filesBtn.id = 'wai-files-btn';
    filesBtn.title = 'Session files';
    filesBtn.style.cssText = 'flex-shrink:0;border:none;background:transparent;color:#64748b;cursor:pointer;padding:2px;display:none;align-items:center;';
    filesBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" fill="currentColor"/></svg>';
    filesBtn.addEventListener('click', toggleFilesDrawer);
    indicator.appendChild(filesBtn);

    if (clearBtn) {
      clearBtn.style.flexShrink = '0';
      indicator.appendChild(clearBtn);
    }
  }
  var host = '';
  try { host = currentTabInfo.url ? new URL(currentTabInfo.url).hostname : ''; } catch (e) {}
  var sid = activeSessionId || chatSessionId;
  var labelEl = document.getElementById('wai-tab-indicator-label');
  var text = (host || currentTabInfo.title || 'No page') + '  \u00b7  tab:' + (currentTabId || '?') + (sid ? '  \u00b7  ' + sid.slice(0, 8) : '');
  if (labelEl) labelEl.textContent = text;
  indicator.title = (currentTabInfo.url || '') + '\nTab ID: ' + (currentTabId || '?') + (sid ? '\nSession: ' + sid : '');

  var tabContextLabel = document.getElementById('wai-tab-context-label');
  if (tabContextLabel) {
    var title = currentTabInfo.title || '';
    var lbl = host ? host + (title ? ' \u2014 ' + title : '') : title || 'No page';
    tabContextLabel.textContent = lbl;
    tabContextLabel.title = currentTabInfo.url;
  }
}

// ---------------------------------------------------------------------------
// Session container management
// ---------------------------------------------------------------------------
function createSessionContainer(sessionId) {
  var el = document.createElement('div');
  el.className = 'session-container';
  el.dataset.sessionId = sessionId;
  sessionsWrapper.appendChild(el);
  el.addEventListener('scroll', function () {
    var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    _autoScroll = atBottom;
  });
  return el;
}

function saveActiveSessionState() {
  if (activeSessionId && sessions.has(activeSessionId)) {
    var s = sessions.get(activeSessionId);
    s.history = conversationHistory;
    s.streamText = currentStreamText;
    s.inputValue = inputEl.value;
    s.inputAttachments = [].concat(pendingAttachments);
    s.model = modelSelect.value;
    s.promptType = promptSelect.value || 'general';
    s.tabUrl = currentTabInfo.url || s.tabUrl;
  }
}

function switchToSession(sessionId) {
  saveActiveSessionState();

  sessionsWrapper.querySelectorAll('.session-container').forEach(function (c) {
    c.classList.remove('active');
  });

  if (!sessionId || !sessions.has(sessionId)) {
    welcomeContainer.classList.add('active');
    messagesEl = welcomeContainer;
    activeSessionId = null;
    conversationHistory = [];
    chatSessionId = null;
    currentStreamText = '';
    pendingAttachments = [];
    renderAttachments();
    inputEl.disabled = false;
    inputEl.placeholder = 'Message...';
    if (_skipModelRestore) {
      _skipModelRestore = false;
    } else {
      chrome.storage.sync.get(['model'], function (result) {
        if (result.model && modelSelect) {
          modelSelect.value = result.model;
          _prevModel = result.model;
        }
      });
    }
    if (promptSelect) {
      promptSelect.value = 'general';
      _prevPromptType = 'general';
    }
  } else {
    welcomeContainer.classList.remove('active');
    var session = sessions.get(sessionId);
    session.el.classList.add('active');
    messagesEl = session.el;
    activeSessionId = sessionId;
    conversationHistory = session.history;
    chatSessionId = sessionId;
    currentStreamText = session.streamText || '';
    inputEl.value = session.inputValue || '';
    inputEl.style.height = 'auto';
    pendingAttachments = session.inputAttachments || [];
    renderAttachments();
    if (session.model && modelSelect) {
      modelSelect.value = session.model;
      _prevModel = session.model;
    }
    if (session.promptType && promptSelect) {
      promptSelect.value = session.promptType;
      _prevPromptType = session.promptType;
    }
    var isOtherTab = session.tabId && session.tabId !== currentTabId;
    var disabledBanner = session.el.querySelector('.session-disabled-banner');
    if (isOtherTab) {
      inputEl.disabled = true;
      inputEl.placeholder = 'Switch to the original tab to continue this chat';
      sendBtn.disabled = true;
      sendBtn.style.opacity = '0.3';
      sendBtn.style.pointerEvents = 'none';
      if (modelSelect) modelSelect.disabled = true;
      if (promptSelect) promptSelect.disabled = true;
      if (!disabledBanner) {
        var banner = document.createElement('div');
        banner.className = 'session-disabled-banner';
        banner.style.cssText = 'padding:8px 12px;background:rgba(251,191,36,0.1);border-bottom:1px solid rgba(251,191,36,0.2);font-size:12px;color:#fbbf24;text-align:center;cursor:pointer;position:sticky;top:0;z-index:10;';
        banner.textContent = 'This chat is on another tab. Click to switch.';
        banner.addEventListener('click', async function () {
          try {
            await chrome.tabs.update(session.tabId, { active: true });
          } catch (e) {
            // Tab was closed — open a new one and re-bind the session to it.
            try {
              var newTab = await chrome.tabs.create({ active: true });
              session.tabId = newTab.id;
              currentTabId = newTab.id;
              // Refresh UI so banner goes away and input becomes enabled.
              switchToSession(session.el && session.el.dataset ? session.el.dataset.sessionId : activeSessionId);
            } catch (_) { /* give up silently */ }
          }
        });
        session.el.insertBefore(banner, session.el.firstChild);
      }
    } else {
      inputEl.disabled = false;
      inputEl.placeholder = 'Message...';
      sendBtn.disabled = false;
      sendBtn.style.opacity = '';
      sendBtn.style.pointerEvents = '';
      if (modelSelect) modelSelect.disabled = false;
      if (promptSelect) promptSelect.disabled = false;
      if (disabledBanner) disabledBanner.remove();
    }
  }

  if (sessionSelect) sessionSelect.value = sessionId || '';
  updateTabIndicator();
  updateSendButton();
  updateContextMeter();
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Session lookup / selector
// ---------------------------------------------------------------------------
function findSessionByTabId(tabId) {
  for (var entry of sessions) {
    if (entry[1].tabId === tabId) return entry[0];
  }
  return null;
}

function addSessionToSelector(sessionId, title) {
  if (!sessionSelect) return;
  if (!title) return;
  for (var i = 0; i < sessionSelect.options.length; i++) {
    if (sessionSelect.options[i].value === sessionId) {
      sessionSelect.options[i].textContent = title;
      return;
    }
  }
  var option = document.createElement('option');
  option.value = sessionId;
  option.textContent = title;
  sessionSelect.appendChild(option);
  sessionSelect.style.display = '';
}

function removeSessionFromSelector(sessionId) {
  if (!sessionSelect) return;
  for (var i = 0; i < sessionSelect.options.length; i++) {
    if (sessionSelect.options[i].value === sessionId) {
      sessionSelect.options[i].remove();
      break;
    }
  }
  if (sessionSelect.options.length === 0) sessionSelect.style.display = 'none';
}

async function updateSessionSelector() {
  if (!sessionSelect) return;
  sessionSelect.innerHTML = '';
  var openTabIds = new Set();
  try {
    var tabs = await chrome.tabs.query({ currentWindow: true });
    tabs.forEach(function (t) { openTabIds.add(t.id); });
  } catch (e) { openTabIds = null; }
  var optionCount = 0;
  for (var entry of sessions) {
    var sid = entry[0], s = entry[1];
    if (s.tabId && openTabIds && !openTabIds.has(s.tabId)) {
      sessions.delete(sid);
      continue;
    }
    if (sid.startsWith('pending-')) continue;
    if (!s.title) continue;
    var isActiveTab = s.tabId === currentTabId;
    var title = s.title + (isActiveTab ? ' \u2605' : '');
    var option = document.createElement('option');
    option.value = sid;
    option.textContent = title;
    sessionSelect.appendChild(option);
    optionCount++;
  }
  sessionSelect.style.display = optionCount > 0 ? '' : 'none';
  sessionSelect.value = activeSessionId || '';
}

// ---------------------------------------------------------------------------
// Load sessions from server
// ---------------------------------------------------------------------------
async function loadUserSessions() {
  if (!authState.accessToken) return;
  try {
    var res = await fetch(SERVER_URL + '/api/user/chat-sessions', {
      headers: getAuthHeaders()
    });
    if (!res.ok) return;
    var data = await res.json();
    var serverSessions = data.sessions || [];

    var openTabs = [];
    try { openTabs = await chrome.tabs.query({}); } catch (e) {}
    var tabIdSet = new Set(openTabs.map(function (t) { return t.id; }));

    var loadedTabIds = new Set();
    for (var i = 0; i < serverSessions.length; i++) {
      var s = serverSessions[i];
      if (sessions.has(s.id)) continue;
      if (!s.tab_id || !tabIdSet.has(s.tab_id)) continue;
      if (loadedTabIds.has(s.tab_id)) continue;
      if (!s.first_message && s.message_count === 0) continue;
      loadedTabIds.add(s.tab_id);

      var el = createSessionContainer(s.id);
      sessions.set(s.id, {
        el: el,
        history: [],
        isStreaming: false,
        streamText: '',
        tabId: s.tab_id,
        taskTabId: s.tab_id,
        autoFollowUpCount: 0,
        autoExecCancelled: false,
        stepSendTime: 0,
        messageQueue: [],
        model: s.model || '',
        promptType: s.prompt_type || 'general',
        title: s.title || s.first_message || s.id.slice(0, 8),
        firstMessage: s.first_message || '',
        loaded: false,
        inputValue: '',
        inputAttachments: [],
      });

      loadSessionMessages(s.id, el);
    }
    updateSessionSelector();
  } catch (e) { reportError('SESSIONS', 'loadUserSessions failed: ' + (e.message || e)); }
}

async function loadSessionMessages(sessionId, container) {
  try {
    var res = await fetch(SERVER_URL + '/api/user/chat-sessions/' + sessionId + '/messages', {
      headers: getAuthHeaders()
    });
    if (!res.ok) return;
    var data = await res.json();
    var msgs = (data.messages || []).filter(function (m) { return m.role === 'user' || m.role === 'assistant'; });
    if (msgs.length === 0) {
      container.innerHTML = '<div class="wai-welcome"><p style="color:#64748b;font-size:13px;">Empty session</p></div>';
      return;
    }

    container.innerHTML = '';
    var history = [];
    msgs.forEach(function (m) {
      var msgEl = createMessageElement(m.role, m.content || '');
      container.appendChild(msgEl);
      history.push({ role: m.role, content: m.content || '' });
    });

    var session = sessions.get(sessionId);
    if (session) {
      session.history = history;
      session.loaded = true;
    }
  } catch (e) { reportError('SESSIONS', 'loadSessionMessages failed for ' + sessionId + ': ' + (e.message || e)); }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
function getSessionContainer(sid) {
  if (sid && sessions.has(sid)) return sessions.get(sid).el;
  return messagesEl;
}

function getSessionHistory(sid) {
  if (sid && sessions.has(sid)) return sessions.get(sid).history;
  return conversationHistory;
}

function getActiveTabId() {
  if (currentTabId) return Promise.resolve(currentTabId);
  return updateCurrentTab().then(function () { return currentTabId; });
}

// ---------------------------------------------------------------------------
// Clear chat (end current session)
// ---------------------------------------------------------------------------
function clearChat() {
  var sidToKill = activeSessionId || chatSessionId;
  if (sidToKill) {
    fetch(SERVER_URL + '/api/chat/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ sessionId: sidToKill }),
    }).catch(function () {});

    fetch(SERVER_URL + '/api/user/chat-sessions/' + sidToKill + '/end', {
      method: 'POST',
      headers: getAuthHeaders(),
    }).catch(function () {});

    fetch(SERVER_URL + '/api/files/' + sidToKill, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    }).catch(function () {});
    if (sessions.has(sidToKill) && sessions.get(sidToKill).pendingId) {
      fetch(SERVER_URL + '/api/files/' + sessions.get(sidToKill).pendingId, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      }).catch(function () {});
    }

    if (sessions.has(sidToKill)) {
      var session = sessions.get(sidToKill);
      session.el.remove();
      sessions.delete(sidToKill);
    }
    removeSessionFromSelector(sidToKill);
  }

  conversationHistory = [];
  chatSessionId = null;
  activeSessionId = null;
  currentStreamText = '';
  pendingAttachments = [];
  renderAttachments();

  switchToSession(null);

  // Refresh model list on every new chat so admin changes show up immediately
  if (typeof loadModelsFromServer === 'function') loadModelsFromServer();

  chrome.runtime.sendMessage({ type: 'CLEAR_SESSION', tabId: currentTabId }, function () {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// Session files drawer
// ---------------------------------------------------------------------------
function toggleFilesDrawer() {
  var drawer = document.getElementById('wai-files-drawer');
  if (!drawer) return;
  if (drawer.style.display === 'none') {
    drawer.style.display = '';
    loadSessionFiles();
  } else {
    drawer.style.display = 'none';
  }
}

async function loadSessionFiles() {
  var sid = activeSessionId || chatSessionId;
  var grid = document.getElementById('wai-files-grid');
  var empty = document.getElementById('wai-files-empty');
  if (!grid || !sid) return;
  grid.innerHTML = '';

  var idsToTry = [sid];
  if (sessions.has(sid) && sessions.get(sid).pendingId) {
    idsToTry.push(sessions.get(sid).pendingId);
  }
  var tabId = sessions.has(sid) ? sessions.get(sid).tabId : currentTabId;
  sessions.forEach(function (s, key) {
    if (key.startsWith('pending-') && s.tabId === tabId && idsToTry.indexOf(key) === -1) idsToTry.push(key);
  });

  try {
    var files = [];
    for (var i = 0; i < idsToTry.length; i++) {
      var resp = await fetch(SERVER_URL + '/api/files/' + idsToTry[i], { headers: getAuthHeaders() });
      if (resp.ok) {
        var data = await resp.json();
        if (data.files && data.files.length > 0) files = files.concat(data.files);
      }
    }
    if (files.length === 0) { empty.style.display = ''; return; }
    empty.style.display = 'none';
    files.forEach(function (f) {
      var item = document.createElement('div');
      item.style.cssText = 'position:relative;cursor:pointer;border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);';
      var fileUrl = SERVER_URL + f.url;
      item.title = f.name + '\nClick: attach to chat\nRight-click: download';
      var isImage = f.mediaType && f.mediaType.startsWith('image/');
      if (isImage) {
        var img = document.createElement('img');
        img.src = fileUrl;
        img.crossOrigin = 'anonymous';
        img.style.cssText = 'width:60px;height:60px;object-fit:cover;display:block;';
        img.onerror = function () {
          this.style.display = 'none';
          this.parentNode.insertAdjacentHTML('afterbegin', '<div style="width:60px;height:60px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(124,58,237,0.1);font-size:9px;color:#94a3b8;"><div style="font-size:14px;">\ud83d\uddbc</div>' + f.name.substring(0, 12) + '</div>');
        };
        item.appendChild(img);
      } else {
        var labelDiv = document.createElement('div');
        labelDiv.style.cssText = 'width:60px;height:60px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(124,58,237,0.1);font-size:9px;color:#94a3b8;text-align:center;padding:4px;';
        labelDiv.innerHTML = '<div style="font-size:14px;margin-bottom:2px;">\ud83d\udcc4</div><div style="word-break:break-all;">' + f.name.substring(0, 15) + '</div>';
        item.appendChild(labelDiv);
      }
      item.addEventListener('click', function () {
        var a = document.createElement('a');
        a.href = fileUrl;
        a.download = f.name;
        a.click();
      });
      item.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var old = document.getElementById('wai-file-ctx-menu');
        if (old) old.remove();
        var menu = document.createElement('div');
        menu.id = 'wai-file-ctx-menu';
        menu.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;background:#1e1f36;border:1px solid rgba(255,255,255,0.15);border-radius:8px;min-width:160px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.5);overflow:hidden;font-size:12px;';

        var items = [
          { label: 'Download', icon: '\u2b07', action: function () { var a = document.createElement('a'); a.href = fileUrl; a.download = f.name; a.click(); } },
          {
            label: 'Mention in chat', icon: '\ud83d\udcac', action: function () {
              chrome.runtime.sendMessage({ type: 'FETCH_FILE', url: fileUrl }, function (data) {
                if (data && data.base64) {
                  pendingAttachments.push({ name: f.name, type: f.mediaType, dataUrl: 'data:' + f.mediaType + ';base64,' + data.base64, base64: data.base64, mediaType: f.mediaType, isImage: isImage });
                } else if (data && data.text) {
                  pendingAttachments.push({ name: f.name, type: f.mediaType, base64: btoa(unescape(encodeURIComponent(data.text))), mediaType: f.mediaType, isImage: false });
                }
                renderAttachments();
                inputEl.focus();
              });
              var drawer = document.getElementById('wai-files-drawer');
              if (drawer) drawer.style.display = 'none';
            }
          },
          {
            label: 'Delete', icon: '\ud83d\uddd1', color: '#f87171', action: function () {
              var fileName = f.url.split('/').pop();
              var sessionId = f.url.split('/').slice(-2, -1)[0];
              fetch(SERVER_URL + '/api/files/' + sessionId + '/' + fileName, { method: 'DELETE', headers: getAuthHeaders() }).catch(function () {});
              item.remove();
            }
          },
        ];

        items.forEach(function (mi) {
          var row = document.createElement('div');
          row.style.cssText = 'padding:8px 14px;cursor:pointer;color:' + (mi.color || '#e2e8f0') + ';';
          row.textContent = mi.icon + '  ' + mi.label;
          row.addEventListener('mouseenter', function () { row.style.background = 'rgba(124,58,237,0.15)'; });
          row.addEventListener('mouseleave', function () { row.style.background = ''; });
          row.addEventListener('click', function () { mi.action(); menu.remove(); });
          menu.appendChild(row);
        });

        document.body.appendChild(menu);
        setTimeout(function () {
          document.addEventListener('click', function closeCtx() { menu.remove(); document.removeEventListener('click', closeCtx); }, { once: true });
        }, 50);
      });
      grid.appendChild(item);
    });
  } catch (e) {
    empty.style.display = '';
  }
}
