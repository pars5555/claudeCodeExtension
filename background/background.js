// background.js — Service worker for AI Web Assistant
// Handles: CDP, cookies, network log, per-page toggle, OAuth, navigation tracking

const MODEL = 'claude-opus-4-6';

// ─── State ────────────────────────────────────────────────────────────────────

const attachedTabs = new Set();        // tabIds with debugger attached
const cdpState = new Map();            // tabId → { network: bool, fetch: bool }

// ─── Extension Logger ────────────────────────────────────────────────────────
// Collects all logs in-memory so Claude can analyze them without asking the user

const extensionLogs = [];
const MAX_EXT_LOGS = 200;

const ADMIN_PANEL_URL = 'https://webai.pc.am';

function xlog(level, category, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const entry = `[${ts}] [${level}] [${category}] ${msg}`;
  extensionLogs.push(entry);
  if (extensionLogs.length > MAX_EXT_LOGS) extensionLogs.splice(0, extensionLogs.length - MAX_EXT_LOGS);
  console.log(`[WebAI Ext] ${entry}`);

  // Push to admin panel (fire-and-forget)
  pushToAdmin('/api/logs/system', { level, category, message: msg, timestamp: ts });
}

function getRecentLogs(count = 50) {
  return extensionLogs.slice(-count).join('\n');
}

// Push logs to admin panel (best-effort, non-blocking, with auth if available)
function pushToAdmin(path, data) {
  try {
    chrome.storage.local.get(['authAccessToken'], (result) => {
      const headers = { 'Content-Type': 'application/json' };
      if (result.authAccessToken) {
        headers['Authorization'] = 'Bearer ' + result.authAccessToken;
      }
      fetch(ADMIN_PANEL_URL + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(data)
      }).catch(() => {}); // silently fail if admin panel is not running
    });
  } catch (e) { /* ignore */ }
}

function pushChatLog(entry) {
  pushToAdmin('/api/logs/chat', entry);
}

// ─── Service Worker Keep-Alive ────────────────────────────────────────────────
// MV3 service workers die after ~5min of inactivity. Use chrome.alarms to
// keep alive while any session is active.

chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // every 24 seconds

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Just keep the service worker alive
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cdpState.delete(tabId);
  tabNavTiming.delete(tabId);

  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    cdpState.delete(source.tabId);
    cdpNetEvents.delete(source.tabId);
  }
});

// ─── CDP Network Event Capture ───────────────────────────────────────────────
// Listens to all debugger events. When Network is enabled, captures request/response
// metadata with requestIds so AI can later call getResponseBody/getRequestPostData.
const cdpNetEvents = new Map();  // tabId → Array of {requestId, url, method, status, type, size, timing, timestamp}
const MAX_CDP_NET_EVENTS = 200;

chrome.debugger.onEvent.addListener((source, method, params) => {
  var tabId = source.tabId;
  if (!tabId) return;
  var st = cdpState.get(tabId);
  if (!st || !st.network) return;

  if (!cdpNetEvents.has(tabId)) cdpNetEvents.set(tabId, []);
  var events = cdpNetEvents.get(tabId);

  if (method === 'Network.requestWillBeSent') {
    var req = params.request || {};
    events.push({
      requestId: params.requestId,
      url: (req.url || '').substring(0, 500),
      method: req.method || 'GET',
      type: params.type || '',
      hasPostData: req.hasPostData || false,
      timestamp: Date.now(),
      status: null,
      mimeType: null,
      size: null,
      timing: null,
    });
    if (events.length > MAX_CDP_NET_EVENTS) events.splice(0, events.length - MAX_CDP_NET_EVENTS);
  }

  if (method === 'Network.responseReceived') {
    var resp = params.response || {};
    // Find matching request and update with response info
    for (var i = events.length - 1; i >= 0; i--) {
      if (events[i].requestId === params.requestId) {
        events[i].status = resp.status;
        events[i].mimeType = resp.mimeType || '';
        events[i].size = resp.encodedDataLength || 0;
        events[i].timing = resp.timing ? Math.round(resp.timing.receiveHeadersEnd || 0) : null;
        break;
      }
    }
  }

  if (method === 'Network.loadingFinished') {
    for (var i = events.length - 1; i >= 0; i--) {
      if (events[i].requestId === params.requestId) {
        events[i].size = params.encodedDataLength || events[i].size || 0;
        events[i].done = true;
        break;
      }
    }
  }
});

