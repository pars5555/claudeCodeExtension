# WebAI -- Chrome Extension

Chrome MV3 extension that puts Claude AI in your browser's side panel. Claude can see page content, execute JavaScript, control the browser via Chrome DevTools Protocol (CDP), and automate multi-step tasks.

Connects to the [webai-server](../webai-server/) backend (webai.pc.am) for authentication, billing, system prompt, and Claude Code CLI proxying.

## Architecture

```
+-----------------------------------------------------------------+
|  Chrome Extension                                               |
|                                                                 |
|  +----------------+  +----------------+  +--------------------+ |
|  | sidepanel.js   |  | background.js  |  | content.js         | |
|  | Chat UI        |  | Service Worker |  | Page data          | |
|  | Auth/login     |  | CDP control    |  | DOM inspector      | |
|  | SSE stream     |  | Tab mgmt       |  | Cookie/storage     | |
|  | Auto-exec loop |  | Network log    |  | Performance        | |
|  | Markdown       |  | OAuth flow     |  | Canvas capture     | |
|  | File upload    |  |                |  |                    | |
|  +-------+--------+  +-------+--------+  +--------+-----------+ |
|          |                    |                     |            |
|          | chrome.runtime     | chrome.debugger     | DOM access |
+----------+--------------------+---------------------+-----------+
           |                    |                     |
           | fetch SSE          | CDP commands         | page context
           v                    v                     v
+-----------------------+   +--------------------------------+
| API Server            |   | Browser Tab (target page)      |
| webai.pc.am           |   | JS eval, DOM read/write        |
| POST /api/chat        |   | Screenshots, navigation        |
| JWT auth + billing    |   | Click, type, scroll            |
| Spawns Claude Code CLI|   | Network, cookies, storage      |
+-----------------------+   +--------------------------------+
```

The side panel UI communicates with the remote server via HTTP POST with Server-Sent Events (SSE) streaming. The server spawns the `claude` CLI process per message and streams its JSON output back over SSE. All browser automation (CDP, JS eval, tab management) is handled locally by the extension.

## Full Chat Flow

### First message (new session)

1. User types a message in the side panel.
2. `sidepanel.js` collects **rich page context** via CDP (`Runtime.evaluate`):
   - Page headings (h1/h2/h3), form count, visible input elements (tag, type, id, name, placeholder, coordinates)
   - Link count, image count, selected text
   - Body text (first 4000 chars)
   - Cookies (via `Network.getCookies`, first 10)
3. Sends `POST /api/chat` (SSE) with:
   - `message`: the user's text
   - `tabId`: target browser tab
   - `sessionId`: new UUID
   - `pageContext`: the rich context object from step 2
   - `Authorization: Bearer <JWT>`
4. Server receives the request, loads the system prompt from DB (versioned, admin-configured), appends the `pageContext` to it, and spawns `claude` CLI with `--session-id <uuid>`.
5. The system prompt + user message are sent to the CLI via stdin as `<context>...</context>` (not the `--system-prompt` flag).
6. CLI streams JSON output back; server relays it as SSE `delta` events.
7. `sidepanel.js` renders the response with markdown + syntax highlighting.

### Follow-up messages (resume session)

1. User types another message, or the auto-execution loop sends a follow-up.
2. **No page context is collected** -- the CLI manages its own session history.
3. Sends `POST /api/chat` with just the bare `message`, `tabId`, and `sessionId` (no `pageContext`).
4. Server spawns `claude` CLI with `--resume <sessionId>` instead of `--session-id`.
5. Only the user message is piped to stdin (no system prompt).
6. Streaming and rendering proceed as above.

### Auto-execution loop

When the AI response contains fenced code blocks (`cdp`, `js`, `javascript`, or `ext`), the extension automatically:

1. Parses **all blocks in document order** (not grouped by type).
2. Executes each block through the appropriate handler (see Block Types below).
3. Collects results and formats them into a follow-up prompt:
   ```
   Here are the execution results from the commands you provided:

   CDP <method> returned:
   <result>

   JS execution returned:
   <result>

   Based on these results, continue with the task. If the task is complete,
   summarize what was done. If more steps are needed, provide the next
   CDP/JS commands to execute.
   ```
