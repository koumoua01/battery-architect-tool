/* Drive the geometry sliders with real mouse input, through the Chrome
 * DevTools Protocol, and look at the sheet while the button is still down.
 *
 *   node tests/drag-app.js
 *
 * Why a second browser harness: the smoke suite dispatches events from page
 * script, and a synthetic event cannot move a native range thumb. The one
 * defect these sliders had was exactly of that kind - the number moved but
 * the drawing did not until the button came up - so it takes trusted input to
 * keep it fixed.
 *
 * Headless Chrome only carries one drag gesture per page: a second press and
 * move still delivers pointer events but no longer moves the thumb (a bare
 * <input type=range> on a blank page behaves the same way). The drag is
 * therefore the first gesture here, and everything else is a click.
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const APP = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  (' + detail + ')' : ''));
}

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
        msg.error ? w.rej(new Error(JSON.stringify(msg.error))) : w.res(msg.result);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => this.waiters.set(id, { res, rej }));
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.result && r.result.description));
    return r.result.value;
  }
  mouse(type, x, y) {
    return this.send('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse'
    });
  }
  key(key, code, vk, modifiers) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: modifiers || 0 };
    return this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base))
      .then(() => this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base)));
  }
}

const AREA = `(() => { const S = window.__ba.state;
  const sum = f => (S.sheets[f] ? Math.round(S.sheets[f].islands.reduce((a, i) => a + i.area, 0)) : -1);
  return { top: sum('top'), bottom: sum('bottom') }; })()`;
const VAL = `window.__ba.state.doc.params.padD`;
const SHOWN = `(function(){ const r = document.getElementById('padD').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, v: parseFloat(document.getElementById('padD').value) }; })()`;

/* the thumb is 14px wide plus a 2px border, so its travel stops that far short
   of each end of the track */
function thumbX(box) {
  const lo = 6, hi = 20.8, pad = 9, span = hi - lo;
  return Math.round(box.x + pad + (box.w - pad * 2) * ((box.v - lo) / span));
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'drag-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-breakpad', '--no-first-run',
    '--hide-scrollbars', '--user-data-dir=' + profile, '--window-size=1500,950',
    '--remote-debugging-port=' + PORT, 'about:blank'
  ], { stdio: 'ignore' });

  try {
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) {
      try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch (e) { await sleep(100); }
    }
    if (!ver) throw new Error('Chrome did not start (is it at ' + CHROME + '?)');

    const tab = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + APP, { method: 'PUT' })).json();
    const c = await CDP.connect(tab.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await sleep(1500);

    /* the row this test drives, not "the first .sl in the panel": the guide
       length row sits above Pad D and is hidden until the slits are on */
    await c.ev(`document.getElementById('padD').scrollIntoView({ block: 'center' })`);
    await sleep(250);

    const boot = await c.ev(AREA);
    ok(boot.top > 0 && boot.bottom > 0, 'the pack is on screen', JSON.stringify(boot));

    /* 1. one real drag, with the value read while the button is still down */
    const box = await c.ev(SHOWN);
    const y = Math.round(box.y + box.h / 2);
    const x0 = thumbX(box);
    await c.mouse('mousePressed', x0, y);
    let val = box.v, mid = null;
    for (let i = 1; i <= 4; i++) {
      await c.mouse('mouseMoved', x0 + i * 8, y);
      await sleep(110);
      val = await c.ev(VAL);
      mid = await c.ev(AREA);
      if (val > box.v && mid.bottom === -1) break;
    }
    ok(val > box.v, 'the thumb moves while the button is down', box.v + ' -> ' + val + ' mm');
    ok(mid.top !== boot.top, 'the sheet is rebuilt during the drag, not after it',
      boot.top + ' -> ' + mid.top + ' mm2');
    ok(mid.bottom === -1, 'only the face on screen is traced while the thumb is down');

    await c.mouse('mouseReleased', x0 + 40, y);
    await sleep(250);
    const end = await c.ev(AREA);
    ok(end.bottom > 0 && end.top === mid.top, 'releasing the thumb builds the mirrored face too',
      JSON.stringify(end));

    /* 2. one drag, one undo - with the thumb still focused, as it is after a drag */
    await c.key('z', 'KeyZ', 90, 2);
    await sleep(250);
    const undoVal = await c.ev(VAL), undoArea = await c.ev(AREA);
    ok(undoVal === box.v, 'one ctrl+z puts the drag back', val + ' -> ' + undoVal + ' mm');
    ok(undoArea.top === boot.top, 'and the metal with it', boot.top + ' mm2');

    /* 3. a click on the track still jumps to that spot */
    const b2 = await c.ev(SHOWN);
    const at = Math.round(b2.x + 9 + (b2.w - 18) * 0.35);
    await c.mouse('mousePressed', at, y);
    await c.mouse('mouseReleased', at, y);
    await sleep(200);
    const clickArea = await c.ev(AREA);
    ok(await c.ev(VAL) < undoVal, 'a click on the track jumps to that spot',
      undoVal + ' -> ' + await c.ev(VAL) + ' mm');
    ok(clickArea.bottom > 0, 'and rebuilds both faces', JSON.stringify(clickArea));

    /* 4. back to default, from the arrow and from the header */
    await c.ev(`document.querySelector('#geom .rst[data-for=padD]').click()`);
    await sleep(200);
    const head = await c.ev(`document.getElementById('btnGeomReset').textContent`);
    const label = await c.ev(`document.getElementById('padDv').textContent`);
    ok(await c.ev(VAL) === 18, 'the reset arrow puts one slider back to its default', await c.ev(VAL) + ' mm');
    ok(label === '18.0' && head === 'reset', 'the row and the header go quiet again', label + ' / ' + head);

    c.ws.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }

  console.log(failures ? 'DRAG FAIL' : 'DRAG PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('DRAG FAIL ' + e.message); process.exit(1); });