// ─── webNavigation: track page load timing for AI context ────────────────────
const tabNavTiming = new Map(); // tabId → {url, startTime, endTime}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    tabNavTiming.set(details.tabId, { url: details.url, startTime: details.timeStamp, endTime: null });
  }
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) {
    var entry = tabNavTiming.get(details.tabId);
    if (entry) entry.endTime = details.timeStamp;
  }
});

// ─── notifications: notify when long AI tasks complete ───────────────────────
function notifyTaskComplete(title, message) {
  chrome.notifications.create('webai-task-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: title || 'AI Web Assistant',
    message: message || 'Task completed',
  });
}

// ─── sessions: recover recently closed tabs for AI ───────────────────────────
function getRecentlyClosed(maxResults) {
  return chrome.sessions.getRecentlyClosed({ maxResults: maxResults || 5 });
}

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId || null;
  xlog('DEBUG', 'MSG_ROUTER', 'Received:', message.type, 'from tab:', tabId || 'extension');

  switch (message.type) {
    case 'CANCEL_STREAM':
      sendResponse({ status: 'cancelled' });
      return true;

    case 'CDP_COMMAND':
      handleCdpCommand(message, tabId, sendResponse);
      return true;

    case 'CDP_ATTACH':
      handleCdpAttach(tabId, sendResponse);
      return true;

    case 'CDP_DETACH':
      handleCdpDetach(tabId, sendResponse);
      return true;

    case 'GET_COOKIES':
      handleGetCookies(message, sendResponse);
      return true;

    case 'GET_NETWORK_LOG':
      // Legacy: return CDP-captured events instead
      sendResponse({ status: 'ok', entries: cdpNetEvents.get(tabId) || [] });
      return true;

    case 'FLUSH_NET_EVENTS': {
      // Return and clear buffered CDP network events for this tab
      var evts = cdpNetEvents.get(tabId) || [];
      cdpNetEvents.set(tabId, []);
      sendResponse({ events: evts });
      return true;
    }

    case 'GET_PAGE_SOURCES':
      handleGetPageSources(tabId, sendResponse);
      return true;

    case 'OPEN_OPTIONS_PAGE':
      chrome.runtime.openOptionsPage();
      sendResponse({ status: 'ok' });
      return true;

    case 'GET_SETTINGS':
      chrome.storage.sync.get(['model', 'theme'], (result) => {
        sendResponse({
          model: result.model || MODEL,
          theme: result.theme || 'dark',
        });
      });
      return true;

    case 'SET_SETTINGS': {
      const settings = {};
      if (message.model !== undefined) settings.model = message.model;
      if (message.theme !== undefined) settings.theme = message.theme;
      chrome.storage.sync.set(settings, () => {
        sendResponse({ status: 'saved' });
      });
      return true;
    }

    case 'GET_EXTENSION_LOGS':
      sendResponse({ logs: getRecentLogs(message.count || 50) });
      return true;

    case 'GET_NAV_TIMING':
      sendResponse({ timing: tabNavTiming.get(tabId) || null });
      return true;

    case 'GET_RECENTLY_CLOSED':
      getRecentlyClosed(message.maxResults || 5).then(sessions => {
        sendResponse({ sessions });
      });
      return true;

    case 'NOTIFY':
      notifyTaskComplete(message.title, message.message);
      sendResponse({ status: 'ok' });
      return true;

    case 'GET_CDP_STATE':
      sendResponse({ state: cdpState.get(tabId) || { network: false, fetch: false }, attached: attachedTabs.has(tabId) });
      return true;

    case 'CDP_CLEANUP': {
      // Disable Fetch (page freeze safety), optionally disable Network, then detach
      const st = cdpState.get(tabId) || { network: false, fetch: false };
      (async () => {
        try {
          if (st.fetch && attachedTabs.has(tabId)) {
            await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable', {});
            st.fetch = false;
          }
          if (st.network && attachedTabs.has(tabId)) {
            await chrome.debugger.sendCommand({ tabId }, 'Network.disable', {});
            st.network = false;
          }
          cdpState.set(tabId, st);
          if (attachedTabs.has(tabId)) {
            await chrome.debugger.detach({ tabId });
            attachedTabs.delete(tabId);
          }
          cdpState.delete(tabId);
          sendResponse({ status: 'ok', detached: true });
        } catch (e) {
          attachedTabs.delete(tabId);
          cdpState.delete(tabId);
          sendResponse({ status: 'ok', error: e.message });
        }
      })();
      return true;
    }

    case 'CLEAR_SESSION':
      sendResponse({ status: 'ok' });
      return true;

    case 'FETCH_FILE': {
      // Background script can fetch any URL without CORS
      var fileUrl = message.url;
      if (!fileUrl) { sendResponse({ error: 'url required' }); return true; }
      fetch(fileUrl).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var ct = r.headers.get('content-type') || '';
        if (ct.startsWith('image/') || ct.startsWith('application/octet')) {
          return r.blob().then(function(blob) {
            return new Promise(function(resolve) {
              var reader = new FileReader();
              reader.onloadend = function() { resolve({ base64: reader.result.split(',')[1], mediaType: ct, size: blob.size }); };
              reader.readAsDataURL(blob);
            });
          });
        } else {
          return r.text().then(function(text) { return { text: text.substring(0, 50000), mediaType: ct, size: text.length }; });
        }
      }).then(function(data) {
        sendResponse(data);
      }).catch(function(e) {
        sendResponse({ error: e.message });
      });
      return true;
    }

    case 'RESET_ALL':
      chrome.storage.sync.clear(() => {
        chrome.storage.local.clear(() => {
          sendResponse({ status: 'reset' });
        });
      });
      return true;

    // ── Tab Management ────────────────────────────────────────────────────────
    case 'TAB_LIST':
      chrome.tabs.query({}, (tabs) => {
        sendResponse({
          tabs: tabs.map(t => ({
            id: t.id,
            url: t.url,
            title: t.title,
            active: t.active,
            windowId: t.windowId
          }))
        });
      });
      return true;

    case 'TAB_SWITCH':
      if (message.switchTabId) {
        chrome.tabs.update(message.switchTabId, { active: true }, (tab) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, tab: { id: tab.id, url: tab.url, title: tab.title } });
          }
        });
      } else {
        sendResponse({ error: 'No switchTabId provided' });
      }
      return true;

    case 'TAB_CREATE':
      chrome.tabs.create({ url: message.url || 'about:blank', active: message.active !== false }, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, tab: { id: tab.id, url: tab.url, title: tab.title } });
        }
      });
      return true;

    case 'TAB_CLOSE':
      if (message.closeTabId) {
        chrome.tabs.remove(message.closeTabId, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true });
          }
        });
      } else {
        sendResponse({ error: 'No closeTabId provided' });
      }
      return true;

    case 'EXT_COMMAND':
      handleExtCommand(message, sendResponse);
      return true;

    case 'OAUTH_FLOW':
      handleOAuthFlow(message, sendResponse);
      return true;

    case 'GET_SERVER_URL':
      chrome.storage.sync.get(['serverUrl'], (result) => {
        sendResponse({ serverUrl: result.serverUrl || 'https://webai.pc.am' });
      });
      return true;

    default:
      return false;
  }
});

