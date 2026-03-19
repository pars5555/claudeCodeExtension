// background.js — Service worker for AI Web Assistant
// Handles: CDP, cookies, network log, per-page toggle, OAuth

const MODEL = 'claude-opus-4-6';
const MAX_TOKENS = 4096;

// ─── State ────────────────────────────────────────────────────────────────────

const activeStreams = new Map();       // tabId → AbortController
const networkLogs = new Map();         // tabId → Array of request entries
const MAX_NETWORK_LOG = 100;
const attachedTabs = new Set();        // tabIds with debugger attached
const tabSessions = new Map();         // tabId → { sessionId: UUID, messageCount: number }

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

// ─── Network Request Logging ──────────────────────────────────────────────────

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId < 0) return;

    if (!networkLogs.has(tabId)) {
      networkLogs.set(tabId, []);
    }

    const log = networkLogs.get(tabId);
    log.push({
      url: details.url,
      method: details.method,
      status: details.statusCode,
      type: details.type,
      timestamp: details.timeStamp
    });

    if (log.length > MAX_NETWORK_LOG) {
      log.splice(0, log.length - MAX_NETWORK_LOG);
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  networkLogs.delete(tabId);
  activeStreams.delete(tabId);
  tabSessions.delete(tabId);

  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
  }
});

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId || null;
  xlog('DEBUG', 'MSG_ROUTER', 'Received:', message.type, 'from tab:', tabId || 'extension');

  switch (message.type) {
    case 'CANCEL_STREAM':
      handleCancelStream(tabId);
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
      handleGetNetworkLog(tabId, sendResponse);
      return true;

    case 'GET_PAGE_SOURCES':
      handleGetPageSources(tabId, sendResponse);
      return true;

    case 'GET_PAGE_ENABLED':
      handleGetPageEnabled(message, sendResponse);
      return true;

    case 'SET_PAGE_ENABLED':
      handleSetPageEnabled(message, sendResponse);
      return true;

    case 'OPEN_OPTIONS_PAGE':
      chrome.runtime.openOptionsPage();
      sendResponse({ status: 'ok' });
      return true;

    case 'GET_SETTINGS':
      chrome.storage.sync.get(['model', 'maxTokens', 'autoAttachCdp', 'theme'], (result) => {
        sendResponse({
          model: result.model || MODEL,
          maxTokens: result.maxTokens || MAX_TOKENS,
          autoAttachCdp: result.autoAttachCdp || false,
          theme: result.theme || 'dark',
        });
      });
      return true;

    case 'SET_SETTINGS': {
      const settings = {};
      if (message.model !== undefined) settings.model = message.model;
      if (message.maxTokens !== undefined) settings.maxTokens = message.maxTokens;
      if (message.autoAttachCdp !== undefined) settings.autoAttachCdp = message.autoAttachCdp;
      if (message.theme !== undefined) settings.theme = message.theme;
      chrome.storage.sync.set(settings, () => {
        sendResponse({ status: 'saved' });
      });
      return true;
    }

    case 'GET_DISABLED_URLS':
      chrome.storage.local.get(['disabledUrls'], (result) => {
        sendResponse({ disabledUrls: result.disabledUrls || [] });
      });
      return true;

    case 'SET_DISABLED_URLS':
      chrome.storage.local.set({ disabledUrls: message.disabledUrls || [] }, () => {
        sendResponse({ status: 'saved' });
      });
      return true;

    case 'GET_EXTENSION_LOGS':
      sendResponse({ logs: getRecentLogs(message.count || 50) });
      return true;

    case 'CLEAR_SESSION': {
      const sid = tabSessions.get(tabId);
      if (sid) {
        xlog('INFO', 'SESSION', 'Clearing session for tab:', tabId, 'session:', sid.sessionId);
        tabSessions.delete(tabId);
      }
      sendResponse({ status: 'ok' });
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

function handleCancelStream(tabId) {
  const stream = activeStreams.get(tabId);
  if (!stream) return;

  if (stream.abort) {
    stream.abort(); // AbortController
  }
  activeStreams.delete(tabId);
}

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

function handleGetNetworkLog(tabId, sendResponse) {
  if (!tabId) { sendResponse({ status: 'error', error: 'No tab ID' }); return; }
  sendResponse({ status: 'ok', entries: networkLogs.get(tabId) || [] });
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

// ─── Per-Page Toggle ──────────────────────────────────────────────────────────

async function handleGetPageEnabled(message, sendResponse) {
  if (!message.url) { sendResponse({ status: 'ok', enabled: true }); return; }
  try {
    const hostname = new URL(message.url).hostname;
    const result = await chrome.storage.local.get(['disabledUrls']);
    sendResponse({ status: 'ok', enabled: !(result.disabledUrls || []).includes(hostname) });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

async function handleSetPageEnabled(message, sendResponse) {
  if (!message.url) { sendResponse({ status: 'error', error: 'No URL' }); return; }
  try {
    const hostname = new URL(message.url).hostname;
    const result = await chrome.storage.local.get(['disabledUrls']);
    let disabledUrls = result.disabledUrls || [];
    if (message.enabled) {
      disabledUrls = disabledUrls.filter(h => h !== hostname);
    } else if (!disabledUrls.includes(hostname)) {
      disabledUrls.push(hostname);
    }
    await chrome.storage.local.set({ disabledUrls });
    sendResponse({ status: 'ok', enabled: message.enabled });
  } catch (error) {
    sendResponse({ status: 'error', error: error.message });
  }
}

// ─── Extension Commands (from AI ```ext blocks) ────────────────────────────────

function handleExtCommand(message, sendResponse) {
  const action = message.action;
  xlog('DEBUG', 'EXT_CMD', 'action:', action);

  // Normalize action name — AI hallucinates variants
  const normalized = action.toLowerCase().replace(/[_\-\s]/g, '');

  // List tabs
  if (['listtabs', 'gettabs', 'tabs', 'getalltabs', 'tablist'].includes(normalized)) {
    chrome.tabs.query({}, (tabs) => {
      sendResponse({
        tabs: tabs.map(t => ({
          tabId: t.id,
          url: t.url || '',
          title: t.title || '',
          active: t.active,
          windowId: t.windowId,
        }))
      });
    });
    return;
  }

  // Switch/activate tab
  if (['switchtab', 'activatetab', 'focustab', 'activate', 'focus', 'selecttab'].includes(normalized)) {
    const tid = message.tabId || message.id;
    if (!tid) { sendResponse({ error: 'No tabId provided' }); return; }
    chrome.tabs.update(tid, { active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        chrome.windows.update(tab.windowId, { focused: true }, () => {
          sendResponse({ tabId: tab.id, url: tab.url, title: tab.title });
        });
      }
    });
    return;
  }

  // Create tab
  if (['createtab', 'newtab', 'opentab', 'open'].includes(normalized)) {
    chrome.tabs.create({ url: message.url || 'about:blank', active: message.active !== false }, (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ tabId: tab.id, url: tab.url, title: tab.title });
      }
    });
    return;
  }

  // Close tab
  if (['closetab', 'removetab', 'close'].includes(normalized)) {
    const tid = message.tabId || message.id;
    if (!tid) { sendResponse({ error: 'No tabId provided' }); return; }
    chrome.tabs.remove(tid, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true });
      }
    });
    return;
  }

  // Screenshot — AI sometimes puts this in ext block instead of cdp
  if (['screenshot', 'takescreenshot', 'capturescreenshot', 'pagecapturescreenshot'].includes(normalized)) {
    const tid = message.tabId || message.id;
    if (!tid) { sendResponse({ error: 'No tabId provided for screenshot' }); return; }
    (async () => {
      try {
        if (!attachedTabs.has(tid)) {
          await chrome.debugger.attach({ tabId: tid }, '1.3');
          attachedTabs.add(tid);
        }
        const result = await chrome.debugger.sendCommand({ tabId: tid }, 'Page.captureScreenshot', message.params || { format: 'jpeg', quality: 60 });
        sendResponse({ data: result.data, note: 'Screenshot captured. Prefer DOM reading for text content.' });
      } catch (e) {
        sendResponse({ error: e.message || 'Screenshot failed' });
      }
    })();
    return;
  }

  // Help — return valid actions so AI can self-correct with format examples
  sendResponse({
    error: 'Unknown ext action: "' + action + '". ext blocks are ONLY for tab management.',
    validExtActions: ['listTabs', 'switchTab {tabId}', 'createTab {url}', 'closeTab {tabId}', 'screenshot {tabId}'],
    hint: 'To run JavaScript, use a ```js block. To use CDP commands (click, type, evaluate, navigate), use a ```cdp block with format: {"method": "Runtime.evaluate", "params": {"expression": "..."}}. To click: {"method": "Input.dispatchMouseEvent", "params": {"type": "mousePressed", "x": 100, "y": 200, "button": "left", "clickCount": 1}}'
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sendToTab(tabId, message) {
  message.tabId = tabId;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
  chrome.runtime.sendMessage(message).catch(() => {});

  if (message.type === 'STREAM_END' && message.fullText && !message.cancelled) {
    pushChatLog({ role: 'assistant', tabId, content: message.fullText });
  }
}
