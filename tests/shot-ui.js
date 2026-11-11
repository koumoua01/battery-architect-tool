/* Screenshot the app shell in its several states.
 *   node tests/shot-ui.js
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9342;
const APP = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.waiters.has(msg.id)) {
        const w = c.waiters.get(msg.id);
        c.waiters.delete(msg.id);
        msg.error ? w.rej(new Error(msg.error.message)) : w.res(msg.result);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-ui-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-breakpad', '--no-first-run',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--user-data-dir=' + profile,
    '--window-size=1500,950', '--remote-debugging-port=' + PORT, 'about:blank'
  ], { stdio: 'ignore' });
  try {
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) {
      try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch (e) { await sleep(100); }
    }
    if (!ver) throw new Error('Chrome did not start');
    const tab = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + APP, { method: 'PUT' })).json();
    const c = await CDP.connect(tab.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await sleep(2200);

    const err = await c.ev('window.__uiErr || null');
    if (err) console.log('PAGE ERROR: ' + err);

    await c.shot(path.join(ROOT, 'out', 'ui-midnight.png'));

    /* the inspector over a cell */
    await c.ev(`(function(){
      var B=window.__ba,s=B.state,cv=document.getElementById('cv');
      var c=s.doc.cells[Math.floor(s.doc.cells.length*0.32)];
      var f=s.frame,p=B.geo.cellOnFace(s.doc,f,s.face,c);
      var r=cv.getBoundingClientRect();
      cv.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,pointerType:'mouse',isPrimary:true,
        clientX:r.left+s.px+p.x*s.zoom, clientY:r.top+s.py+p.y*s.zoom}));
    })()`);
    await sleep(220);
    await c.shot(path.join(ROOT, 'out', 'ui-hover.png'));
    await c.ev("document.getElementById('cv').dispatchEvent(new PointerEvent('pointerleave',{bubbles:true,pointerId:1,pointerType:'mouse'}))");

    await c.ev("document.getElementById('btnTheme').click()");
    await sleep(2700);                 /* let the theme toast clear first */
    await c.shot(path.join(ROOT, 'out', 'ui-day.png'));
    await c.ev("document.getElementById('btnTheme').click()");
    await sleep(350);

    await c.ev("document.getElementById('btnCmd').click()");
    await sleep(380);
    await c.shot(path.join(ROOT, 'out', 'ui-command.png'));
    await c.ev("document.getElementById('cmdClose').click()");
    await sleep(260);

    await c.ev("document.getElementById('btnHelp').click()");
    await sleep(380);
    await c.shot(path.join(ROOT, 'out', 'ui-help.png'));
    await c.ev("document.getElementById('helpClose').click()");
    await sleep(260);

    for (let i = 0; i < 4; i++) { await c.ev("document.getElementById('btnZoomIn').click()"); await sleep(120); }
    await sleep(500);
    await c.shot(path.join(ROOT, 'out', 'ui-zoomed.png'));

    await c.ev("document.getElementById('btnLeft').click(); document.getElementById('btnRight').click()");
    await sleep(750);
    await c.shot(path.join(ROOT, 'out', 'ui-focus.png'));

    const info = await c.ev("(function(){var s=window.__ba.state;return {zoom:s.zoom,theme:s.theme,mini:s.mini,errors:(window.__uiErr||null)};})()");
    const rep = await c.ev('window.__ba.report()');
    if (typeof rep === 'string') fs.writeFileSync(path.join(ROOT, 'out', 'report-sample.md'), rep);
    console.log(JSON.stringify(info));
    c.ws.close();
  } catch (e) {
    console.log('FAIL ' + e.message);
    process.exitCode = 1;
  } finally {
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
  console.log('wrote out/ui-*.png');
})();
