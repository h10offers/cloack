import { chromium } from 'playwright';
import { spawn } from 'child_process';

const srv = spawn('node', ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '3112' } });
srv.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));
await new Promise(r => setTimeout(r, 2500));

const b = await chromium.launch({ args: ['--no-sandbox'] });
const page = await b.newPage();
await page.goto('http://localhost:3112/operator');

// open visitor and operator sockets in-page and count frames
const res = await page.evaluate(async () => {
  return await new Promise(resolve => {
    const v = io();
    v.emit('visitor:hello', { sessionId: 'smoke-sess', url: '/cats' });

    const s = io();
    let frames = 0, firstBytes = 0;
    s.on('connect', () => s.emit('operator:hello'));
    s.on('frame', ({ sessionId, b64 }) => {
      if (sessionId === 'smoke-sess') {
        frames++;
        if (!firstBytes) firstBytes = b64.length;
      }
    });

    // operator casts and then drives the session
    setTimeout(() => s.emit('operator:cast', { sessionId: 'smoke-sess' }), 500);
    setTimeout(() => s.emit('operator:input', { sessionId: 'smoke-sess', ev: { type: 'goto', url: 'example.com' } }), 2000);
    setTimeout(() => {
      v.disconnect();
      s.disconnect();
      resolve({ frames, firstBytes });
    }, 7000);
  });
});

console.log('\n=== STREAM TEST ===');
console.log(' operator frames received:', res.frames);
console.log(' first frame jpeg bytes  :', res.firstBytes);
console.log('===================\n');

await b.close();
srv.kill();
process.exit(0);
