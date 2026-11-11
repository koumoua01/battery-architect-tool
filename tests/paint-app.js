/* Keep the paint stroke visible while the button is still down.
 *
 *   node tests/paint-app.js
 *
 * The defect this guards is a one-line regression: invalidating the face on
 * every painted cell made the sheet disappear until the release. The check
 * runs a real mouse drag through Chrome, reads the canvas pixel under a newly
 * painted pad before and during the drag, and looks at the live state.
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9366;
const APP = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  (' + detail + ')' : ''));
}

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
  mouse(type, x, y, button, buttons) {
    return this.send('Input.dispatchMouseEvent', {
      type, x, y, button: button || 'left',
      buttons: type === 'mouseReleased' ? 0 : (buttons === undefined ? 1 : buttons),
      clickCount: 1, pointerType: 'mouse'
    });
  }
}

const COORDS = '(function(){ var B=window.__ba,s=B.state,cv=document.getElementById("cv"),r=cv.getBoundingClientRect(); var ids=s.doc.islands.top[1].cells.slice(0,6); return ids.map(function(id){ var c=s.doc.cells.find(function(q){return q.id===id;}); var p=B.geo.cellOnFace(s.doc,s.frame,s.face,c); return {id:id,x:r.left+s.px+p.x*s.zoom,y:r.top+s.py+p.y*s.zoom}; }); })()';

const PIXEL = '(function(id){ var B=window.__ba,s=B.state,cv=document.getElementById("cv"),ctx=cv.getContext("2d"); var dpr=window.devicePixelRatio||1; var c=s.doc.cells.find(function(q){return q.id===id;}); var p=B.geo.cellOnFace(s.doc,s.frame,s.face,c); var r=s.doc.params.cellD/2; var x=s.px+p.x*s.zoom+r*0.66*s.zoom,y=s.py+p.y*s.zoom; var d=ctx.getImageData(Math.round(x*dpr),Math.round(y*dpr),1,1).data; return [d[0],d[1],d[2],d[3]]; })';

const STATE = '(function(){ var s=window.__ba.state; return {dragging:s.dragging,wet:!!s.wet,trail:s.wet?s.wet.trail.length:-1,sheet:!!s.sheets[s.face],t0:s.doc.islands.top[0].cells.slice(),t1:s.doc.islands.top[1].cells.slice(),top:s.sheets.top?Math.round(s.sheets.top.islands.reduce(function(a,i){return a+i.area;},0)):-1,bottom:s.sheets.bottom?Math.round(s.sheets.bottom.islands.reduce(function(a,i){return a+i.area;},0)):-1}; })()';

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-'));
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
    if (!ver) throw new Error('Chrome did not start (is it at ' + CHROME + '?)');

    const tab = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json();
    const c = await CDP.connect(tab.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('Page.navigate', { url: APP });
    await sleep(1600);

    const pts = await c.ev(COORDS);
    const boot = await c.ev(STATE);
    ok(pts.length >= 4, 'there are cells in a neighboring island to drag across', pts.length + ' points');
    ok(boot.sheet && boot.trail === -1, 'the sheet is drawn and no stroke is active');

    const cell = pts[0].id;
    const before = await c.ev(PIXEL + '(' + JSON.stringify(cell) + ')');
    ok(before[3] > 0 && before[0] + before[1] + before[2] > 40, 'the starting pad has a readable colour',
      before.join(','));

    await c.mouse('mousePressed', pts[0].x, pts[0].y);
    await sleep(180);
    for (let i = 1; i < 6; i++) {
      await c.mouse('mouseMoved', pts[i].x, pts[i].y);
      await sleep(90);
    }
    await sleep(220);

    const live = await c.ev(STATE);
    const during = await c.ev(PIXEL + '(' + JSON.stringify(cell) + ')');
    const dist = Math.hypot(during[0] - before[0], during[1] - before[1], during[2] - before[2]);

    ok(live.dragging && live.wet, 'the pointer is still down and the stroke is live',
      'dragging=' + live.dragging + ' wet=' + live.wet);
    ok(live.sheet, 'the sheet is still on screen during the stroke, not blank');
    ok(live.trail >= 6, 'every visited cell is in the live trail', live.trail + ' cells');
    ok(dist > 24, 'the pad has already changed colour before the release', 'delta ' + dist.toFixed(1));
    ok(live.t0.indexOf(cell) >= 0 && live.t1.indexOf(cell) < 0,
      'the cell has already joined the selected island in the document',
      live.t0.length + ' / ' + live.t1.length);
    ok(live.t0.length === 21, 'all six dragged cells are in the island while the button is down',
      live.t0.length + ' cells');

    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'out', 'ui-paint.png'), Buffer.from(shot.data, 'base64'));
    ok(fs.existsSync(path.join(ROOT, 'out', 'ui-paint.png')), 'a screenshot of the live stroke is written');

    await c.mouse('mouseReleased', pts[5].x, pts[5].y);
    await sleep(400);
    const end = await c.ev(STATE);
    ok(!end.dragging && !end.wet, 'the stroke ends and the preview is put away');
    ok(end.sheet && end.top > 0 && end.bottom > 0, 'both faces are exact after the release',
      end.top + ' / ' + end.bottom + ' mm2');
    ok(end.t0.length === 21, 'the painted cells stay in the island after the release');

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await sleep(300);
    const undone = await c.ev(STATE);
    ok(undone.t0.length === 15 && undone.t1.length === 15, 'one Ctrl+Z puts the whole stroke back',
      undone.t0.length + ' / ' + undone.t1.length);

    /* right-drag erase: the donor island shrinks under the pointer too */
    const beforeErase = await c.ev(PIXEL + '(' + JSON.stringify(pts[0].id) + ')');
    await c.mouse('mousePressed', pts[0].x, pts[0].y, 'right', 2);
    await sleep(100);
    for (let i = 1; i < 3; i++) {
      await c.mouse('mouseMoved', pts[i].x, pts[i].y, 'right', 2);
      await sleep(90);
    }
    await sleep(200);
    const erasing = await c.ev(STATE);
    const erased = await c.ev(PIXEL + '(' + JSON.stringify(pts[0].id) + ')');
    const gone = Math.hypot(erased[0] - beforeErase[0], erased[1] - beforeErase[1], erased[2] - beforeErase[2]);
    ok(erasing.dragging && erasing.wet, 'a right drag is a live erase stroke too');
    ok(erasing.t1.length === 12, 'the erased cells leave the donor island while the button is down',
      erasing.t1.length + ' cells');
    ok(gone > 18, 'the erased pad has already lost its colour', 'delta ' + gone.toFixed(1));

    await c.ev("document.getElementById('toast').classList.remove('show')");
    await sleep(350);
    const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'out', 'ui-erase.png'), Buffer.from(shot2.data, 'base64'));

    await c.mouse('mouseReleased', pts[2].x, pts[2].y, 'right', 0);
    await sleep(400);
    const erasedEnd = await c.ev(STATE);
    ok(!erasedEnd.dragging && !erasedEnd.wet && erasedEnd.t1.length === 12,
      'the erase is committed once, on release');

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await sleep(300);
    const erasedUndo = await c.ev(STATE);
    ok(erasedUndo.t1.length === 15, 'one Ctrl+Z puts the erased cells back', erasedUndo.t1.length + ' cells');

    c.ws.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }

  console.log(failures ? 'PAINT FAIL' : 'PAINT PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('PAINT FAIL ' + e.message); process.exit(1); });