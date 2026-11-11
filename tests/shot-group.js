/* Screenshot the palette with the + and - chips and the Remove group button,
 * once with nothing selected and once with a group selected.
 *
 *   node tests/shot-group.js
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9340;
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async shot(file, clip) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', clip: Object.assign({ scale: 2 }, clip) });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

const BOX = `(function(){
  var s=document.getElementById('palette').closest('section').getBoundingClientRect();
  return {x:s.x-4,y:s.y-6,width:s.width+8,height:s.height+10};
})()`;

(async () => {  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-breakpad', '--no-first-run',
    '--hide-scrollbars', '--user-data-dir=' + profile, '--window-size=1512,900',
    '--remote-debugging-port=' + PORT, 'about:blank'
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
    await sleep(2000);

    /* the palette lives far down the scrolling left panel: bring it on screen
       before clipping, or the clip lands off-page and comes back blank */
    await c.ev(`document.getElementById('palette').scrollIntoView({block:'center'})`);
    await sleep(400);

    /* selected (the default: the first group) */
    await c.shot(path.join(ROOT, 'out', 'group-selected.png'), await c.ev(BOX));

    /* nothing selected: the - chip and Remove group grey out */
    await c.ev(`(function(){ var B=window.__ba; B.state.sel=null; B.rebuild(); })()`);
    await sleep(300);
    await c.shot(path.join(ROOT, 'out', 'group-none.png'), await c.ev(BOX));

    await sleep(200);
    c.ws.close();
  } catch (e) {
    console.log('FAIL ' + e.message);
    process.exitCode = 1;
  } finally {
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
  console.log('wrote out/group-selected.png, out/group-none.png');
})();