// ─── OAuth Flow ──────────────────────────────────────────────────────────────

async function handleOAuthFlow(message, sendResponse) {
  const { provider, serverUrl } = message;
  const baseUrl = serverUrl || ADMIN_PANEL_URL;
  const authUrl = `${baseUrl}/api/auth/oauth/${provider}`;

  try {
    const redirectUrl = chrome.identity.getRedirectURL();
    const fullUrl = `${authUrl}?redirect_uri=${encodeURIComponent(redirectUrl)}`;

    chrome.identity.launchWebAuthFlow(
      { url: fullUrl, interactive: true },
      (callbackUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
          return;
        }
        if (!callbackUrl) {
          sendResponse({ error: 'OAuth flow was cancelled' });
          return;
        }
        try {
          const url = new URL(callbackUrl);
          const accessToken = url.searchParams.get('accessToken') || url.searchParams.get('access_token');
          const refreshToken = url.searchParams.get('refreshToken') || url.searchParams.get('refresh_token');
          const userJson = url.searchParams.get('user');
          let user = null;
          if (userJson) {
            try { user = JSON.parse(decodeURIComponent(userJson)); } catch (e) {}
          }
          if (accessToken) {
            sendResponse({ accessToken, refreshToken, user });
          } else {
            sendResponse({ error: 'No access token received from OAuth' });
          }
        } catch (e) {
          sendResponse({ error: 'Failed to parse OAuth callback: ' + e.message });
        }
      }
    );
  } catch (e) {
    sendResponse({ error: 'OAuth error: ' + e.message });
  }
}

