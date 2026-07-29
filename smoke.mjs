import { chromium } from 'playwright';
import { spawn } from 'child_process';

const srv = spawn('node', ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '3111' } });
srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));
await new Promise(r => setTimeout(r, 2500));

const b = await chromium.launch({ args: ['--no-sandbox'] });
const log = [];

// visitor on /cats
const vis = await b.newPage();
await vis.goto('http://localhost:3111/cats');
let visFrames = 0;
await vis.exposeFunction('gotFrame', () => { visFrames++; });
await vis.evaluate(() => { /* hook after socket ready */ });

// operator
const op = await b.newPage();
await op.goto('http://localhost:3111/operator');
let opFrames = 0;
await op.exposeFunction('gotFrameOp', () => { opFrames++; });
await op.evaluate(() => new Promise(res => {
  const iv = setInterval(() => { if (window.io) { clearInterval(iv); res(); } }, 100);
}));

// wait for operator to see visitor, then click Cast
await op.waitForTimeout(1500);
const hasVisitor = await op.locator('.visitor').count();
log.push('operator sees visitors: ' + hasVisitor);

// count frames arriving on operator by patching the socket frame handler
await op.evaluate(() => {
  socket.on('frame', () => window.gotFrameOp());
});
await op.locator('.visitor button:has-text("Cast to Visitor")').click(); // cast

// on visitor, watch the stage canvas appear + count frames by patching drawImage
await vis.waitForTimeout(500);
await vis.evaluate(() => {
  const stage = document.getElementById('cobrowse-stage');
  const hook = (canvas) => {
    if (canvas && !canvas.__hooked) {
      canvas.__hooked = true;
      const ctx = canvas.getContext('2d');
      const orig = ctx.drawImage;
      ctx.drawImage = function() {
        window.gotFrame();
        return orig.apply(this, arguments);
      };
    }
  };
  hook(stage.querySelector('canvas'));
  const mo = new MutationObserver(() => {
    hook(stage.querySelector('canvas'));
  });
  mo.observe(stage, { childList: true, subtree: true });
});

// operator types a URL to drive the server browser
await op.locator('#url').fill('example.org');
await op.locator('#url').press('Enter');
await op.waitForTimeout(3000);

opFrames = await op.evaluate(() => 0); // reset not needed; use counters via functions
const results = await Promise.all([
  op.evaluate(() => window.__c || 0),
]);

await vis.waitForTimeout(1500);
const stageVisible = await vis.locator('#cobrowse-stage').isVisible();
log.push('visitor co-browse stage visible: ' + stageVisible);
log.push('visitor frames received: ' + visFrames);
log.push('operator frames received: ' + opFrames);

console.log('\n=== SMOKE RESULTS ===');
log.forEach(l => console.log(' - ' + l));
console.log('=====================\n');

await b.close();
srv.kill();
process.exit(0);
