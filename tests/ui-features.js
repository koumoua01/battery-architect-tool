/* Exercise the interaction chrome added on top of the original editor:
 * redo, animated zoom, grid, minimap, theme, panels, command palette, help,
 * inspector and the new export buttons.
 *
 *   node tests/ui-features.js
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9344;
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
function txt(id) { return document.getElementById(id) ? '' : ''; }

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-features-'));
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
      source: 'window.__errs=[];addEventListener("error",function(e){window.__errs.push(String(e.message||e.error||e))});addEventListener("unhandledrejection",function(e){window.__errs.push(String(e.reason))});'
    });
    await c.send('Page.navigate', { url: APP });

    let ready = false;
    for (let i = 0; i < 160 && !ready; i++) {
      await sleep(100);
      try { ready = await c.ev('!!(window.__ba && window.__ba.state && window.__ba.state.doc)'); } catch (e) { }
    }
    P(ready, 'the app boots with its UI handle');
    if (!ready) throw new Error('app did not boot');

    const ev = (x) => c.ev(x);
    const click = (id) => ev("document.getElementById('" + id + "').click()");
    const state = (expr) => ev('(' + expr + ')');

    /* cell pointer helper, mapped through the live view */
    const clickCell = () => ev(`(function(){
      var B=window.__ba,s=B.state,cv=document.getElementById('cv');
      var c=s.doc.cells[Math.floor(s.doc.cells.length/2)];
      var f=s.frame,p=B.geo.cellOnFace(s.doc,f,s.face,c);
      var r=cv.getBoundingClientRect();
      var x=r.left+s.px+p.x*s.zoom, y=r.top+s.py+p.y*s.zoom;
      var o={bubbles:true,cancelable:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true,clientX:x,clientY:y};
      cv.dispatchEvent(new PointerEvent('pointerdown',o));
      cv.dispatchEvent(new PointerEvent('pointerup',o));
      return {id:c.id,x:x,y:y};
    })()`);

    const key = (k, mods) => ev("document.dispatchEvent(new KeyboardEvent('keydown'," +
      JSON.stringify(Object.assign({ key: k, bubbles: true }, mods || {})) + "))");

    /* ---------------------------------------------------------------- */
    /* redo                                                              */
    /* ---------------------------------------------------------------- */
    P(await state('document.getElementById("btnUndo").disabled'), 'undo starts disabled');
    P(await state('document.getElementById("btnRedo").disabled'), 'redo starts disabled');

    await click('btnToolDel');
    await clickCell();
    P((await state('window.__ba.state.pick.size')) === 1, 'a cell is picked');
    await key('Delete');
    await sleep(250);
    P((await state('window.__ba.state.doc.cells.length')) === 97, 'Del removes the picked cell');
    P(!(await state('document.getElementById("btnUndo").disabled')), 'undo lights up');
    P(await state('document.getElementById("btnRedo").disabled'), 'redo is still empty');

    await click('btnUndo');
    await sleep(200);
    P((await state('window.__ba.state.doc.cells.length')) === 98, 'the toolbar undo brings it back');
    P(!(await state('document.getElementById("btnRedo").disabled')), 'redo lights up after undo');
    await click('btnRedo');
    await sleep(200);
    P((await state('window.__ba.state.doc.cells.length')) === 97, 'redo removes it again');
    await click('btnUndo');
    await sleep(200);
    P((await state('window.__ba.state.doc.cells.length')) === 98, 'undo restores the pack again');

    /* a fresh edit clears the redo branch */
    P(!(await state('document.getElementById("btnRedo").disabled')), 'redo is available before the new edit');
    await click('btnRowAdd');
    await sleep(200);
    P(await state('document.getElementById("btnRedo").disabled'), 'a new edit clears redo');
    await click('btnUndo');
    await sleep(250);
    P((await state('window.__ba.state.doc.cells.length')) === 98, 'the row add is undone');

    /* keyboard redo */
    await click('btnToolDel');
    await clickCell();
    await key('Delete');
    await sleep(200);
    await key('z', { ctrlKey: true });
    await sleep(200);
    P((await state('window.__ba.state.doc.cells.length')) === 98, 'Ctrl+Z still undoes');
    await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:true,bubbles:true}))");
    await sleep(200);
    P((await state('window.__ba.state.doc.cells.length')) === 97, 'Ctrl+Shift+Z redoes');
    await click('btnUndo');
    await sleep(200);

    /* ---------------------------------------------------------------- */
    /* zoom                                                              */
    /* ---------------------------------------------------------------- */
    const z0 = await state('window.__ba.state.zoom');
    const zl0 = await state('document.getElementById("zoomPct").textContent');
    await click('btnZoomIn');
    await sleep(400);
    const z1 = await state('window.__ba.state.zoom');
    P(z1 > z0 * 1.1, 'the zoom button moves in', z0.toFixed(2) + ' -> ' + z1.toFixed(2));
    P((await state('window.__ba.state.zoomAnim')) === null, 'and the zoom animation settles');
    P((await state('document.getElementById("zoomPct").textContent')) !== zl0, 'the readout follows');
    await click('btnFit');
    await sleep(500);
    const z2 = await state('window.__ba.state.zoom');
    P(Math.abs(z2 - z0) < 0.02, 'fit returns to the fit view', z2.toFixed(2));

    await click('btnZoomOut');
    await sleep(400);
    P((await state('window.__ba.state.zoom')) < z0, 'the zoom out button moves out');
    await click('btnFit');
    await sleep(450);

    /* ---------------------------------------------------------------- */
    /* grid, minimap, theme                                              */
    /* ---------------------------------------------------------------- */
    P(await state('window.__ba.state.grid'), 'the grid starts on');
    await click('btnGrid');
    P(!(await state('window.__ba.state.grid')), 'the toolbar hides the grid');
    P((await state('document.getElementById("btnGrid").getAttribute("aria-pressed")')) === 'false',
      'and says so');
    await click('btnGrid');

    P(await state('window.__ba.state.mini'), 'the minimap starts on');
    await click('btnMini');
    P(!(await state('window.__ba.state.mini')), 'the toolbar hides the minimap');
    P(await state('document.getElementById("mini").hidden'), 'and the canvas is hidden');
    await click('btnMini');
    P(await state('window.__ba.state.mini'), 'and brings it back');
    P(!(await state('document.getElementById("mini").hidden')), 'the minimap canvas is visible');

    /* a drag on the minimap moves the view */
    const miniBefore = await state('({x:window.__ba.state.px, y:window.__ba.state.py})');
    await ev(`(function(){
      var m=document.getElementById('mini'), r=m.getBoundingClientRect();
      var o={bubbles:true,cancelable:true,button:0,pointerId:5,pointerType:'mouse',isPrimary:true,
             clientX:r.left+r.width*0.2, clientY:r.top+r.height*0.25};
      m.dispatchEvent(new PointerEvent('pointerdown',o));
      m.dispatchEvent(new PointerEvent('pointerup',o));
    })()`);
    await sleep(150);
    const miniAfter = await state('({x:window.__ba.state.px, y:window.__ba.state.py})');
    P(miniAfter.x !== miniBefore.x || miniAfter.y !== miniBefore.y,
      'clicking the minimap pans the view',
      Math.round(miniBefore.x) + ',' + Math.round(miniBefore.y) + ' -> ' +
      Math.round(miniAfter.x) + ',' + Math.round(miniAfter.y));
    await click('btnFit');
    await sleep(450);

    await click('btnTheme');
    await sleep(250);
    P((await state('window.__ba.state.theme')) === 'day', 'the theme button turns on daylight');
    P((await state('document.documentElement.getAttribute("data-theme")')) === 'day', 'the CSS follows the theme');
    P((await state('(JSON.parse(localStorage.getItem("battery-architect.ui")||"{}").theme)')) === 'day',
      'and the choice is remembered for next time');

    /* a checked toggle must stay readable on the light panel */
    const tog = await state(`(function(){
      function lum(c){
        var m=c.match(/\\d+(\\.\\d+)?/g).slice(0,3).map(Number).map(function(v){
          v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4);
        });
        return 0.2126*m[0]+0.7152*m[1]+0.0722*m[2];
      }
      var el=document.getElementById('flowOn'), sp=el.nextElementSibling;
      var bg=null, n=el;
      while(n && n!==document.documentElement){
        var b=getComputedStyle(n).backgroundColor;
        if(b && b!=='rgba(0, 0, 0, 0)' && b!=='transparent'){ bg=b; break; }
        n=n.parentElement;
      }
      if(!bg) bg=getComputedStyle(document.body).backgroundColor;
      var fg=lum(getComputedStyle(sp).color), bk=lum(bg);
      return { checked:el.checked, color:getComputedStyle(sp).color, bg:bg,
        ratio:Math.round(((Math.max(fg,bk)+0.05)/(Math.min(fg,bk)+0.05))*100)/100 };
    })()`);
    P(tog.checked, 'the flow toggle is on by default');
    P(tog.ratio >= 4.5, 'checked toggle text stays readable in daylight',
      tog.color + ' on ' + tog.bg + ', ' + tog.ratio + ':1');

    await click('btnTheme');
    await sleep(250);
    P((await state('window.__ba.state.theme')) === 'midnight', 'and back to midnight');

    /* ---------------------------------------------------------------- */
    /* focus mode                                                        */
    /* ---------------------------------------------------------------- */
    const stage0 = await state('document.getElementById("stage").getBoundingClientRect().width');
    await click('btnLeft');
    await sleep(600);
    P(await state('document.getElementById("app").classList.contains("no-left")'), 'the left panel hides');
    const stage1 = await state('document.getElementById("stage").getBoundingClientRect().width');
    P(stage1 > stage0 + 100, 'the canvas takes the space', Math.round(stage0) + ' -> ' + Math.round(stage1));
    await click('btnRight');
    await sleep(600);
    P(await state('document.getElementById("app").classList.contains("no-right")'), 'the right panel hides');
    const stage2 = await state('document.getElementById("stage").getBoundingClientRect().width');
    P(stage2 > stage1 + 100, 'and the canvas grows again', Math.round(stage1) + ' -> ' + Math.round(stage2));
    await click('btnLeft');
    await click('btnRight');
    await sleep(700);
    P(!(await state('document.getElementById("app").classList.contains("no-left")')) &&
      !(await state('document.getElementById("app").classList.contains("no-right")')),
      'both panels come back');

    /* ---------------------------------------------------------------- */
    /* island hover and zoom-to-island                                   */
    /* ---------------------------------------------------------------- */
    const islHover = await ev(`(function(){
      var li=document.querySelectorAll('#islands li')[0];
      if(!li) return null;
      li.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));
      var hot=window.__ba.state.hiIsland;
      li.dispatchEvent(new MouseEvent('mouseleave',{bubbles:false}));
      return {hot:hot, after:window.__ba.state.hiIsland};
    })()`);
    P(!!islHover && islHover.hot, 'hovering an island in the list highlights it');
    P(!islHover || !islHover.after, 'and leaving clears the highlight');

    const color0 = await state('window.__ba.state.doc.islands[window.__ba.state.face][0].color');
    await ev("document.querySelectorAll('#islands li')[0].querySelector('.sw').click()");
    await sleep(150);
    const color1 = await state('window.__ba.state.doc.islands[window.__ba.state.face][0].color');
    P(color1 !== color0, 'clicking an island swatch steps its colour', color0 + ' -> ' + color1);

    const zoomI0 = await state('window.__ba.state.zoom');
    await ev(`(function(){var li=document.querySelectorAll('#islands li')[0]; if(li) li.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));})()`);
    await sleep(500);
    const zoomI1 = await state('window.__ba.state.zoom');
    P(zoomI1 > zoomI0, 'double-clicking an island frames it', zoomI0.toFixed(2) + ' -> ' + zoomI1.toFixed(2));
    await click('btnFit');
    await sleep(500);

    /* arrow keys pan without touching the document */
    const pan0 = await state('window.__ba.state.px');
    await key('ArrowLeft');
    const pan1 = await state('window.__ba.state.px');
    P(Math.abs(pan1 - pan0 - 40) < 0.5, 'an arrow key pans the view', Math.round(pan0) + ' -> ' + Math.round(pan1));
    await key('ArrowRight');

    /* ---------------------------------------------------------------- */
    /* command palette and help                                          */
    /* ---------------------------------------------------------------- */
    await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))");
    await sleep(260);
    P(!(await state('document.getElementById("paletteModal").hidden')), 'Ctrl+K opens the palette');
    await ev(`(function(){var i=document.getElementById('cmdInput');i.value='10 mm grid';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(100);
    const cmdCount = await state('window.__ba.state.cmd.items.length');
    P(cmdCount >= 1, 'typing filters the command list', cmdCount + ' match');
    await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await sleep(300);
    P(!(await state('window.__ba.state.grid')), 'Enter runs the highlighted command (grid off)');
    P(await state('document.getElementById("paletteModal").hidden'), 'and the palette closes');
    await click('btnGrid');

    await click('btnHelp');
    await sleep(260);
    P(!(await state('document.getElementById("helpModal").hidden')), 'the help button opens the shortcuts');
    await key('Escape');
    await sleep(260);
    P(await state('document.getElementById("helpModal").hidden'), 'Escape closes it');

    /* ---------------------------------------------------------------- */
    /* inspector and pack name                                           */
    /* ---------------------------------------------------------------- */
    await ev(`(function(){
      var B=window.__ba,s=B.state,cv=document.getElementById('cv');
      var c=s.doc.cells[Math.floor(s.doc.cells.length/2)];
      var f=s.frame,p=B.geo.cellOnFace(s.doc,f,s.face,c);
      var r=cv.getBoundingClientRect();
      cv.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,pointerType:'mouse',isPrimary:true,
        clientX:r.left+s.px+p.x*s.zoom, clientY:r.top+s.py+p.y*s.zoom}));
    })()`);
    await sleep(120);
    P(await state('document.getElementById("inspector").classList.contains("show")'), 'hovering a cell shows the inspector');
    P((await state('document.getElementById("insName").textContent')).indexOf('Cell') === 0, 'the inspector names the cell');
    await ev("document.getElementById('cv').dispatchEvent(new PointerEvent('pointerleave',{bubbles:true,pointerId:1,pointerType:'mouse'}))");
    P(!(await state('document.getElementById("inspector").classList.contains("show")')), 'leaving the canvas hides it');

    await ev("(function(){var i=document.getElementById('docName');i.value='test pack';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
    P((await state('window.__ba.state.doc.name')) === 'test pack', 'the pack name edits the document');
    P((await state('document.getElementById("saveState").textContent')).indexOf('edited') >= 0,
      'the header says the edit is waiting to be saved');
    await sleep(1400);
    P((await state('document.getElementById("saveState").textContent')).indexOf('saved') >= 0,
      'and the autosave settles by itself');
    await ev("(function(){var i=document.getElementById('docName');i.value='my pack';i.dispatchEvent(new Event('input',{bubbles:true}));})()");

    /* ---------------------------------------------------------------- */
    /* PNG export                                                        */
    /* ---------------------------------------------------------------- */
    await click('btnPng');
    await sleep(1400);
    P((await state('document.getElementById("toast").textContent')).indexOf('PNG written') >= 0,
      'the PNG button writes a picture', await state('document.getElementById("toast").textContent'));

    await click('btnReport');
    await sleep(400);
    P((await state('document.getElementById("toast").textContent')).indexOf('Design report written') >= 0,
      'the report button writes a Markdown summary',
      await state('document.getElementById("toast").textContent'));
    const rep = await state('window.__ba.report()');
    P(rep.indexOf('# my pack - design report') === 0, 'the report starts with the pack name');
    P(rep.indexOf('## Cut') > 0 && rep.indexOf('## Checks') > 0, 'and carries the cut settings and checks');
    P(rep.indexOf('## Top sheet') > 0 && rep.indexOf('## Bottom sheet') > 0, 'and both faces');

    const errs = await state('window.__errs || []');
    P(errs.length === 0, 'no uncaught errors during the run', errs.join(' | '));

    c.ws.close();
  } catch (e) {
    P(false, 'the harness finished', e.message);
  } finally {
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
  out.forEach((l) => console.log(l));
  console.log(fails ? 'UI FAIL (' + fails + ')' : 'UI PASS');
  process.exit(fails ? 1 : 0);
})();