// ─── Stream Cancel ───────────────────────────────────────────────────────────

// ─── CDP (Chrome DevTools Protocol) ───────────────────────────────────────────

async function handleCdpAttach(tabId, sendResponse) {
  if (!tabId) { sendResponse({ status: 'error', error: 'No tab ID' }); return; }
  if (attachedTabs.has(tabId)) { sendResponse({ status: 'ok', message: 'Already attached' }); return; }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
    sendResponse({ status: 'ok' });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message || 'Failed to attach debugger' });
  }
}

async function handleCdpDetach(tabId, sendResponse) {
  if (!tabId) { sendResponse({ status: 'error', error: 'No tab ID' }); return; }
  if (!attachedTabs.has(tabId)) { sendResponse({ status: 'ok', message: 'Not attached' }); return; }
  try {
    await chrome.debugger.detach({ tabId });
    attachedTabs.delete(tabId);
    sendResponse({ status: 'ok' });
  } catch (error) {
    attachedTabs.delete(tabId);
    sendResponse({ status: 'error', error: error.message });
  }
}

async function handleCdpCommand(message, tabId, sendResponse) {
  if (!tabId) { sendResponse({ status: 'error', error: 'No tab ID' }); return; }
  if (!message.method) { sendResponse({ status: 'error', error: 'No CDP method' }); return; }
  try {
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedTabs.add(tabId);
    }
    const result = await chrome.debugger.sendCommand({ tabId }, message.method, message.params || {});

    // Track Network/Fetch state per tab
    var method = message.method;
    if (method === 'Network.enable' || method === 'Network.disable' ||
        method === 'Fetch.enable' || method === 'Fetch.disable') {
      var state = cdpState.get(tabId) || { network: false, fetch: false };
      if (method === 'Network.enable') state.network = true;
      if (method === 'Network.disable') state.network = false;
      if (method === 'Fetch.enable') state.fetch = true;
      if (method === 'Fetch.disable') state.fetch = false;
      cdpState.set(tabId, state);
    }

    sendResponse({ status: 'ok', result });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message || `CDP "${message.method}" failed` });
  }
}

// ─── Cookies / Network / Sources ──────────────────────────────────────────────

async function handleGetCookies(message, sendResponse) {
  if (!message.url) { sendResponse({ status: 'error', error: 'No URL' }); return; }
  try {
    const cookies = await chrome.cookies.getAll({ url: message.url });
    sendResponse({
      status: 'ok',
      cookies: cookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        expirationDate: c.expirationDate,
      })),
    });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

