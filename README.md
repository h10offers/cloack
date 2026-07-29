# Co-browse prototype

A minimal, runnable demo of the two capabilities we discussed:

1. **Live visitor monitoring** — see who is on Domain A and what page they're on, in real time.
2. **Consented co-browse** — cast the page from *your* server browser to a visitor; they see a live
   stream and can type/click into it, and the input runs in **your** session. No cookies leave your server.

One Node process simulates both "domains" so you can test on a single machine.

## Run it

```bash
npm install      # installs express, socket.io, playwright (+ Chromium)
npm start
```

Then open two browser windows:

- **Domain A (a visitor):** http://localhost:3000  → click around to `/cats`, `/dogs`, `/help`
- **Domain B (you, the operator):** http://localhost:3000/operator

### Try the flow

1. On the operator page you'll see the visitor appear in the left list with their current URL, updating live.
2. The right half is **your server browser**. Type a URL in the bar (e.g. `wikipedia.org`) and press Enter — it
   navigates. Click and type on the stream to drive it.
3. Click **"Cast my page to them"** next to the visitor.
4. Back on the visitor window, a consent prompt appears. Accept it — their page is replaced by a live stream of
   your server browser. Anything they type/click there runs in your session and streams back to everyone.
5. Click **"Stop co-browse"** to return the visitor to normal.

## How it maps to a real build

- **Transport:** Socket.IO (WebSocket) for presence, control, and frames. `server.js`.
- **The "server browser" (your session):** one headless Chromium via Playwright. In production you'd pool one
  per active session instead of a single global one.
- **Streaming:** Chrome DevTools Protocol `Page.startScreencast` → JPEG frames pushed only on visual change
  (efficient, real-time). Swap to WebRTC or rrweb DOM-streaming later for smoother/native feel.
- **Input relay:** visitor/operator clicks are normalized (0..1) and replayed with `page.mouse` / `page.keyboard`.
- **Consent:** `beacon.js` shows a prompt before any co-browse starts — the line between a legit tool and abuse.
- **The beacon:** `public/beacon.js` is the snippet you'd drop on every Domain A page.

## Files

- `server.js` — backend: presence, the server browser, screencast, input relay
- `public/beacon.js` — injected on Domain A: reports presence, renders the cast, relays input
- `public/operator.html` — Domain B dashboard (split screen)
- `public/site-a.css` — styling for the visitor site
- `smoke.mjs`, `smoke2.mjs` — automated tests used during development (optional)

## Known simplifications (it's a prototype)

- One global server browser shared by all — fine for a demo, pool per-session for real use.
- Typing has a network round-trip; add an optimistic local overlay for production polish.
- No auth on the operator dashboard — add that before exposing it anywhere.
- Consent is a `confirm()` — replace with a proper opt-in UI.