4. Sends the follow-up as a new message to the server (which uses `--resume`).
5. The loop continues until:
   - The AI responds with no code blocks (task complete), or
   - The limit of **40 steps** (`MAX_AUTO_FOLLOW_UPS`) is reached, or
   - The user clicks the stop button.

### Step profiling

Each auto-execution step shows timing in the chat UI:

```
Step 3 executed -- 2 command(s) -- AI: 2.4s | Exec: 0.3s | Total: 2.7s
```

- **AI time**: wall-clock time from sending the SSE request to receiving the complete response.
- **Exec time**: wall-clock time to execute all code blocks in that step.

## Block Types

### `js` / `javascript` -- JavaScript execution

Runs via `Runtime.evaluate` on the target tab.

- `const` and `let` are replaced with `var` before execution (avoids redeclaration errors in the page's global scope).
- **No IIFE wrapping** -- the expression is evaluated directly so the last expression value is returned without needing an explicit `return`.
- `returnByValue: true` and `awaitPromise: true` are set.

### `cdp` -- Chrome DevTools Protocol

Parsed as JSON: `{"method": "Input.dispatchMouseEvent", "params": {"type": "mousePressed", ...}}`

Executed via `background.js` -> `chrome.debugger.sendCommand()` on the target tab.

If the content of a `cdp` block is not valid JSON but looks like JavaScript (starts with `await`, `document.`, `window.`, `var`, `let`, `const`, `function`, `(`, or `Array.`), it falls back to `Runtime.evaluate` with the same `var` replacement.

### `ext` -- Extension tab management

Parsed as JSON: `{"action": "listTabs"}`, `{"action": "switchTab", "tabId": 123}`, `{"action": "createTab", "url": "..."}`, `{"action": "closeTab", "tabId": 123}`

Executed via `chrome.tabs` API. When `switchTab` is used, CDP targets the tab by ID without changing the user's focused tab -- background tasks keep running invisibly.

When `createTab` or `switchTab` completes, the extension auto-fetches a DOM snapshot (title, URL, body text) of the target tab so the AI gets immediate context.

## Features

- **Side panel chat** with streaming responses and markdown rendering
- **Per-tab conversations** -- each browser tab has isolated chat history and CLI session
- **Model selector** -- choose between Opus 4.6, Sonnet 4.6, or Haiku 4.5 (persisted per user)
- **Browser automation** -- Claude clicks, types, scrolls, navigates using CDP
- **Tab management** -- list, switch, create, close tabs across the browser
- **Background tasks** -- tasks keep running when user switches tabs
- **Rich page context** -- headings, inputs, cookies, body text collected via CDP on first message
- **DOM-first reading** -- AI reads pages via DOM methods, screenshots only as last resort
- **File attachments** -- images, PDFs, text files, code files (drag & drop or paste)
- **Auto-execution** -- Claude runs CDP/JS/ext commands in a loop (up to 40 steps)
- **Step profiling** -- AI time + execution time shown per step in the chat UI
- **Multi-user auth** -- email/password, Google/GitHub OAuth
- **Usage tracking** -- per-request token counting and cost calculation
- **Context management** -- auto-compaction when approaching 200K token limit
- **Syntax highlighting** -- code blocks with language-specific coloring
- **Execution results in chat** -- CDP/JS/ext results shown as system messages

## Setup

### 1. Install the extension

1. Open Chrome -> `chrome://extensions/`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select this directory (`webai-ext/`)

### 2. API Server

The extension connects to `https://webai.pc.am` by default. For local development:

```bash
cd ../webai-server
cp .env.example .env
# Edit .env: set MySQL credentials, JWT_SECRET, ENCRYPTION_KEY, ANTHROPIC_API_KEY
npm install
npm run dev
```

Then change server URL in extension Options to `http://localhost:3466`.

### 3. Use the extension

1. Click the extension icon -> side panel opens
2. Sign in (email/password or Google/GitHub OAuth)
3. Select model from header dropdown (Opus 4.6 default)
4. Start chatting -- Claude sees the current page and can interact with it

---

## Authentication Flow

### Email/Password
- Sign up: email + password (min 6 chars) + optional display name
- Sign in: email + password
- JWT access token (15 min) in `chrome.storage.local`
- Refresh token (30 days) for seamless re-auth

### OAuth (Google / GitHub)
- "Continue with Google/GitHub" button
- Uses `chrome.identity.launchWebAuthFlow`
- Server handles OAuth redirect flow, returns tokens

### Token Management
- `Authorization: Bearer <token>` on every API call
- 401 -> automatic refresh -> retry original request
- 402 -> "insufficient balance" message
- 403 -> access denied -> show sign-in overlay

---

## File Structure

```
webai-ext/
+-- manifest.json               # MV3 config, permissions, side panel
+-- background/
|   +-- background.js           # Service worker: CDP, message router, OAuth
+-- sidepanel/
|   +-- sidepanel.html          # Chat UI + auth overlay
|   +-- sidepanel.js            # Chat logic, auth, SSE, auto-exec loop, markdown
|   +-- sidepanel.css           # Dark theme, chat bubbles, auth overlay
+-- content/
|   +-- content.js              # Page context, DOM commands, command execution
|   +-- utils/
|       +-- dom-inspector.js    # DOM structure, headings, meta, selected text
|       +-- page-data-collector.js  # Performance, security, cookies, network
+-- popup/
|   +-- popup.html              # Extension popup (status, open chat)
|   +-- popup.js                # Popup logic (auth status, server check)
+-- options/
|   +-- options.html            # Settings page (server URL)
|   +-- options.js              # Settings logic
|   +-- options.css             # Settings styles
+-- icons/                      # Extension icons (16, 48, 128px)
```

---

## Chat Commands

| Command | Description |
|---------|-------------|
| `/dom` | Full page context (DOM, cookies, performance) |
| `/styles <selector>` | Computed CSS for an element |
| `/errors` | Console errors |
| `/select` | Currently selected text |
| `/structure` | DOM tree overview |
| `/highlight <selector>` | Highlight an element visually |
| `/query <expr>` | Execute JavaScript expression |
| `/cookies` | Page cookies (document + Chrome API) |
| `/storage` | localStorage + sessionStorage |
| `/performance` | Performance metrics |
| `/sources` | Page HTML and scripts |
| `/network` | Recent network requests |
| `/cdp <method> [params]` | Manual CDP command |
| `/logs` | Extension debug logs |
| `/clear` | Clear chat history |

---

## Permissions

| Permission | Why |
|------------|-----|
| `activeTab` | Access current tab URL/title |
| `scripting` | Inject content scripts |
| `storage` | Auth tokens, settings |
| `tabs` | Tab management, per-tab chat |
| `debugger` | CDP access (auto-attach) |
| `cookies` | Read page cookies |
| `webRequest` | Network request logging |
| `webNavigation` | Page load tracking |
| `alarms` | Service worker keep-alive |
| `sidePanel` | Side panel API |
| `identity` | OAuth web auth flow |
| `<all_urls>` | Content scripts on any page |

---

## Context Management

- 200K token context window per model
- Token usage displayed in context meter bar
- "Compact" button summarizes conversation history
- Auto-compaction: keeps first + last 2 messages, summarizes middle
- Token estimation: `characters / 4`

---

## Development

### Reload after changes
1. Edit files
2. `chrome://extensions/` -> click reload on the extension
3. Reopen side panel

### Debug
- **Side panel**: Right-click side panel -> Inspect
- **Background**: Click "Service Worker" on `chrome://extensions/`
- **Content script**: Normal DevTools (F12)

### Logs
Extension pushes logs to server at `POST /api/logs/system`. View in admin panel -> System Logs.

---

## API Communication

| Feature | Endpoint | Method |
|---------|----------|--------|
| Auth | `/api/auth/*` | POST |
| Chat (streaming) | `/api/chat` | POST (SSE) |
| User settings | `/api/user/settings` | GET/PUT |
| Model override | `/api/user/settings/model` | PUT |
| System prompt | `/api/user/prompt` | GET |
| Sessions | `/api/sessions` | POST/GET |
| Logs | `/api/logs/*` | POST |

Extension handles locally (background.js):
- CDP command execution via `chrome.debugger`
- Page context gathering (content.js)
- Tab management (list, switch, create, close)
- Network request logging
- OAuth web auth flow

---

## Related

- [webai-server](../webai-server/) -- Backend API server (authentication, billing, admin panel, Claude Code CLI proxy)