async function handleGetPageSources(tabId, sendResponse) {
  if (!tabId) { sendResponse({ status: 'error', error: 'No tab ID' }); return; }
  try {
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedTabs.add(tabId);
    }
    const tree = await chrome.debugger.sendCommand({ tabId }, 'Page.getResourceTree', {});
    const resources = [];
    if (tree?.frameTree?.resources) {
      for (const resource of tree.frameTree.resources) {
        const entry = { url: resource.url, type: resource.type, mimeType: resource.mimeType };
        if (['Document', 'Stylesheet', 'Script'].includes(resource.type)) {
          try {
            const content = await chrome.debugger.sendCommand({ tabId }, 'Page.getResourceContent', {
              frameId: tree.frameTree.frame.id, url: resource.url,
            });
            if (content?.content) {
              entry.content = content.content.substring(0, 5000);
              entry.truncated = content.content.length > 5000;
            }
          } catch (e) { entry.contentError = e.message; }
        }
        resources.push(entry);
      }
    }
    sendResponse({ status: 'ok', resources });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

// ─── Chrome API Bridge (from AI ```ext blocks) ─────────────────────────────────
// Generic bridge: AI sends {"api": "chrome.tabs.query", "args": [{}]}
// Extension resolves the API path and calls it with the provided args.

// Block only dangerous APIs that could break the extension or cause harm
const CHROME_API_BLOCKLIST = new Set([
  'chrome.runtime.reload',            // would restart the extension mid-session
  'chrome.runtime.sendMessage',        // could create message loops
  'chrome.runtime.sendNativeMessage',  // native messaging — not needed
  'chrome.management.uninstallSelf',   // self-destruct
  'chrome.management.setEnabled',      // disable other extensions
  'chrome.browsingData.remove',        // wipe browsing data
  'chrome.browsingData.removeHistory', // wipe history
  'chrome.browsingData.removeCookies', // wipe all cookies
  'chrome.browsingData.removeCache',   // wipe cache
]);

function handleExtCommand(message, sendResponse) {
  // New generic format: {"api": "chrome.tabs.query", "args": [{}]}
  if (message.api) {
    handleChromeApiBridge(message, sendResponse);
    return;
  }

  // Legacy format: {"action": "listTabs"} — translate to new format
  if (message.action) {
    const legacy = translateLegacyAction(message);
    if (legacy) {
      handleChromeApiBridge(legacy, sendResponse);
    } else {
      sendResponse({ error: 'Unknown legacy action: "' + message.action + '". Use new format: {"api": "chrome.tabs.query", "args": [{}]}' });
    }
    return;
  }

  sendResponse({ error: 'Invalid ext block. Use: {"api": "chrome.tabs.query", "args": [{}]}' });
}

function translateLegacyAction(message) {
  const n = (message.action || '').toLowerCase().replace(/[_\-\s]/g, '');
  if (['listtabs', 'gettabs', 'tabs', 'getalltabs', 'tablist'].includes(n))
    return { api: 'chrome.tabs.query', args: [{}] };
  if (['switchtab', 'activatetab', 'focustab'].includes(n))
    return { api: 'chrome.tabs.update', args: [message.tabId || message.id, { active: true }] };
  if (['createtab', 'newtab', 'opentab', 'open'].includes(n))
    return { api: 'chrome.tabs.create', args: [{ url: message.url || 'about:blank', active: message.active !== false }] };
  if (['closetab', 'removetab', 'close'].includes(n))
    return { api: 'chrome.tabs.remove', args: [message.tabId || message.id] };
  if (['screenshot', 'takescreenshot', 'capturescreenshot'].includes(n))
    return { api: 'chrome.tabs.captureVisibleTab', args: [null, { format: 'jpeg', quality: 60 }] };
  return null;
}

async function handleChromeApiBridge(message, sendResponse) {
  const apiPath = message.api;
  const args = message.args || [];

  xlog('DEBUG', 'CHROME_API', apiPath, JSON.stringify(args).substring(0, 200));

  // Block dangerous APIs only
  if (CHROME_API_BLOCKLIST.has(apiPath)) {
    sendResponse({ error: 'API blocked for safety: "' + apiPath + '"' });
    return;
  }

  // Virtual APIs (not on chrome.* object)
  if (apiPath === 'webai.fetchFile') {
    var url = args[0];
    if (!url) { sendResponse({ error: 'URL required' }); return; }
    fetch(url).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var ct = r.headers.get('content-type') || '';
      if (ct.startsWith('image/') || ct.startsWith('application/octet')) {
        return r.blob().then(function(blob) {
          return new Promise(function(resolve) {
            var reader = new FileReader();
            reader.onloadend = function() { resolve({ result: { base64: reader.result.split(',')[1], mediaType: ct, size: blob.size } }); };
            reader.readAsDataURL(blob);
          });
        });
      } else {
        return r.text().then(function(text) { return { result: { text: text.substring(0, 50000), mediaType: ct, size: text.length } }; });
      }
    }).then(function(data) { sendResponse(data); }).catch(function(e) { sendResponse({ error: e.message }); });
    return;
  }

  if (apiPath === 'webai.listFiles') {
    var sessionId = args[0];
    if (!sessionId) { sendResponse({ error: 'sessionId required' }); return; }
    chrome.storage.local.get(['devConfig'], function(r) {
      var server = (r.devConfig && r.devConfig.server) || 'https://webai.pc.am';
      chrome.storage.local.get(['authAccessToken'], function(auth) {
        var headers = auth.authAccessToken ? { 'Authorization': 'Bearer ' + auth.authAccessToken } : {};
        fetch(server + '/api/files/' + sessionId, { headers: headers }).then(function(r) { return r.json(); }).then(function(data) {
          sendResponse({ result: data });
        }).catch(function(e) { sendResponse({ error: e.message }); });
      });
    });
    return;
  }

  // Must start with chrome.
  if (!apiPath.startsWith('chrome.')) {
    sendResponse({ error: 'API path must start with "chrome." or "webai.": "' + apiPath + '"' });
    return;
  }

  // Auto-resolve relative paths in notifications iconUrl
  if (apiPath === 'chrome.notifications.create' || apiPath === 'chrome.notifications.update') {
    var optIdx = apiPath === 'chrome.notifications.create' ? 1 : 1;
    var opts = args[optIdx];
    if (opts && opts.iconUrl && !opts.iconUrl.startsWith('http') && !opts.iconUrl.startsWith('data:') && !opts.iconUrl.startsWith('chrome-extension://')) {
      opts.iconUrl = chrome.runtime.getURL(opts.iconUrl);
    }
  }

  // Resolve the function from chrome object
  const parts = apiPath.replace(/^chrome\./, '').split('.');
  let fn = chrome;
  let parent = chrome;
  for (let i = 0; i < parts.length; i++) {
    parent = fn;
    fn = fn[parts[i]];
    if (fn === undefined) {
      sendResponse({ error: 'API not available: "' + apiPath + '" — "' + parts[i] + '" is undefined. Check manifest permissions.' });
      return;
    }
  }

  if (typeof fn !== 'function') {
    sendResponse({ error: '"' + apiPath + '" is not a function (type: ' + typeof fn + ')' });
    return;
  }

  try {
    // MV3: all chrome.* APIs return promises when no callback is passed
    const result = await fn.apply(parent, args);

    // Truncate large results (e.g. screenshots, MHTML)
    let serialized;
    try {
      serialized = JSON.stringify(result);
      if (serialized && serialized.length > 50000) {
        serialized = serialized.substring(0, 50000);
        sendResponse({ result: JSON.parse(serialized + '"}'), _truncated: true });
        return;
      }
    } catch (e) { /* non-serializable, handled below */ }

    sendResponse({ result: result });
  } catch (e) {
    sendResponse({ error: e.message || 'API call failed' });
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────
