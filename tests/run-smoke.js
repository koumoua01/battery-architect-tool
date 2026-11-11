/* Run the smoke page (out/app-smoke.html) in headless Chrome and print its
 * PASS/FAIL lines.
 *
 *   node tests/smoke-app.js && node tests/run-smoke.js
 *
 * The page needs timers, a canvas and pointer events, so it is loaded in a
 * real browser; the dump-dom route loses the <pre> that the harness writes.
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const PAGE = 'file:///' + path.join(ROOT, 'out', 'app-smoke.html').replace(/\\/g, '/');

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
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-breakpad', '--no-first-run',
    '--hide-scrollbars', '--user-data-dir=' + profile, '--window-size=1500,950',
    '--remote-debugging-port=' + PORT, 'about:blank'
  ], { stdio: 'ignore' });

  let failures = 0;
  try {
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) {
      try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch (e) { await sleep(100); }
    }
    if (!ver) throw new Error('Chrome did not start (is it at ' + CHROME + '?)');

    const tab = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + PAGE, { method: 'PUT' })).json();
    const c = await CDP.connect(tab.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Page.enable');

    /* wait for the harness to write its <pre> */
    let res = null;
    for (let i = 0; i < 200; i++) {
      await sleep(100);
      res = await c.ev('(function(){var p=document.getElementById("smoke");return p?{t:document.title,x:p.textContent}:null;})()');
      if (res && res.x && /\\n/.test(res.x)) break;
    }
    if (!res || !res.x) {
      console.log('  FAIL  the smoke page did not finish');
      const err = await c.ev('window.__smokeErr || ""');
      if (err) console.log(err);
      failures++;
    } else {
      res.x.split('\n').forEach((line) => {
        if (!line.trim()) return;
        if (line.indexOf('FAIL') === 0) failures++;
        console.log('  ' + line);
      });
      console.log('  --- ' + res.t);
    }
    c.ws.close();
  } catch (e) {
    console.log('  FAIL  ' + e.message);
    failures++;
  } finally {
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
  console.log(failures ? 'SMOKE FAIL (' + failures + ')' : 'SMOKE PASS');
  process.exit(failures ? 1 : 0);
})();
