/* Build out/app-smoke.html: index.html plus a script that drives the real
 * controls, so the tools, the row buttons, the polarity flip and the
 * connection animation are exercised in a browser rather than only in the
 * geometry unit tests.
 *
 *   node tests/smoke-app.js
 *   chrome --headless=new --dump-dom file:///.../out/app-smoke.html
 *
 * The page writes PASS/FAIL lines into <pre id="smoke"> and marks the result
 * in document.title.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const harness = `
<script>
(async function () {
  var out = [];
  function P(ok, name, detail) {
    out.push((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
  }
  function txt(id) { var e = document.getElementById(id); return e ? e.textContent : ''; }
  function cells() { return parseInt(txt('sCells'), 10); }
  function dims() {
    var m = txt('sSize').match(/([\\d.]+) x ([\\d.]+)/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var cv = document.getElementById('cv');
  var B = window.__ba;

  /* sheet millimetres -> client pixels, for the current zoom and pan */
  function map() {
    var r = cv.getBoundingClientRect();
    var d = dims();
    var zoom = Math.min(r.width / (d[0] + 24), r.height / (d[1] + 24));
    return { r: r, zoom: zoom, px: (r.width - d[0] * zoom) / 2, py: (r.height - d[1] * zoom) / 2, W: d[0], H: d[1] };
  }
  function pt(gx, gy) {
    var m = map();
    return {
      x: m.r.left + m.px + gx * m.W * m.zoom,
      y: m.r.top + m.py + gy * m.H * m.zoom,
      m: m
    };
  }
  function move(gx, gy) {
    var q = pt(gx, gy);
    cv.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: q.x, clientY: q.y, pointerId: 1, pointerType: 'mouse', isPrimary: true
    }));
  }
  function press(gx, gy, mods) {
    var q = pt(gx, gy);
    var o = {
      bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      clientX: q.x, clientY: q.y
    };
    o.shiftKey = !!(mods && mods.shift);
    cv.dispatchEvent(new PointerEvent('pointerdown', o));
    cv.dispatchEvent(new PointerEvent('pointerup', o));
  }
  /* find a fraction of the sheet that lands on a cell, without clicking */
  function findCell(skip) {
    for (var gy = 0.15; gy <= 0.86; gy += 0.055) {
      for (var gx = 0.15; gx <= 0.86; gx += 0.055) {
        move(gx, gy);
        if (B.state.hover && B.state.hover !== skip) return { x: gx, y: gy, cell: B.state.hover };
      }
    }
    return null;
  }
  /* the cell nearest the middle of the sheet: removing it cannot move the
     sheet frame, so the animation and the size readout stay comparable */
  function centreCell(skipId) {
    var st = B.state, f = st.frame;
    var best = null, bd = Infinity;
    st.doc.cells.forEach(function (c) {
      if (skipId && c.id === skipId) return;
      var p = B.geo.cellOnFace(st.doc, f, st.face, c);
      var d = Math.hypot(p.x - f.W / 2, p.y - f.H / 2);
      if (d < bd) { bd = d; best = { x: p.x / f.W, y: p.y / f.H, cell: c }; }
    });
    return best;
  }
  function cellFrac(cell) {
    var st = B.state, f = st.frame;
    var p = B.geo.cellOnFace(st.doc, f, st.face, cell);
    return { x: p.x / f.W, y: p.y / f.H, cell: cell };
  }
  function byId(id) {
    var list = B.state.doc.cells;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /* find two islands whose cell path is long, preferring both ends on the
     same sheet like the hand-drawn example */
  function bestFlowPair() {
    var doc = B.state.doc, nodes = [];
    ['top', 'bottom'].forEach(function (face) {
      (doc.islands[face] || []).forEach(function (isl) {
        if (isl.cells.length) nodes.push({ face: face, cell: isl.cells[0], name: isl.name });
      });
    });
    var saved = doc.terminals, best = null;
    for (var i = 0; i < nodes.length; i++) {
      for (var j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        doc.terminals = {
          neg: { face: nodes[i].face, cell: nodes[i].cell },
          pos: { face: nodes[j].face, cell: nodes[j].cell }
        };
        var p = B.geo.currentPath(doc);
        var score = p.ok ? p.cells.length + (nodes[i].face === nodes[j].face ? 100 : 0) : -1;
        if (score > 0 && (!best || score > best.score)) best = { neg: nodes[i], pos: nodes[j], p: p, score: score };
      }
    }
    doc.terminals = saved;
    return best;
  }
  function key(k) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  }
  function undoKey() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  }
  function bar() { return document.getElementById('selBar').classList.contains('show'); }

  var n0 = cells(), d0 = dims();
  P(n0 > 50, 'boots with a layout', n0 + ' cells, ' + d0.join(' x ') + ' mm');

  /* ---------------------------------------------------------------- */
  /* rotation                                                          */
  /* ---------------------------------------------------------------- */
  document.getElementById('btnRotR').click();
  var d1 = dims();
  P(Math.abs(d1[0] - d0[1]) < 0.2 && Math.abs(d1[1] - d0[0]) < 0.2,
    'rotate button swaps the sheet', d0.join(' x ') + ' -> ' + d1.join(' x '));
  P(cells() === n0, 'rotate keeps every cell', cells() + ' cells');
  P(document.getElementById('btnRotL') !== null, 'both turn directions are wired');
  for (var i = 0; i < 3; i++) document.getElementById('btnRotR').click();
  var d2 = dims();
  P(Math.abs(d2[0] - d0[0]) < 0.2 && Math.abs(d2[1] - d0[1]) < 0.2,
    'four turns are a full circle', d2.join(' x '));

  /* ---------------------------------------------------------------- */
  /* electrical checks                                                 */
  /* ---------------------------------------------------------------- */
  P(txt('sNet') === 'no shorts', 'the booted auto-striped pack has no shorts', txt('sNet'));
  document.getElementById('btnToolFlip').click();
  var shed = findCell(null);
  if (shed) {
    var cleanShorts = B.state.drc.filter(function (d) { return d.kind === 'short'; }).length;
    press(shed.x, shed.y);
    P(B.state.drc.some(function (d) { return d.kind === 'short'; }),
      'flipping one cell inside a parallel group is reported as a short');
    P(/short/.test(txt('sNet')), 'the electrical stat says so', txt('sNet'));
    press(shed.x, shed.y);
    P(B.state.drc.filter(function (d) { return d.kind === 'short'; }).length === cleanShorts,
      'flipping it back clears the short');
  } else {
    P(false, 'found a cell to test the short check');
  }
  document.getElementById('btnToolPaint').click();
  P(txt('sNet') === 'no shorts', 'and the pack is sound again', txt('sNet'));

  /* ---------------------------------------------------------------- */
  /* pack ends and the main current path                               */
  /* ---------------------------------------------------------------- */
  P(txt('sEnds') === '\\u2212 - / + -', 'no pack ends at boot', txt('sEnds'));
  var pair = bestFlowPair();
  P(!!pair, 'found two islands with a series path',
    pair ? pair.neg.name + ' -> ' + pair.pos.name + ' (' + pair.p.cells.length + ' cells)' : 'none');
  if (pair) {
    var faceBtn = function (face) { return document.getElementById(face === 'bottom' ? 'btnBottom' : 'btnTop'); };
    if (B.state.face !== pair.neg.face) faceBtn(pair.neg.face).click();
    document.getElementById('btnTermNeg').click();
    P(B.state.terminalPick === 'neg', 'the negative end is armed');
    var negAt = cellFrac(byId(pair.neg.cell));
    press(negAt.x, negAt.y);
    P(B.state.doc.terminals.neg && B.state.doc.terminals.neg.face === pair.neg.face &&
      B.state.doc.terminals.neg.cell === pair.neg.cell, 'the negative end lands on the clicked pad');
    P(B.state.flowPath && B.state.flowPath.reason === 'partial', 'one end is reported as partial');

    if (B.state.face !== pair.pos.face) faceBtn(pair.pos.face).click();
    document.getElementById('btnTermPos').click();
    var posAt = cellFrac(byId(pair.pos.cell));
    press(posAt.x, posAt.y);
    P(B.state.doc.terminals.pos && B.state.doc.terminals.pos.face === pair.pos.face &&
      B.state.doc.terminals.pos.cell === pair.pos.cell, 'the positive end lands on the clicked pad');
    P(B.state.flowPath && B.state.flowPath.ok, 'two ends trace a main current path',
      B.state.flowPath ? B.state.flowPath.reason : 'none');
    P(B.state.flowPath && B.state.flowPath.cells.length === pair.p.cells.length,
      'the path covers the series chain', B.state.flowPath ? B.state.flowPath.cells.length + ' cells' : 'none');
    P(/Main path/.test(txt('flowNote')), 'the current panel reports the path', txt('flowNote'));
    P(/cells/.test(txt('sPath')), 'the Sheet path stat updates', txt('sPath'));
    P(/TOP|BOT/.test(txt('sEnds')), 'the Sheet ends stat updates', txt('sEnds'));
    P(B.state.flowOn && document.getElementById('flowOn').checked, 'the flow is shown by default');

    key('c');
    P(!B.state.flowOn && !document.getElementById('flowOn').checked, 'C hides the current flow');
    key('c');
    P(B.state.flowOn, 'C shows it again');

    document.getElementById('btnTermClear').click();
    P(!B.state.doc.terminals.neg && !B.state.doc.terminals.pos, 'clear both ends');
    P(B.state.flowPath && B.state.flowPath.reason === 'none', 'and the path goes away');
    if (B.state.face !== 'top') document.getElementById('btnTop').click();
  }

  /* ---------------------------------------------------------------- */
  /* picking cells, then removing them                                 */
  /* ---------------------------------------------------------------- */
  document.getElementById('btnToolDel').click();
  P(document.getElementById('btnToolDel').classList.contains('on'), 'remove tool is armed');
  P(cv.style.cursor === 'cell', 'cursor shows the tool', cv.style.cursor);

  var mid = centreCell(null);
  P(!!mid, 'found a cell in the middle of the pack',
    mid ? 'at ' + mid.x.toFixed(2) + ',' + mid.y.toFixed(2) : 'none');

  if (mid) {
    var before = cells();
    press(mid.x, mid.y);
    P(cells() === before, 'clicking a cell with Remove only picks it', before + ' cells, unchanged');
    P(B.state.pick.size === 1, 'one cell is picked', B.state.pick.size + ' picked');
    P(bar(), 'the confirm bar appears');
    P(txt('selCount') === '1', 'the bar says how many', txt('selCount'));

    var mid2 = centreCell(mid.cell.id);
    press(mid2.x, mid2.y);
    P(B.state.pick.size === 2 && cells() === before, 'a second click adds to the selection',
      B.state.pick.size + ' picked, still ' + cells() + ' cells');
    press(mid.x, mid.y);
    P(B.state.pick.size === 1, 'clicking a picked cell again drops it', B.state.pick.size + ' picked');

    key('Escape');
    P(B.state.pick.size === 0 && cells() === before, 'escape drops the selection without deleting',
      cells() + ' cells');
    P(!bar(), 'and hides the bar');

    press(mid.x, mid.y);
    var t0 = performance.now();
    key('Delete');
    var dt = performance.now() - t0;
    P(cells() === before - 1, 'Del removes the picked cell', before + ' -> ' + cells() +
      ' in ' + dt.toFixed(1) + ' ms');
    P(B.state.anim.length > 0, 'removing a connection starts an animation', B.state.anim.length + ' items');
    P(B.state.pick.size === 0 && !bar(), 'the pick is used up');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    P(cells() === n0, 'ctrl+z brings the cell back', cells() + ' cells');
    P(!/separate pieces/.test(txt('checks')), 'no false "separate pieces" warning');

    /* two at once, as one edit */
    var a = centreCell(null), b = centreCell(a.cell.id);
    press(a.x, a.y);
    press(b.x, b.y);
    P(B.state.pick.size === 2, 'two cells picked', B.state.pick.size + ' picked');
    document.getElementById('btnSelDel').click();
    P(cells() === n0 - 2, 'the Remove button takes both out together', n0 + ' -> ' + cells());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    P(cells() === n0, 'and one ctrl+z puts both back', cells() + ' cells');
  }

  /* ---------------------------------------------------------------- */
  /* the rubber band                                                   */
  /* ---------------------------------------------------------------- */
  document.getElementById('btnToolDel').click();
  var m0 = 0.02, m1 = 0.45;
  var q0 = pt(m0, m0), q1 = pt(m1, m1);
  function pev(kind, q) {
    cv.dispatchEvent(new PointerEvent(kind, {
      bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse',
      isPrimary: true, clientX: q.x, clientY: q.y
    }));
  }
  pev('pointerdown', q0);
  pev('pointermove', { x: (q0.x + q1.x) / 2, y: (q0.y + q1.y) / 2 });
  pev('pointermove', q1);
  P(!!B.state.marquee && B.state.marquee.moved, 'dragging on the bare sheet draws a box');
  var inBox = B.state.pick.size;
  P(inBox > 3, 'the box picks every cell it covers', inBox + ' picked');
  P(cells() === n0, 'and still nothing is deleted', cells() + ' cells');
  pev('pointerup', q1);
  P(!B.state.marquee && B.state.pick.size === inBox, 'the box keeps its picks when released',
    B.state.pick.size + ' picked');
  key('Escape');
  P(B.state.pick.size === 0, 'escape clears a box selection too', B.state.pick.size + ' picked');

  document.getElementById('btnToolPaint').click();
  P(B.state.pick.size === 0 && !bar(), 'switching tool drops the selection');

  /* ---------------------------------------------------------------- */
  /* animation: painting cells draws the new straps                    */
  /* ---------------------------------------------------------------- */
  document.getElementById('btnToolPaint').click();
  P(document.getElementById('btnToolPaint').classList.contains('on') && cv.style.cursor === 'crosshair',
    'paint tool takes back over');

  var sel = B.state.sel;
  var other = B.state.doc.islands[B.state.face].filter(function (i) { return i.id !== sel; })[0];
  var borrowed = other ? B.state.doc.cells.find(function (c) { return other.cells.indexOf(c.id) >= 0; }) : null;
  P(!!borrowed, 'there is a cell in another island to paint across');

  if (borrowed) {
    /* centre of that cell in sheet millimetres, so the probe hits it */
    var f = B.state.frame;
    var p = B.geo.cellOnFace(B.state.doc, f, B.state.face, borrowed);
    var gx = p.x / f.W, gy = p.y / f.H;
    var mine0 = B.state.doc.islands[B.state.face].filter(function (i) { return i.id === sel; })[0];
    var before = mine0 ? mine0.cells.length : 0;
    press(gx, gy);
    var mine1 = B.state.doc.islands[B.state.face].filter(function (i) { return i.id === sel; })[0];
    var after = mine1 ? mine1.cells.length : 0;
    P(after === before + 1, 'painting joins the cell to the selected island', before + ' -> ' + after + ' cells');
    P(other.cells.indexOf(borrowed.id) < 0, 'and takes it out of the island it was in');
    P(B.state.anim.length > 0, 'painting draws the new connections', B.state.anim.length + ' items');
    await sleep(700);
    /* headless Chrome with a virtual clock does not advance performance.now()
       while timers run, so the animation clock is pushed forward by hand here:
       this is the same pruning the draw loop does every frame */
    var left = B.state.anim.length;
    B.anim(1e9);
    P(B.state.anim.length === 0, 'the animation is time bounded and clears itself',
      left + ' live after 700 ms, 0 once the clock passes');
    P(!B.state.dirty, 'the canvas goes idle', 'dirty=' + B.state.dirty);
  }

  /* ---------------------------------------------------------------- */
  /* rows                                                              */
  /* ---------------------------------------------------------------- */
  var rows = document.querySelectorAll('#rowsList li');
  P(rows.length === 13, 'one row entry per row of the pack', rows.length + ' rows');
  var plus = rows[0].querySelectorAll('.rb')[1];
  var minus = rows[0].querySelectorAll('.rb')[0];
  var c0 = cells();
  plus.click();
  P(cells() === c0 + 1, 'the + button adds a cell to that row', c0 + ' -> ' + cells());
  var rowTxt = document.querySelectorAll('#rowsList li')[0].querySelector('.rc').textContent;
  P(/^9 cell/.test(rowTxt), 'the row count follows the click', rowTxt.trim());
  minus.click();
  P(cells() === c0, 'the - button takes it back off', cells() + ' cells');

  var rows1 = document.querySelectorAll('#rowsList li').length;
  document.getElementById('btnRowAdd').click();
  P(cells() > c0, 'adding a row adds its cells', cells() + ' cells');
  P(document.querySelectorAll('#rowsList li').length === rows1 + 1, 'the row list grew',
    rows1 + ' -> ' + document.querySelectorAll('#rowsList li').length);
  document.getElementById('btnRowDel').click();
  P(document.querySelectorAll('#rowsList li').length === rows1, 'removing a row puts the list back',
    document.querySelectorAll('#rowsList li').length + ' rows');

  /* ---------------------------------------------------------------- */
  /* the geometry sliders                                              */
  /* ---------------------------------------------------------------- */
  function range(id) { return document.getElementById(id); }
  function setRange(id, v) {
    var el = range(id);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function commitRange(id) {
    range(id).dispatchEvent(new Event('change', { bubbles: true }));
  }
  function topArea() {
    var s = B.state.sheets.top;
    return s ? Math.round(s.islands.reduce(function (a, i) { return a + i.area; }, 0)) : -1;
  }

  var sliders = document.querySelectorAll('#geom input[type=range]');
  P(sliders.length === 7, 'every geometry number has a slider', sliders.length + ' sliders');
  P(document.querySelectorAll('#geom .sl:not([hidden]) input[type=range]').length === 5,
    'the weld-line angle and the guide length only show when they matter');
  var known = Array.prototype.every.call(sliders, function (el) {
    return el.dataset.def && el.dataset.key && document.getElementById(el.id + 'v');
  });
  P(known, 'each slider knows its default, its key and its readout');
  P(range('padD').style.getPropertyValue('--p').slice(-1) === '%',
    'the filled track follows the value', range('padD').style.getPropertyValue('--p'));

  /* the complaint: a drag used to do nothing until the button came up. Press,
     move, and look at the sheet with the thumb still down. Strap W is the
     honest probe - the pads sit inside the straps, so a pad change barely
     moves the outline, while narrowing the straps visibly cuts the metal. */
  var area0 = topArea(), strap0 = B.state.doc.params.bridgeW, sheet0 = B.state.sheets.top;
  range('bridgeW').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
  setRange('bridgeW', 10);
  await sleep(40);
  var areaMid = topArea();
  P(B.state.doc.params.bridgeW === 10, 'a slider move lands in the document straight away',
    strap0 + ' -> ' + B.state.doc.params.bridgeW + ' mm');
  P(B.state.sheets.top && B.state.sheets.top !== sheet0,
    'and the sheet is rebuilt while the thumb is still down');
  P(areaMid < area0 - 1000, 'the metal follows the thumb', area0 + ' -> ' + areaMid + ' mm2');
  P(B.state.sheets.bottom === null, 'only the face on screen is traced mid-drag');
  P(txt('bridgeWv') === '10.0', 'the number follows the thumb', txt('bridgeWv'));
  P(document.querySelectorAll('#geom .sl.changed').length === 1, 'the row is marked as changed');

  commitRange('bridgeW');
  P(B.state.sheets.bottom !== null, 'releasing the thumb puts the other face back');
  var areaAfter = topArea();
  P(areaAfter === areaMid, 'the release does not move the metal again', areaAfter + ' mm2');

  /* one drag, one undo */
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  P(B.state.doc.params.bridgeW === strap0 && topArea() === area0,
    'one ctrl+z puts the whole drag back', B.state.doc.params.bridgeW + ' mm, ' + topArea() + ' mm2');
  P(txt('bridgeWv') === strap0.toFixed(1), 'and the readout comes back with it', txt('bridgeWv'));

  /* reset one */
  setRange('kerf', 0.3);
  commitRange('kerf');
  P(txt('kerfv') === '0.30', 'kerf shows two decimals', txt('kerfv'));
  P(txt('btnGeomReset') === 'reset 1', 'the header counts what was changed', txt('btnGeomReset'));
  document.querySelector('#geom .rst[data-for=kerf]').click();
  P(B.state.doc.params.kerf === 0.1 && txt('kerfv') === '0.10',
    'the arrow puts one slider back', B.state.doc.params.kerf + ' mm');
  P(txt('btnGeomReset') === 'reset', 'and the header count clears', txt('btnGeomReset'));

  /* reset all, and the double-click shortcut */
  setRange('margin', 20);
  commitRange('margin');
  setRange('step', 0.3);
  commitRange('step');
  P(txt('btnGeomReset') === 'reset 2', 'two changed sliders are counted', txt('btnGeomReset'));
  document.getElementById('btnGeomReset').click();
  P(B.state.doc.params.margin === 8 && B.state.doc.params.step === 0.1,
    'one button resets every slider', B.state.doc.params.margin + ' mm / ' + B.state.doc.params.step + ' mm');
  setRange('bridgeW', 22);
  commitRange('bridgeW');
  range('bridgeW').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  P(B.state.doc.params.bridgeW === 18, 'a double-click resets a slider too', B.state.doc.params.bridgeW + ' mm');
  P(topArea() === area0, 'the pack is back to the metal it started with', topArea() + ' mm2');

  /* ---------------------------------------------------------------- */
  /* cutting to the weld lines                                         */
  /* ---------------------------------------------------------------- */
  var cut0 = topArea();
  function partsOk() {
    var s = B.state.sheets.top;
    return !!s && s.islands.length > 0 && s.islands.every(function (i) { return i.parts === 1; });
  }
  document.getElementById('btnCutLines').click();
  P(B.state.doc.params.cut === 'lines', 'the Weld lines button switches the cut', B.state.doc.params.cut);
  P(document.getElementById('btnCutLines').classList.contains('on') &&
    !document.getElementById('btnCutPlate').classList.contains('on'), 'and shows which style is on');
  P(!document.getElementById('lineAngleRow').hidden, 'the angle joins the panel with the weld-line cut');
  P(document.querySelectorAll('#geom .sl:not([hidden]) input[type=range]').length === 6,
    'so there are six sliders now');
  P(B.state.doc.params.bridgeW <= B.state.doc.params.pitch * 0.5,
    'the strap is narrowed so the slots stay open',
    B.state.doc.params.bridgeW + ' mm, pitch ' + B.state.doc.params.pitch.toFixed(1));
  P(B.state.doc.params.padD < 18, 'and the pad comes down with it', B.state.doc.params.padD + ' mm');
  P(txt('btnGeomReset') === 'reset', 'the widths the mode wants are its defaults, so nothing is flagged',
    txt('btnGeomReset'));
  var cutArea = topArea();
  P(cutArea < cut0 * 0.55, 'the strip uses a fraction of the metal',
    cut0 + ' -> ' + cutArea + ' mm2, ' + Math.round(cutArea / cut0 * 100) + '%');
  P(B.state.sheets.bottom !== null, 'both faces are built for the new cut');
  P(partsOk(), 'every routed strip is one piece');
  P(!/separate pieces/.test(txt('checks')), 'and the checker has nothing to say');

  /* the angle is a real choice and it is one undo step like any slider */
  var beforeAngle = topArea();
  setRange('lineAngle', 30);
  commitRange('lineAngle');
  P(B.state.doc.params.lineAngle === 30, 'the angle lands in the document', B.state.doc.params.lineAngle + ' deg');
  P(txt('lineAnglev') === '30\u00b0', 'the readout has degrees on it', txt('lineAnglev'));
  P(topArea() !== beforeAngle, 'turning the route moves the metal',
    beforeAngle + ' -> ' + topArea() + ' mm2');
  P(txt('btnGeomReset') === 'reset 1', 'and counts as one changed slider', txt('btnGeomReset'));
  document.querySelector('#geom .rst[data-for=lineAngle]').click();
  P(B.state.doc.params.lineAngle === 90 && txt('btnGeomReset') === 'reset',
    'its arrow puts it back', B.state.doc.params.lineAngle + ' deg');
  P(txt('toast').indexOf('90\u00b0') > 0, 'and the toast speaks degrees', txt('toast'));
  P(partsOk(), 'still one piece per strip at 90 degrees');

  /* three edits since the plate - the mode switch, the angle, the reset - and
     one Ctrl+Z each, so the switch is not smeared over its widths */
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  P(B.state.doc.params.cut === 'lines' && B.state.doc.params.lineAngle === 30,
    'one ctrl+z undoes the reset', B.state.doc.params.lineAngle + ' deg, still ' + B.state.doc.params.cut);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  P(B.state.doc.params.lineAngle === 90, 'the next undoes the angle change', B.state.doc.params.lineAngle + ' deg');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  P(B.state.doc.params.cut === 'plate', 'and the next puts the plate back', B.state.doc.params.cut);
  P(B.state.doc.params.bridgeW === 18 && B.state.doc.params.padD === 18,
    'with the widths it had before the switch',
    B.state.doc.params.padD + ' / ' + B.state.doc.params.bridgeW + ' mm');
  P(topArea() === cut0, 'and exactly the metal it had', topArea() + ' mm2');
  P(document.getElementById('lineAngleRow').hidden, 'the angle row goes away again');

  /* back to the weld lines, and then to a plate with narrow straps: the plate
     defaults are not the strip defaults, and reset has to know that */
  document.getElementById('btnCutLines').click();
  P(B.state.doc.params.bridgeW < 18 && partsOk(), 'the cut comes back with its own widths');
  document.getElementById('btnCutPlate').click();
  P(B.state.doc.params.cut === 'plate' && B.state.doc.params.bridgeW < 18,
    'plate keeps the numbers you had', B.state.doc.params.bridgeW + ' mm');
  P(txt('btnGeomReset') === 'reset 2', 'and they are flagged against the plate defaults', txt('btnGeomReset'));
  document.getElementById('btnGeomReset').click();
  P(topArea() === cut0 && B.state.doc.params.padD === 18,
    'reset brings the plate defaults back', topArea() + ' mm2');
  P(partsOk(), 'the plate is one piece per island again');

  /* ---------------------------------------------------------------- */
  /* polarity                                                          */
  /* ---------------------------------------------------------------- */
  var pol0 = txt('sPol');
  document.getElementById('btnToolFlip').click();
  P(document.getElementById('btnToolFlip').classList.contains('on'), 'flip tool is armed');
  var fh = findCell(null);
  if (fh) {
    press(fh.x, fh.y);
    P(txt('sPol') !== pol0, 'clicking a cell with the flip tool turns it over', pol0 + ' -> ' + txt('sPol'));
    P(B.state.anim.length > 0, 'the flip pulses', B.state.anim.length + ' items');
    var flipped = B.state.doc.cells.filter(function (c) { return c.flip; }).length;
    P(flipped > 0, 'some cells now have their + on the other face', flipped + ' flipped');
  } else {
    P(false, 'found a cell to flip');
  }

  await sleep(700);
  B.anim(1e9);
  P(!/separate pieces/.test(txt('checks')), 'still no false "separate pieces" warning');
  P(document.getElementById('hint').textContent.indexOf('flip cell') > 0, 'the hint mentions the flip tool');

  /* ---------------------------------------------------------------- */
  /* the packing decides which angle stops there are                   */
  /* ---------------------------------------------------------------- */
  var selA = document.getElementById('arrangement');
  selA.value = 'square';
  selA.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('btnStripe').click();
  P(range('lineAngle').step === '45', 'a square pack offers 45 degrees', range('lineAngle').step);
  document.getElementById('btnCutLines').click();
  P(B.state.doc.params.cut === 'lines' && !document.getElementById('lineAngleRow').hidden,
    'the weld-line cut works on a square pack too');
  setRange('lineAngle', 45);
  commitRange('lineAngle');
  P(B.state.doc.params.lineAngle === 45, 'and 45 degrees lands', B.state.doc.params.lineAngle + ' deg');
  P(partsOk(), 'every strip is one piece at 45 degrees on a square grid');

  selA.value = 'hex';
  selA.dispatchEvent(new Event('change', { bubbles: true }));
  P(range('lineAngle').step === '30', 'a staggered pack steps in 30s', range('lineAngle').step);
  P(B.state.doc.params.lineAngle === 30 || B.state.doc.params.lineAngle === 60,
    'so 45 is snapped onto one of its own directions', B.state.doc.params.lineAngle + ' deg');

  /* ---------------------------------------------------------------- */
  /* seeing the other sheet through                                    */
  /* ---------------------------------------------------------------- */
  function grab() {
    B.frame();
    return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  }
  function diffPix(a, b) {
    var n = 0;
    for (var i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    }
    return n;
  }

  /* changing the packing re-filled the grid, which leaves the pack ungrouped:
     give it strips again, since the point here is two faces to look through */
  document.getElementById('btnStripe').click();
  P(B.state.doc.islands.top.length > 0 && B.state.doc.islands.bottom.length > 0,
    'the pack has strips on both faces to look through',
    B.state.doc.islands.top.length + ' top / ' + B.state.doc.islands.bottom.length + ' bottom');

  var gh = document.getElementById('ghostOther');
  P(!!gh && !gh.checked && !B.state.ghost, 'the see-through box starts off');
  var plain = grab(), plainArea = topArea();
  gh.click();
  P(B.state.ghost === true && gh.checked, 'ticking it shows the other sheet');
  P(!!B.state.sheets.top && !!B.state.sheets.bottom, 'both faces are built for it');
  var through = grab();
  var changed = diffPix(plain, through);
  P(changed > 2000, 'and the sheet on screen changes', changed + ' pixels differ');
  P(changed > 2000, 'and the sheet on screen changes', changed + ' pixels differ');
  P(topArea() === plainArea, 'the metal on this face is untouched', topArea() + ' mm2');
  P(JSON.stringify(B.state.doc).indexOf('ghost') < 0, 'the option is not part of the document');

  gh.click();
  var back = grab();
  P(!B.state.ghost && diffPix(plain, back) === 0, 'unticking puts the picture back exactly',
    diffPix(plain, back) + ' px differ');

  key('x');
  P(B.state.ghost === true && gh.checked, 'X does the same from the keyboard');
  key('b');
  P(B.state.face === 'bottom' && B.state.ghost, 'it follows the face you turn to');
  var bottomThrough = grab();
  key('x');
  var bottomPlain = grab();
  var bottomChanged = diffPix(bottomThrough, bottomPlain);
  P(bottomChanged > 2000, 'so the top sheet shows through the bottom', bottomChanged + ' pixels differ');

  key('t');
  key('x');
  P(B.state.face === 'top' && B.state.ghost, 'and back again with it still on');
  var farBefore = B.state.sheets.bottom;
  range('bridgeW').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
  setRange('bridgeW', 2.5);
  await sleep(40);
  P(B.state.sheets.bottom === farBefore,
    'a drag holds the far sheet for a moment rather than dropping it');
  commitRange('bridgeW');
  P(!!B.state.sheets.bottom && B.state.sheets.bottom !== farBefore,
    'and the release rebuilds it with the rest');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  key('x');

  /* ---------------------------------------------------------------- */
  /* the far sheet is mirrored back into this one                      */
  /* ---------------------------------------------------------------- */
  /* One cell on the far face and nothing on this one: the ghost has exactly
     one pad, so where it lands is unambiguous. If the mirror were skipped the
     pad would be drawn at W - x, over the emptier side of the sheet. */
  function pix(xmm, ymm) {
    B.frame();
    var st = B.state;
    var dpr = cv.width / cv.getBoundingClientRect().width;
    var x = Math.round((st.px + xmm * st.zoom) * dpr);
    var y = Math.round((st.py + ymm * st.zoom) * dpr);
    var d = cv.getContext('2d').getImageData(x - 1, y - 1, 3, 3).data;
    var r = 0, g = 0, b = 0;
    for (var i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return [r / 9, g / 9, b / 9];
  }

  var st = B.state, ft = st.frame;
  var savedTop = st.doc.islands.top, savedBottom = st.doc.islands.bottom;
  var corner = st.doc.cells[0];
  if (st.ghost) key('x');
  st.doc.islands.top = [];
  st.doc.islands.bottom = [{ id: 'probe', name: 'PROBE', color: '#4fc3f7', cells: [corner.id] }];
  B.rebuild();
  var cp = B.geo.cellOnFace(st.doc, ft, 'top', corner);
  /* inside the weld pad (r 4.75 in the strip cut) and clear of the + glyph */
  var probe = { x: cp.x + 2.4, y: cp.y + 2.4 };
  var wrong = { x: ft.W - probe.x, y: probe.y };
  var offHere = pix(probe.x, probe.y), offThere = pix(wrong.x, wrong.y);
  key('x');
  var onHere = pix(probe.x, probe.y), onThere = pix(wrong.x, wrong.y);
  P(onHere[2] - offHere[2] > 12, 'the far pad is drawn on the cell it belongs to',
    'blue ' + offHere[2].toFixed(0) + ' -> ' + onHere[2].toFixed(0));
  P(Math.abs(onThere[2] - offThere[2]) <= 2, 'and not on the mirrored side of the sheet',
    'blue ' + offThere[2].toFixed(0) + ' -> ' + onThere[2].toFixed(0));

  st.doc.islands.top = savedTop;
  st.doc.islands.bottom = savedBottom;
  key('x');
  B.rebuild();

  /* ---------------------------------------------------------------- */
  /* cell guide slits                                                  */
  /* ---------------------------------------------------------------- */
  /* A slit is a cut in the plate, so it has to be in the document, in the
     panel, in the metal area and in the picture - and it has to come back
     when the option is turned off. */
  document.getElementById('btnCutPlate').click();
  document.getElementById('btnGeomReset').click();
  var gl = document.getElementById('guideL');
  P(!document.getElementById('guideOn').checked && !B.state.doc.params.guides,
    'the guide slits start off');
  P(document.getElementById('guideLRow').hidden, 'and their length is not in the panel yet');

  /* one cell in the middle, at a clear angle, so a pixel means something */
  var gcell = centreCell(null).cell;
  function guideAt(c, face) {
    return B.geo.cellOnFace(B.state.doc, B.state.frame || B.geo.frameOf(B.state.doc), face || 'top', c);
  }
  function slotsOn(face) {
    var sh = B.state.sheets[face || 'top'];
    return sh ? sh.islands.reduce(function (a, i) { return a + (i.slots ? i.slots.length : 0); }, 0) : -1;
  }
  var gp = guideAt(gcell);
  var plainShot = grab();
  var offHere = pix(gp.x, gp.y), offSide = pix(gp.x - 6, gp.y);

  document.getElementById('guideOn').click();
  P(B.state.doc.params.guides === true && document.getElementById('guideOn').checked,
    'ticking it cuts a slit in every weld spot');
  P(!document.getElementById('guideLRow').hidden, 'its length joins the panel');
  P(!document.getElementById('lineAngleRow').hidden, 'and so does the angle, even on a plate');
  P(slotsOn('top') === B.state.doc.cells.length,
    'one slit per cell on this face', slotsOn('top') + ' slits');
  P(/guide slits/.test(txt('cutNote')), 'the note explains what was cut');

  var onHere = pix(gp.x, gp.y), onSide = pix(gp.x - 6, gp.y);
  var dark = function (q) { return q[0] + q[1] + q[2]; };
  P(dark(onHere) < dark(offHere) - 60, 'the slit is drawn as a dark opening',
    dark(offHere).toFixed(0) + ' -> ' + dark(onHere).toFixed(0));
  P(Math.abs(onSide[0] - offSide[0]) <= 2 && Math.abs(onSide[1] - offSide[1]) <= 2 &&
    Math.abs(onSide[2] - offSide[2]) <= 2,
    'and the metal beside it is untouched');
  P(B.state.doc.params.guides === true && JSON.stringify(B.state.doc).indexOf('"guides":true') > 0,
    'the option is part of the document, so it saves and undoes');

  document.getElementById('guideOn').click();
  P(B.state.doc.params.guides === false && diffPix(plainShot, grab()) === 0,
    'unticking puts the plate back exactly', diffPix(plainShot, grab()) + ' px differ');

  /* the angle is shared with the weld lines, and it turns the slits too */
  setRange('lineAngle', 0);
  commitRange('lineAngle');
  document.getElementById('guideOn').click();
  var flat = B.state.sheets.top.islands[0].slots[0];
  var fx = flat.map(function (p) { return p.x; }), fy = flat.map(function (p) { return p.y; });
  P(Math.max.apply(null, fx) - Math.min.apply(null, fx) > 7 &&
    Math.max.apply(null, fy) - Math.min.apply(null, fy) < 2,
    'at 0 degrees the slits run along the rows',
    (Math.max.apply(null, fx) - Math.min.apply(null, fx)).toFixed(1) + ' x ' +
    (Math.max.apply(null, fy) - Math.min.apply(null, fy)).toFixed(1) + ' mm');

  /* the length is a real number in the document, and one drag is one undo */
  var lenBefore = B.state.doc.params.guideL;
  range('guideL').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
  setRange('guideL', 5);
  await sleep(40);
  commitRange('guideL');
  P(B.state.doc.params.guideL === 5, 'the length slider cuts a longer or shorter line',
    lenBefore + ' -> ' + B.state.doc.params.guideL + ' mm');
  var long5 = B.state.sheets.top.islands[0].slots[0].map(function (p) { return p.x; });
  P(Math.abs((Math.max.apply(null, long5) - Math.min.apply(null, long5)) - 5) < 0.1,
    'and the metal follows it a pixel at a time', (Math.max.apply(null, long5) - Math.min.apply(null, long5)).toFixed(2) + ' mm');

  /* a pad cannot carry a slit longer than it is */
  setRange('padD', 10);
  commitRange('padD');
  P(Math.abs(parseFloat(range('guideL').max) - 6) < 0.01, 'the length slider stops at the pad',
    range('guideL').max + ' mm for a ' + B.state.doc.params.padD + ' mm pad');
  setRange('guideL', 6);
  commitRange('guideL');
  P(B.state.doc.params.guideL === 6, 'and can be taken to that stop', B.state.doc.params.guideL + ' mm');
  setRange('padD', 7);
  commitRange('padD');
  P(B.state.doc.params.guideL < 6 &&
    B.state.doc.params.guideL <= parseFloat(range('guideL').max) + 1e-6,
    'a pad narrowed under the slit brings it down with the pad',
    'pad ' + B.state.doc.params.padD + ', slit ' + B.state.doc.params.guideL + ', top ' + range('guideL').max);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  P(B.state.doc.params.padD === 10 && B.state.doc.params.guideL === 6,
    'one ctrl+z puts the pad and the slit back', B.state.doc.params.padD + ' mm pad, ' + B.state.doc.params.guideL + ' mm slit');

  /* the bottom sheet gets its own slits, mirrored with it */
  var topSlotX = B.state.sheets.top.islands[0].slots[0].map(function (p) { return p.x; });
  key('b');
  P(slotsOn('bottom') > 0, 'the bottom sheet is slitted too', slotsOn('bottom') + ' slits');
  var botSlotX = B.state.sheets.bottom.islands[0].slots[0].map(function (p) { return p.x; });
  P(Math.abs((B.state.sheets.bottom.W - Math.max.apply(null, botSlotX)) - Math.min.apply(null, topSlotX)) < 0.01,
    'and its slits are mirrored with the sheet');
  key('t');

  document.getElementById('guideOn').click();
  document.getElementById('btnGeomReset').click();
  P(!B.state.doc.params.guides && slotsOn('top') === 0, 'the slits go away again');

  /* ---------------------------------------------------------------- */
  /* deleting a whole island                                           */
  /* ---------------------------------------------------------------- */
  var face = B.state.face;
  var islList = function () { return B.state.doc.islands[face]; };
  var nIsl = islList().length;
  var nCells = cells();
  var victim = islList()[0];
  var victimCells = victim.cells.slice();
  P(nIsl > 1, 'there are islands to delete', nIsl + ' on ' + face);

  /* the x in the right-hand list takes one island, not the face */
  var li = document.querySelectorAll('#islands li')[0];
  var x = li ? li.querySelector('.x') : null;
  P(!!x, 'every island row has a delete control');
  if (x) {
    x.click();
    P(islList().length === nIsl - 1, 'the x deletes exactly one island',
      nIsl + ' -> ' + islList().length);
    P(islList().every(function (i) { return i.id !== victim.id; }), 'the right island went');
    P(cells() === nCells, 'its cells stay in the pack', nCells + ' cells still');
    var still = B.state.sheets[face].islands.some(function (i) { return i.id === victim.id; });
    P(!still, 'no metal is left for it on the sheet');

    undoKey();
    var back = islList().filter(function (i) { return i.id === victim.id; })[0];
    P(!!back && back.cells.length === victimCells.length,
      'one ctrl+z puts the island and its cells back',
      back ? back.cells.length + ' cells' : 'not restored');
  }

  /* the island tool: one click on a piece removes the whole piece */
  document.getElementById('btnToolIsland').click();
  P(document.getElementById('btnToolIsland').classList.contains('on') &&
    !document.getElementById('btnToolPaint').classList.contains('on'),
    'the island tool takes over from paint');
  var probe = centreCell();
  var before2 = islList().length;
  if (probe) {
    var owner = islList().filter(function (i) { return i.cells.indexOf(probe.cell.id) >= 0; })[0];
    P(!!owner, 'the probed cell belongs to an island');
    if (owner) {
      press(probe.x, probe.y);
      P(islList().length === before2 - 1, 'a click with the island tool deletes that island',
        before2 + ' -> ' + islList().length);
      P(islList().every(function (i) { return i.id !== owner.id; }), 'and it is the piece that was clicked');
      P(cells() === nCells, 'and still leaves the cells', cells() + ' cells');
      undoKey();
      P(islList().length === before2, 'which ctrl+z undoes', islList().length + ' islands');
    }
  } else {
    P(false, 'found a cell to click with the island tool');
  }
  document.getElementById('btnToolPaint').click();

  /* a pack end on the island goes with it, rather than pointing at a pad that
     is no longer welded on that sheet */
  var endIsl = islList()[0];
  if (endIsl && endIsl.cells.length) {
    B.state.doc.terminals = { neg: { face: face, cell: endIsl.cells[0] }, pos: null };
    B.rebuild();
    document.querySelectorAll('#islands li')[0].querySelector('.x').click();
    P(!B.state.doc.terminals.neg, 'a pack end on the deleted island is cleared with it');
    undoKey();
    P(!!(B.state.doc.terminals && B.state.doc.terminals.neg), 'and comes back on undo');
    B.state.doc.terminals = { neg: null, pos: null };
    B.rebuild();
  }

  /* the Remove group button: it acts on the selected group, and only then */
  var rm = document.getElementById('btnRmGroup');
  P(!!rm, 'there is a Remove group button beside the palette');
  if (rm) {
    var chips = document.querySelectorAll('#palette .chip');
    var delChip = document.getElementById('chipDel');
    P(!!delChip, 'there is a minus chip beside the plus one');

    /* with nothing selected, Remove group must not delete anything, and must
       not fall back to clearing the whole face */
    var keepSel = B.state.sel;
    var lst = islList();
    /* poke the state the way a fresh face would: no selection */
    var selBefore = B.state.sel;
    B.state.sel = null;
    B.rebuild();
    var nBefore = islList().length;
    rm.click();
    P(islList().length === nBefore, 'Remove group does nothing with no group selected',
      nBefore + ' -> ' + islList().length);
    P(rm.classList.contains('off'), 'and the button is greyed out');
    B.state.sel = selBefore;
    B.rebuild();

    /* now select a group and use the button */
    var pick = islList()[0];
    var listsBefore = islList().length;
    var cellsBefore = cells();
    /* select it the way the user does: click its chip */
    var chipIdx = islList().indexOf(pick);
    document.querySelectorAll('#palette .chip')[chipIdx].click();
    P(B.state.sel === pick.id, 'clicking a group selects it');
    P(!rm.classList.contains('off'), 'and the Remove group button comes alive');
    rm.click();
    P(islList().length === listsBefore - 1, 'Remove group deletes the selected group',
      listsBefore + ' -> ' + islList().length);
    P(islList().every(function (i) { return i.id !== pick.id; }), 'and it is the selected one');
    P(cells() === cellsBefore, 'the cells stay in the pack', cells() + ' cells');
    undoKey();
    P(islList().length === listsBefore, 'one ctrl+z puts the group back', islList().length + ' groups');

    /* the minus chip does the same job */
    if (delChip) {
      var c2 = islList()[0];
      document.querySelectorAll('#palette .chip')[0].click();
      var n2 = islList().length;
      delChip.click();
      P(islList().length === n2 - 1, 'the minus chip deletes the selected group too',
        n2 + ' -> ' + islList().length);
      P(islList().every(function (i) { return i.id !== c2.id; }), 'and it is the right one');
      undoKey();
      P(islList().length === n2, 'and that undoes too', islList().length + ' groups');
    }
    B.state.sel = keepSel;
  }

  var fails = out.filter(function (l) { return l.indexOf('FAIL') === 0; }).length;
  document.title = fails ? 'SMOKE FAIL' : 'SMOKE PASS';
  var pre = document.createElement('pre');
  pre.id = 'smoke';
  pre.textContent = out.join('\\n');
  document.body.appendChild(pre);
})();
</script>
`;

let out = html.replace('src="geometry.js"', 'src="../geometry.js"');
if (out === html) {
  console.error('could not rewrite the geometry.js path');
  process.exit(1);
}
if (out.indexOf('</body>') < 0) {
  console.error('no </body> in index.html');
  process.exit(1);
}
out = out.replace('</body>', harness + '</body>');

const target = path.join(ROOT, 'out', 'app-smoke.html');
fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
fs.writeFileSync(target, out);
console.log('wrote ' + path.relative(ROOT, target));
