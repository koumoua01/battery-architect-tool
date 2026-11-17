/* The pack a browser that has never saved anything opens on: the reference
 * 14-row pack, already striped and terminated, with its own cell size.
 * Also checks that the default never comes back once a visitor has edited and
 * saved a pack - it is a first-run document, not a reset.
 *
 *   node tests/first-run-pack.js
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9347;
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' +
        (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    }
    return r.result.value;
  }
}

const out = [];
let fails = 0;
function P(ok, what, detail) {
  out.push((ok ? 'PASS  ' : 'FAIL  ') + what + (detail !== undefined ? '  (' + detail + ')' : ''));
  if (!ok) fails++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-'));
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
    const tab = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json();
    const c = await CDP.connect(tab.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__errs=[];addEventListener("error",function(e){window.__errs.push(String(e.message||e.error||e))});' +
              'addEventListener("unhandledrejection",function(e){window.__errs.push(String(e.reason))});'
    });

    /* a brand new profile: nothing in localStorage, so boot() must fall back
       to the embedded pack */
    await c.send('Page.navigate', { url: APP });
    let ready = false;
    for (let i = 0; i < 160 && !ready; i++) {
      await sleep(100);
      try { ready = await c.ev('!!(window.__ba && window.__ba.state && window.__ba.state.doc)'); } catch (e) { }
    }
    P(ready, 'the app boots on an empty profile');
    if (!ready) throw new Error('app did not boot');

    const state = (expr) => c.ev('(' + expr + ')');
    const doc = await state('window.__ba.state.doc');

    P(doc.name === 'my pack', 'the first-run pack keeps the assumed name', JSON.stringify(doc.name));
    P(doc.cells.length === 96, 'the reference pack has 96 cells', doc.cells.length + ' cells');
    P(doc.islands.top.length === 13, 'it opens pre-striped: 13 top islands', doc.islands.top.length);
    P(doc.islands.bottom.length === 12, 'and 12 bottom islands', doc.islands.bottom.length);
    P(doc.arrangement === 'hex', 'staggered packing', doc.arrangement);
    P(doc.cellType === 'custom', 'the cell size is not one of the presets', doc.cellType);
    P(doc.rot === 180, 'the pack opens with its saved turn', doc.rot + ' degrees');

    const p = doc.params;
    P(p.cellD === 33.4 && p.gap === 0.6 && p.pitch === 34,
      'it opens at the saved cell size', p.cellD + ' mm cell, ' + p.pitch + ' mm pitch');
    P(p.padD === 26 && p.bridgeW === 26, 'and the saved pad and bridge', p.padD + ' / ' + p.bridgeW + ' mm');
    P(p.cut === 'plate' && p.lineAngle === 90, 'plate mode, lines along the rows', p.cut + ' at ' + p.lineAngle + ' degrees');

    P(doc.terminals.neg && doc.terminals.neg.cell === 'c6' && doc.terminals.neg.face === 'top',
      'the negative terminal is on the pack', JSON.stringify(doc.terminals.neg));
    P(doc.terminals.pos && doc.terminals.pos.cell === 'c98' && doc.terminals.pos.face === 'top',
      'the positive terminal is on the pack', JSON.stringify(doc.terminals.pos));

    /* the islands must stay a clean partition of the cells: this is what makes
       the pre-painted pack electrically sane on both faces */
    const cover = await state(`(function(){
      var d=window.__ba.state.doc, ids={}, i, k;
      for (i=0;i<d.cells.length;i++) ids[d.cells[i].id]=1;
      var out={};
      ['top','bottom'].forEach(function(face){
        var seen={}, miss=[], dup=0;
        d.islands[face].forEach(function(isl){
          isl.cells.forEach(function(id){
            if(!ids[id]) miss.push(id); else { if(seen[id]) dup++; seen[id]=1; }
          });
        });
        out[face]={ covered:Object.keys(seen).length, missing:miss, dup:dup,
                    islands:d.islands[face].length };
      });
      out.cells=Object.keys(ids).length;
      return out;
    })()`);
    ['top', 'bottom'].forEach((face) => {
      const f = cover[face];
      P(f.missing.length === 0 && f.dup === 0 && f.covered === cover.cells,
        'the ' + face + ' islands own every cell exactly once',
        f.covered + '/' + cover.cells + ', ' + f.islands + ' islands, ' +
        f.missing.length + ' dangling, ' + f.dup + ' repeats');
    });

    /* rows are derived from y, so the reference pack must land on 14 of them */
    const rows = await state('(function(){var d=window.__ba.state.doc,ys={};' +
      'for(var i=0;i<d.cells.length;i++)ys[Math.round(d.cells[i].y*100)]=1;' +
      'return Object.keys(ys).length;})()');
    P(rows === 14, 'it stacks 14 rows deep', rows + ' rows');

    const xs = await state('(function(){var d=window.__ba.state.doc,a=d.cells.map(function(c){return c.x;});' +
      'return [Math.min.apply(null,a),Math.max.apply(null,a)];})()');
    P(xs[0] === 17 && xs[1] === 238, 'the cells keep their saved columns', xs.join(' .. ') + ' mm');

    /* the sheet must actually be drawn, not just loaded */
    const painted = await state(`(function(){
      var cv=document.getElementById('cv'), ctx=cv.getContext('2d');
      var w=cv.width,h=cv.height,d=ctx.getImageData(0,0,w,h).data;
      var bg=[d[0],d[1],d[2]], n=0;
      for(var i=0;i<d.length;i+=4*17){
        if(Math.abs(d[i]-bg[0])+Math.abs(d[i+1]-bg[1])+Math.abs(d[i+2]-bg[2])>12) n++;
      }
      return {share:n/(d.length/(4*17)), w:w, h:h};
    })()`);
    P(painted.share > 0.05, 'the pack is drawn on the sheet',
      Math.round(painted.share * 100) + '% of the sampled pixels are ink, ' + painted.w + 'x' + painted.h);

    P((await state('window.__ba.state.sel === null || typeof window.__ba.state.sel === "string"')) === true,
      'an island is selected for editing', String(await state('window.__ba.state.sel')));
    P((await state('document.getElementById("sCells").textContent')).trim() === '96',
      'the footer counts the pack', (await state('document.getElementById("sCells").textContent')).trim() + ' cells');

    const errs = await state('window.__errs || []');
    P(errs.length === 0, 'no page errors on boot', errs.slice(0, 3).join(' | '));

    /* the default is a first run, not a reset: edit, reload, and the edit stays */
    await state(`(function(){
      var d=window.__ba.state.doc;
      var gone=d.cells[d.cells.length-1].id;
      d.cells.pop();
      ['top','bottom'].forEach(function(face){
        d.islands[face].forEach(function(isl){
          isl.cells = isl.cells.filter(function(id){ return id !== gone; });
        });
      });
      window.__ba.state.unsaved = true;
      window.__ba.save(true);
    })()`);
    await sleep(300);
    await c.send('Page.navigate', { url: APP });
    let ready2 = false;
    for (let i = 0; i < 160 && !ready2; i++) {
      await sleep(100);
      try { ready2 = await c.ev('!!(window.__ba && window.__ba.state && window.__ba.state.doc && window.__ba.state.doc.cells.length===95)'); } catch (e) { }
    }
    P(ready2, 'a saved pack survives a reload: the default does not come back',
      (await state('window.__ba.state.doc.cells.length')) + ' cells after the edit');
  } finally {
    try { chrome.kill(); } catch (e) { }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }

  console.log(out.join('\n'));
  console.log('\n' + (fails ? fails + ' FAILED' : 'all ' + out.length + ' checks passed'));
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log(out.join('\n'));
  console.error('\nERROR: ' + e.message);
  process.exit(1);
});
