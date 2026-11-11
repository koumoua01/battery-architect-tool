/* The current path has to move island by island, not as one unbroken line.
 *
 *   node tests/flow-app.js
 *
 * A twelve-cell chain spanning eleven islands is driven through both views:
 * the default Island centers route has eleven nodes and ten segments; the Cell
 * route still has eleven runs and ten hops. The test also catches the plan
 * being built before its first draw (flowInfo null), a missing segment or hop,
 * a face change that forgets to mirror the route, and the C toggle.
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9381;
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
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

/* a twelve-cell strip folded into two rows: top islands pair the cells, bottom
   islands are offset by one, so every cell is an edge in one long series chain */
const CHAIN = `(function(){
  var B=window.__ba, p=21.8, cells=[], order=[];
  for (var r=0;r<2;r++) for (var c=0;c<6;c++) {
    var col = r===0 ? c : 5-c, id='p'+(r*6+c);
    cells.push({id:id,x:col*p,y:r*p,flip:false});
    order.push(id);
  }
  for (var i=0;i<order.length;i++) cells[i].flip = (i%2===1);
  var top=[], bottom=[], colors=['#4fc3f7','#aed581','#ffb74d','#ba68c8','#4db6ac','#e57373'];
  for (var t=0;t<order.length;t+=2) top.push({id:'t'+(t/2),name:'TOP '+(t/2+1),color:colors[(t/2)%6],cells:order.slice(t,t+2)});
  bottom.push({id:'b0',name:'BOT 1',color:'#9575cd',cells:[order[0]]});
  for (var b=1;b<order.length-1;b+=2) bottom.push({id:'b'+b,name:'BOT '+(b+1),color:colors[b%6],cells:order.slice(b,b+2)});
  bottom.push({id:'b'+order.length,name:'BOT '+bottom.length,color:'#ffb74d',cells:[order[order.length-1]]});
  var doc={version:1,name:'flow demo',cellType:'21700',arrangement:'square',cells:cells,
    islands:{top:top,bottom:bottom},
    params:{cellD:21.2,gap:0.6,pitch:p,padD:18,bridgeW:18,kerf:0.1,margin:8,step:0.1,cut:'plate',lineAngle:90,guides:false,guideL:8},
    terminals:{neg:{face:'bottom',cell:order[0]},pos:{face:'bottom',cell:order[order.length-1]}}};
  B.state.doc=doc; B.rebuild(); B.fit(); B.state.dirty=true;
  return true;
})()`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'));
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
    await sleep(1500);

    await c.ev(CHAIN);
    const initialMode = await c.ev('window.__ba.state.flowMode');
    ok(initialMode === 'islands', 'the island-center route is the default', initialMode);
    await c.ev("window.__ba.flowMode('cells')");
    await sleep(700);

    /* the exact pad-to-pad route is still the detailed view */
    const info = await c.ev('window.__ba.flowInfo()');
    const note = await c.ev('document.getElementById("flowNote").textContent');
    ok(!!info, 'the cell plan exists after the first draw');
    ok(info && info.mode === 'cells', 'the cell route is selected', info && info.mode);
    ok(info && info.runs === 11, 'the route is cut into one run per island', info && info.runs + ' runs');
    ok(info && info.hops === 10, 'each pair of runs is joined by one hop', info && info.hops + ' hops');
    ok(info && info.islands === 11, 'the panel counts every island it crosses', info && info.islands + ' islands');
    ok(info && info.total > 5000, 'the cell animation has a full island-by-island cycle', info && info.total + ' ms');
    ok(/through 11 islands/.test(note), 'the Current panel says how many islands are crossed', note);
    ok(/pad-to-pad/.test(note), 'the panel explains the cell route');

    let sawRun = false, sawHop = false, hopFrame = null;
    for (let i = 0; i < 120 && !(sawRun && sawHop); i++) {
      const now = await c.ev('window.__ba.flowNow()');
      if (now && now.kind === 'run') sawRun = true;
      if (now && now.kind === 'hop') { sawHop = true; hopFrame = now; }
      await sleep(70);
    }
    ok(sawRun, 'a bright run plays inside one island');
    ok(sawHop, 'the pulse then jumps to the next island', hopFrame ? 'hop ' + hopFrame.from + ' -> ' + (hopFrame.from + 1) : 'no hop');

    /* island centres: one node per island, one straight arrow between them */
    await c.ev("window.__ba.flowMode('islands')");
    await sleep(650);
    const isl = await c.ev('window.__ba.flowInfo()');
    const islNote = await c.ev('document.getElementById("flowNote").textContent');
    ok(isl && isl.mode === 'islands', 'the island-center route can be selected', isl && isl.mode);
    ok(isl && isl.nodes === 11, 'there is one node for every island on the route', isl && isl.nodes + ' nodes');
    ok(isl && isl.segments === 10, 'the nodes are joined by island-to-island segments', isl && isl.segments + ' segments');
    ok(isl && isl.islands === 11, 'the island route still covers every island', isl && isl.islands + ' islands');
    ok(/island centers/.test(islNote), 'the Current panel explains the island route', islNote);
    const savedMode = await c.ev('JSON.parse(localStorage.getItem("battery-architect.ui")||"{}").flowMode');
    ok(savedMode === 'islands', 'the route choice is remembered', savedMode);

    let sawSeg = false, segFrame = null;
    for (let i = 0; i < 80 && !sawSeg; i++) {
      const now = await c.ev('window.__ba.flowNow()');
      if (now && now.kind === 'seg') { sawSeg = true; segFrame = now; }
      await sleep(70);
    }
    ok(sawSeg, 'a pulse travels from one island centre to the next',
      segFrame ? 'segment ' + segFrame.seg : 'no segment');

    let shot = false;
    for (let i = 0; i < 80 && !shot; i++) {
      const now = await c.ev('window.__ba.flowNow()');
      if (now && now.kind === 'seg' && now.u > 0.15 && now.u < 0.85) {
        await c.shot(path.join(ROOT, 'out', 'ui-flow.png'));
        shot = true;
      }
      await sleep(35);
    }
    ok(shot, 'the island route was captured for the docs');

    await c.ev("document.getElementById('btnBottom').click()");
    await sleep(500);
    const mirrored = await c.ev('window.__ba.flowInfo()');
    const at = await c.ev('window.__ba.flowNow()');
    ok(mirrored && mirrored.mode === 'islands' && mirrored.nodes === 11 && !!at,
      'the same island centres rebuild and play on the bottom sheet',
      mirrored ? mirrored.nodes + ' nodes, phase ' + at.kind : 'none');

    await c.ev('window.__ba.flow(false)');
    const off = await c.ev('window.__ba.flowNow()');
    ok(off === null, 'hiding the flow also stops the phase');
    await c.ev('window.__ba.flow(true)');
    await sleep(400);
    const on = await c.ev('window.__ba.flowNow()');
    ok(!!on, 'showing it again restarts the island pulse');

    const err = await c.ev('window.__uiErr || null');
    ok(!err, 'no page errors', err || 'clean');

    /* reduced motion must keep the static island nodes and skip the pulse */
    const tab2 = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json();
    const c2 = await CDP.connect(tab2.webSocketDebuggerUrl);
    await c2.send('Runtime.enable');
    await c2.send('Page.enable');
    await c2.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await c2.send('Page.navigate', { url: APP });
    await sleep(1500);
    await c2.ev(CHAIN);
    await c2.ev("window.__ba.flowMode('islands')");
    await sleep(700);
    const calm = await c2.ev('window.__ba.flowInfo()');
    const calmErr = await c2.ev('window.__uiErr || null');
    ok(calm && calm.mode === 'islands' && calm.nodes === 11,
      'reduced motion still builds every island node', calm && calm.nodes + ' nodes');
    ok(!calmErr, 'reduced motion draws the static island route without an error', calmErr || 'clean');
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + e.message);
  } finally {
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
  console.log(failures ? 'FLOW FAIL (' + failures + ')' : 'FLOW PASS');
  process.exitCode = failures ? 1 : 0;
})();
