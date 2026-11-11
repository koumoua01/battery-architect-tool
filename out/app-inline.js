
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var G = window.BAGeo;
  var cv = $('cv');
  var ctx = cv.getContext('2d');
  var mini = $('mini');
  var mctx = mini ? mini.getContext('2d') : null;
  var miniDrag = null;

  var PALETTE = ['#4fc3f7', '#aed581', '#ffb74d', '#ba68c8', '#4db6ac', '#e57373',
                 '#fff176', '#9575cd', '#f06292', '#90a4ae', '#a1887f', '#7986cb'];

  var S = {
    doc: null,
    face: 'top',
    ghost: false,
    sel: null,
    hover: null,
    tool: 'paint',
    pick: new Set(),
    pickBase: null,
    marquee: null,
    zoom: 3,
    px: 0, py: 0,
    vw: 1, vh: 1,
    frame: null,
    sheets: { top: null, bottom: null },
    cache: { top: new Map(), bottom: new Map() },
    drc: [],
    buildMs: 0,
    flowOn: true,
    flowMode: 'islands',
    flowPath: null,
    flowPlan: null,
    flowPlanFor: null,
    flowPlanFace: null,
    flowPlanStart: 0,
    terminalPick: null,
    flowLast: 0,
    dragging: false,
    pan: null,
    paintMode: null,
    wet: null,
    dirty: true,
    anim: [],
    hiRow: null,
    strokeBefore: null,
    strokeFrame: null,
    animAnchor: null,
    hiIsland: null,
    theme: 'midnight',
    grid: true,
    mini: true,
    leftOpen: true,
    rightOpen: true,
    zoomAnim: null,
    selPulse: 0,
    cmd: { open: false, index: 0, items: [] },
    unsaved: true
  };

  /* people who ask their system to tone motion down get the final picture
     straight away - the build is fast enough that nothing is lost */
  var REDUCED = false;
  try {
    REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { }
  var ANIM_GROW = 240, ANIM_SHRINK = 210;

  /* ------------------------------------------------------------------ */
  /* theme                                                               */
  /*
   * The panel colours live in CSS custom properties, but the sheet is a
   * canvas: its paper, its grid, its cell rings and the current path are
   * painted numbers, so they need the same palette in JavaScript. Both
   * halves come from here, and a theme switch is one repaint.
   */
  /* ------------------------------------------------------------------ */

  var THEMES = {
    midnight: {
      name: 'Midnight',
      canvas: '#101318', sheet: '#181d24', sheetLine: '#3a4451',
      grid: 'rgba(255,255,255,0.047)', rowBand: 'rgba(255,255,255,0.07)', rowLine: 'rgba(255,255,255,0.157)',
      cell: '#5b6675', cellHot: '#ffffff', pick: '#ff6f6f',
      plus: '#e2837f', minus: '#7fb2e2', label: '#77828f', subLabel: '#8fb6d6',
      slit: '#0a0d12', slitEdge: 0.32, accent: '#4fc3f7',
      flow: '#ff5a5a', flowGlow: 'rgba(255,86,86,0.20)',
      endNeg: '#5aa9ff', endPos: '#ff6b6b',
      animAdd: '#ffffff', animDel: '#ff9d6b', animFlip: '#9ee6ff',
      fillA: 0.22, fillSelA: 0.42, ghostFillA: 0.18, ghostLineA: 0.95
    },
    day: {
      name: 'Daylight',
      canvas: '#e9eef5', sheet: '#ffffff', sheetLine: '#bcc9d8',
      grid: 'rgba(24,48,72,0.06)', rowBand: 'rgba(11,127,168,0.07)', rowLine: 'rgba(11,127,168,0.16)',
      cell: '#93a4b6', cellHot: '#0b7fa8', pick: '#c33b3b',
      plus: '#b85b57', minus: '#4f80b5', label: '#64798f', subLabel: '#4b7da3',
      slit: '#b3c2d2', slitEdge: 0.5, accent: '#0b7fa8',
      flow: '#d63c3c', flowGlow: 'rgba(214,60,60,0.18)',
      endNeg: '#1f77c8', endPos: '#d63c3c',
      animAdd: '#0b7fa8', animDel: '#c4562b', animFlip: '#0b7fa8',
      fillA: 0.26, fillSelA: 0.46, ghostFillA: 0.16, ghostLineA: 0.9
    }
  };
  var TH = THEMES.midnight;

  function applyTheme(name, announce) {
    name = THEMES[name] ? name : 'midnight';
    S.theme = name;
    TH = THEMES[name];
    document.documentElement.setAttribute('data-theme', name === 'day' ? 'day' : 'midnight');
    var btn = $('btnTheme');
    if (btn) {
      btn.classList.toggle('on', name === 'day');
      btn.title = name === 'day'
        ? 'Switch to the midnight theme'
        : 'Switch to the daylight theme';
      btn.setAttribute('aria-pressed', name === 'day' ? 'true' : 'false');
    }
    S.dirty = true;
    var stage = $('stage');
    if (stage && !REDUCED) {
      stage.classList.remove('theme-fade');
      void stage.offsetWidth;
      stage.classList.add('theme-fade');
      setTimeout(function () { stage.classList.remove('theme-fade'); }, 340);
    }
    if (announce) toast(TH.name + ' theme');
  }

  function readUi() {
    var out = {};
    try { out = JSON.parse(localStorage.getItem('battery-architect.ui') || '{}') || {}; } catch (e) { }
    return out;
  }

  function saveUi() {
    try {
      localStorage.setItem('battery-architect.ui', JSON.stringify({
        theme: S.theme, grid: S.grid, mini: S.mini,
        leftOpen: S.leftOpen, rightOpen: S.rightOpen,
        flowMode: S.flowMode
      }));
    } catch (e) { }
  }

  /* ------------------------------------------------------------------ */
  /* document                                                            */
  /* ------------------------------------------------------------------ */

  function defaultDoc() {
    var doc = {
      version: 1,
      name: 'my pack',
      cellType: '21700',
      arrangement: 'hex',
      cells: [],
      islands: { top: [], bottom: [] },
      params: {
        cellD: 21.2, gap: 0.6, pitch: 21.8, padD: 18, bridgeW: 18,
        kerf: 0.1, margin: 8, step: 0.1,
        cut: 'plate', lineAngle: 90, guides: false, guideL: 8
      }
    };
    fillGrid(doc, 13, 8);
    return doc;
  }

  function fillGrid(doc, rows, cols) {
    var p = doc.params;
    p.pitch = p.cellD + p.gap;
    var hex = doc.arrangement !== 'square';
    var rowH = hex ? p.pitch * Math.sqrt(3) / 2 : p.pitch;
    var cells = [];
    var n = 0;
    for (var r = 0; r < rows; r++) {
      var odd = hex && (r % 2 === 1);
      var cnt = odd ? Math.max(1, cols - 1) : cols;
      var xo = odd ? p.pitch / 2 : 0;
      for (var c = 0; c < cnt; c++) {
        cells.push({ id: 'c' + (n++), x: c * p.pitch + xo, y: r * rowH, flip: false });
      }
    }
    doc.cells = cells;
    /* keep the quarter turn: "fill grid" must reproduce what is on screen */
    var turns = Math.round((((doc.rot || 0) % 360 + 360) % 360) / 90) % 4;
    for (var t = 0; t < turns; t++) G.rotateCells(cells, true);
    doc.islands = { top: [], bottom: [] };
  }

  function rowsOf(doc) {
    var ys = {};
    for (var i = 0; i < doc.cells.length; i++) ys[Math.round(doc.cells[i].y * 100)] = doc.cells[i].y;
    var list = Object.keys(ys).map(function (k) { return ys[k]; });
    list.sort(function (a, b) { return a - b; });
    return list;
  }

  function cellsInRows(doc, ys, from, count) {
    var lo = ys[from], hi = ys[Math.min(ys.length - 1, from + count - 1)];
    return doc.cells.filter(function (c) { return c.y >= lo - 0.01 && c.y <= hi + 0.01; }).map(function (c) { return c.id; });
  }

  /* Cells are grouped into rows by their y. Nothing stores a row number, so
     this is the only definition of a row there is - which is also why adding
     or removing a cell can never leave a stale row index behind. */
  function rowTol() { return Math.max(2, S.doc.params.pitch * 0.45); }

  function cellsInRow(y) {
    var tol = rowTol();
    return S.doc.cells
      .filter(function (c) { return Math.abs(c.y - y) <= tol; })
      .sort(function (a, b) { return a.x - b.x; });
  }

  function nextCellId() {
    var n = 0;
    for (var i = 0; i < S.doc.cells.length; i++) {
      var m = /^c(\d+)$/.exec(S.doc.cells[i].id);
      if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
    }
    return 'c' + n;
  }

  /* A new cell must not be left dangling: on each face it joins whichever
     island owns the nearest existing cell. That keeps "every terminal is
     connected" true without the user having to paint it twice. */
  function attachNearest(cell) {
    ['top', 'bottom'].forEach(function (face) {
      var best = null, bd = Infinity;
      var list = S.doc.islands[face];
      for (var i = 0; i < list.length; i++) {
        for (var k = 0; k < list[i].cells.length; k++) {
          var c = findCell(list[i].cells[k]);
          if (!c) continue;
          var dx = c.x - cell.x, dy = c.y - cell.y;
          var d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = list[i]; }
        }
      }
      if (best) best.cells.push(cell.id);
    });
  }

  function addCellToRow(y, atLeft) {
    var row = cellsInRow(y);
    if (!row.length) return null;
    var p = S.doc.params;
    var ref = atLeft ? row[0] : row[row.length - 1];
    var cell = {
      id: nextCellId(),
      x: r4(atLeft ? ref.x - p.pitch : ref.x + p.pitch),
      y: ref.y,
      flip: !!ref.flip
    };
    S.doc.cells.push(cell);
    attachNearest(cell);
    return cell;
  }

  function removeCellFromRow(y, atLeft) {
    var row = cellsInRow(y);
    if (!row.length) return null;
    var victim = atLeft ? row[0] : row[row.length - 1];
    var label = cellIndex(victim.id) + 1;
    return deleteCell(victim.id) ? label : null;
  }

  /* a whole new row at the bottom, staggered like the one above it */
  function addRow() {
    var rows = rowsOf(S.doc);
    var p = S.doc.params;
    var hex = S.doc.arrangement !== 'square';
    var rowH = hex ? p.pitch * Math.sqrt(3) / 2 : p.pitch;
    var y = rows.length ? rows[rows.length - 1] + rowH : 0;
    var last = rows.length ? cellsInRow(rows[rows.length - 1]) : [];
    if (!last.length) return;
    var stagger = hex && (last[0].x > 1) ? 0 : (hex ? p.pitch / 2 : 0);
    if (!hex) stagger = 0;
    var added = [];
    for (var i = 0; i < last.length; i++) {
      var cell = {
        id: nextCellId(),
        x: r4(last[i].x + stagger),
        y: r4(y),
        flip: !!last[i].flip
      };
      S.doc.cells.push(cell);
      added.push(cell);
    }
    added.forEach(attachNearest);
  }

  function delRow() {
    var rows = rowsOf(S.doc);
    if (!rows.length) return 0;
    var row = cellsInRow(rows[rows.length - 1]);
    row.forEach(function (c) { deleteCell(c.id); });
    return row.length;
  }

  function r4(v) { return Math.round(v * 1e4) / 1e4; }

  function renderRows() {
    var ul = $('rowsList');
    if (!ul) return;
    var ys = rowsOf(S.doc);
    var tol = rowTol();
    ul.innerHTML = '';
    ys.forEach(function (y, i) {
      var row = cellsInRow(y);
      var li = document.createElement('li');
      if (S.hiRow !== null && Math.abs(S.hiRow - y) <= tol) li.className = 'hot';
      li.innerHTML = '<span class="rl">' + (i + 1) + '</span>' +
                     '<span class="rc">' + row.length + ' cell' + (row.length === 1 ? '' : 's') + '</span>' +
                     '<button class="rb" title="remove the last cell of this row (&minus;)">&#8722;</button>' +
                     '<button class="rb" title="add a cell to this row (+)">&#43;</button>';
      var btns = li.querySelectorAll('.rb');
      btns[0].onclick = function (ev) { rowStep(y, ev.shiftKey, 'del'); };
      btns[1].onclick = function (ev) { rowStep(y, ev.shiftKey, 'add'); };
      li.onmouseenter = function () { S.hiRow = y; S.dirty = true; li.classList.add('hot'); };
      li.onmouseleave = function () { S.hiRow = null; S.dirty = true; li.classList.remove('hot'); };
      ul.appendChild(li);
    });
  }

  function rowStep(y, atLeft, what) {
    var n0 = S.doc.cells.length;
    var before = REDUCED ? null : snapPrims(['top', 'bottom']);
    var f0 = frameSig();
    var msg;
    snapshot();
    if (what === 'add') {
      var cell = addCellToRow(y, atLeft);
      if (!cell) { toast('That row is gone'); return; }
      msg = (S.doc.cells.length - n0) + ' cell added at the ' + (atLeft ? 'left' : 'right') +
            ' - ' + S.doc.cells.length + ' in the pack';
    } else {
      var label = removeCellFromRow(y, atLeft);
      if (label === null) { toast('That row is empty'); return; }
      msg = 'Cell ' + label + ' removed - ' + S.doc.cells.length + ' left';
    }
    finishEdit(before, f0, msg);
  }

  function autoStripe() {
    var doc = S.doc;
    var ys = rowsOf(doc);
    var k = Math.max(1, Math.min(12, parseInt($('stripeRows').value, 10) || 2));
    var off = Math.max(1, Math.round(k / 2));
    doc.islands = { top: [], bottom: [] };
    var ci = 0;
    function add(face, from, count) {
      var ids = cellsInRows(doc, ys, from, count);
      if (!ids.length) return;
      var tag = (face === 'top' ? 't' : 'b') + doc.islands[face].length;
      doc.islands[face].push({
        id: tag,
        name: (face === 'top' ? 'TOP ' : 'BOT ') + (doc.islands[face].length + 1),
        color: PALETTE[ci++ % PALETTE.length],
        cells: ids
      });
    }
    for (var r = 0; r < ys.length; r += k) add('top', r, k);
    if (off > 0) add('bottom', 0, off);
    for (var r2 = off; r2 < ys.length; r2 += k) add('bottom', r2, k);

    /* alternate polarity band by band so each top island has one terminal
       sign on the top face; bottom islands then become series junctions */
    for (var i = 0; i < doc.islands.top.length; i++) {
      var flip = (i % 2 === 1);
      for (var j = 0; j < doc.islands.top[i].cells.length; j++) {
        var c = findCell(doc.islands.top[i].cells[j]);
        if (c) c.flip = flip;
      }
    }
    S.sel = doc.islands[S.face].length ? doc.islands[S.face][0].id : null;
  }

  function findCell(id) {
    for (var i = 0; i < S.doc.cells.length; i++) if (S.doc.cells[i].id === id) return S.doc.cells[i];
    return null;
  }

  function cellIndex(id) {
    for (var i = 0; i < S.doc.cells.length; i++) if (S.doc.cells[i].id === id) return i;
    return -1;
  }

  /* Ends are annotations on the document, so they have to survive load, undo
     and a deleted cell without ever pointing at a pad that is not there. */
  function pruneTerminals() {
    var t = S.doc.terminals;
    if (!t || typeof t !== 'object') {
      S.doc.terminals = { neg: null, pos: null };
      return;
    }
    var live = Object.create(null);
    for (var i = 0; i < S.doc.cells.length; i++) live[S.doc.cells[i].id] = 1;
    ['neg', 'pos'].forEach(function (k) {
      var e = t[k];
      if (!e || !live[e.cell] || (e.face !== 'top' && e.face !== 'bottom')) t[k] = null;
    });
    if (t.neg && t.pos && t.neg.face === t.pos.face && t.neg.cell === t.pos.cell) {
      t.neg = t.pos = null;
    }
  }

  function termFace(term) {
    return term && term.face === 'bottom' ? 'bottom' : 'top';
  }

  function termCellLabel(term) {
    var n = term ? cellIndex(term.cell) : -1;
    return n >= 0 ? String(n + 1) : '';
  }

  function faceShort(face) { return face === 'bottom' ? 'BOT' : 'TOP'; }

  function paintFlowPanel() {
    var t = S.doc.terminals || (S.doc.terminals = { neg: null, pos: null });
    var neg = t.neg, pos = t.pos;
    var negBtn = $('btnTermNeg'), posBtn = $('btnTermPos');
    negBtn.classList.toggle('on', S.terminalPick === 'neg');
    posBtn.classList.toggle('on', S.terminalPick === 'pos');
    negBtn.classList.toggle('set', !!neg);
    posBtn.classList.toggle('set', !!pos);
    $('termNegLab').textContent = neg ? faceShort(termFace(neg)) + ' ' + termCellLabel(neg) : 'end';
    $('termPosLab').textContent = pos ? faceShort(termFace(pos)) + ' ' + termCellLabel(pos) : 'end';

    var flow = S.flowPath;
    var note = $('flowNote');
    if (!neg && !pos) {
      note.innerHTML = 'Pick <b>&minus;</b> or <b>+</b>, then click a pad. The end belongs to that sheet\'s island; both ends may sit on either sheet.';
    } else if (!neg || !pos) {
      note.innerHTML = 'One end set. Pick the other one to trace the path through the cells.';
    } else if (flow && flow.ok) {
      var islands = flowIslandCount(flow);
      var how = S.flowMode === 'cells'
        ? 'The pulse follows the pad-to-pad metal route and hops between islands.'
        : 'The overlay joins island centers; switch to Cell route for the exact pad path.';
      note.innerHTML = 'Main path: <b>' + flow.cells.length + ' cell' + (flow.cells.length === 1 ? '' : 's') +
        '</b> through <b>' + islands + ' island' + (islands === 1 ? '' : 's') +
        '</b> from the &minus; end to the + end, <b>' + flow.length.toFixed(0) +
        ' mm</b> of traced route. ' + how;
    } else if (flow && flow.reason === 'open') {
      note.innerHTML = 'No directed path from the &minus; end to the + end. Check the flips between them.';
    } else if (flow && flow.reason === 'same-island') {
      note.innerHTML = 'Both ends are on the same island &mdash; there are no series cells between them.';
    } else if (flow && flow.reason === 'unowned') {
      note.innerHTML = 'An end sits on a pad that is not in an island on its sheet. Paint that cell first.';
    } else if (flow && flow.reason === 'missing') {
      note.innerHTML = 'An end points at a cell that is no longer in the pack. Pick it again.';
    } else if (flow && flow.reason === 'same-cell') {
      note.innerHTML = 'Both ends are on the same pad. Pick a different pad for one of them.';
    } else {
      note.innerHTML = 'Set both ends to trace the main current path.';
    }
  }

  function islandById(face, id) {
    var list = S.doc.islands[face];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function nextColor() {
    var used = {};
    ['top', 'bottom'].forEach(function (f) {
      S.doc.islands[f].forEach(function (i) { used[i.color] = 1; });
    });
    for (var i = 0; i < PALETTE.length; i++) if (!used[PALETTE[i]]) return PALETTE[i];
    return PALETTE[Object.keys(used).length % PALETTE.length];
  }

  function addIsland(face) {
    var list = S.doc.islands[face];
    var id = face[0] + Date.now().toString(36) + list.length;
    var isl = {
      id: id,
      name: (face === 'top' ? 'TOP ' : 'BOT ') + (list.length + 1),
      color: nextColor(),
      cells: []
    };
    list.push(isl);
    S.sel = id;
    return isl;
  }

  /* ------------------------------------------------------------------ */
  /* mutations                                                           */
  /* ------------------------------------------------------------------ */

  /* A stroke keeps the last exact sheet on screen and records which islands
     it has changed. The draw pass then hides those stale islands and draws
     their current cells as a wet preview, so every cell appears under the
     pointer without waiting for the button to come up. */
  function wetMark(id) {
    if (!S.wet || !id) return;
    S.wet.changed[id] = 1;
    S.wet.gen++;
  }

  function wetCell(cellId, kind) {
    if (!S.wet) return;
    S.wet.trail.push({ id: cellId, kind: kind || 'paint' });
    if (S.wet.trail.length > 260) S.wet.trail.shift();
  }

  function detach(face, cellId) {
    var list = S.doc.islands[face];
    var hit = false;
    for (var i = 0; i < list.length; i++) {
      var idx = list[i].cells.indexOf(cellId);
      if (idx >= 0) {
        list[i].cells.splice(idx, 1);
        wetMark(list[i].id);
        hit = true;
      }
    }
    return hit;
  }

  function paint(cellId) {
    var isl = S.sel ? islandById(S.face, S.sel) : null;
    if (!isl) isl = addIsland(S.face);
    /* dragging back over a cell already in this island is not a new edit:
       without this, every pointer move would invalidate the same preview */
    if (isl.cells.indexOf(cellId) >= 0) return;
    detach(S.face, cellId);
    isl.cells.push(cellId);
    wetMark(isl.id);
    wetCell(cellId, 'paint');
  }

  function erase(cellId) {
    if (detach(S.face, cellId)) wetCell(cellId, 'erase');
  }

  function paintRow(cellId) {
    var ref = findCell(cellId);
    if (!ref) return;
    var tol = Math.max(2, S.doc.params.pitch * 0.45);
    for (var i = 0; i < S.doc.cells.length; i++) {
      var c = S.doc.cells[i];
      if (Math.abs(c.y - ref.y) <= tol) paint(c.id);
    }
  }

  function invalidate(face) {
    S.sheets[face] = null;
    S.dirty = true;
  }

  /* ------------------------------------------------------------------ */
  /* animation                                                           */
  /*
   * An edit does not just swap one outline for another: the straps that
   * reach the touched cell appear, and when a cell goes they retract. Both
   * are found by diffing the island's primitive list before and after the
   * edit - the same list the geometry is built from - so what is drawn is
   * exactly what changed, and a strap that merely moved a hair is not
   * animated.
   */
  /* ------------------------------------------------------------------ */

  /* the sheet's place on the paper; adding a cell at the end of a row moves
     every coordinate on the sheet, and an animation across that jump would
     be a lie */
  function frameSig() {
    var f = G.frameOf(S.doc);
    return f.ox + ',' + f.oy + ',' + f.W + ',' + f.H;
  }

  function islandPts(face, isl) {
    var f = S.frame || (S.frame = G.frameOf(S.doc));
    var pts = [];
    for (var i = 0; i < isl.cells.length; i++) {
      var c = findCell(isl.cells[i]);
      if (c) pts.push(G.cellOnFace(S.doc, f, face, c));
    }
    return pts;
  }

  function primKey(q) {
    var a = q.x1.toFixed(2) + ',' + q.y1.toFixed(2);
    var b = q.x2.toFixed(2) + ',' + q.y2.toFixed(2);
    return (q.inv ? 's' : 'p') + (a < b ? a + '|' + b : b + '|' + a);
  }

  function snapPrims(faces) {
    var out = {};
    for (var i = 0; i < faces.length; i++) {
      var face = faces[i];
      var m = {};
      (S.doc.islands[face] || []).forEach(function (isl) {
        var pts = islandPts(face, isl);
        m[isl.id] = { pts: pts, color: isl.color, prims: pts.length ? G.islandPrimitives(pts, S.doc.params) : [] };
      });
      out[face] = m;
    }
    return out;
  }

  function pushAnim(item) {
    if (REDUCED || !item) return;
    S.anim.push(item);
    if (S.anim.length > 420) S.anim.splice(0, S.anim.length - 420);
  }

  function animFromDiff(before, f0) {
    if (!before || REDUCED) return;
    /* a new cell at the end of a row grows the sheet, which moves every
       coordinate on it; an animation across that jump would be a lie */
    if (f0 !== frameSig()) return;
    var now = performance.now();
    var anchor = S.animAnchor;
    var faces = Object.keys(before);
    for (var i = 0; i < faces.length; i++) {
      var face = faces[i];
      /* an island that is gone from the document still has to play its metal
         out: the diff walks the old list as well as the live one */
      var gone = {};
      Object.keys(before[face]).forEach(function (id) {
        var live = false;
        (S.doc.islands[face] || []).forEach(function (x) { if (x.id === id) live = true; });
        if (!live) gone[id] = 1;
      });
      Object.keys(gone).forEach(function (id) {
        before[face][id].prims.forEach(function (q) {
          pushAnim(makeItem(face, q, before[face][id].color || '#8b98a9', false, now, anchor));
        });
      });
      (S.doc.islands[face] || []).forEach(function (isl) {
        var oldList = before[face][isl.id] ? before[face][isl.id].prims : [];
        var pts = islandPts(face, isl);
        var newList = pts.length ? G.islandPrimitives(pts, S.doc.params) : [];
        var oldMap = new Map(), newMap = new Map(), i;
        for (i = 0; i < oldList.length; i++) oldMap.set(primKey(oldList[i]), oldList[i]);
        for (i = 0; i < newList.length; i++) newMap.set(primKey(newList[i]), newList[i]);
        newMap.forEach(function (q, key) {
          if (!oldMap.has(key)) pushAnim(makeItem(face, q, isl.color, true, now, anchor));
        });
        oldMap.forEach(function (q, key) {
          if (!newMap.has(key)) pushAnim(makeItem(face, q, isl.color, false, now, anchor));
        });
      });
    }
  }

  function makeItem(face, q, color, grow, now, anchor) {
    var item = {
      kind: q.inv ? 'strap' : 'pad',
      face: face, color: color,
      x1: q.x1, y1: q.y1, x2: q.x2, y2: q.y2, r: q.r,
      grow: grow, t0: now, delay: 0,
      dur: grow ? ANIM_GROW : ANIM_SHRINK,
      fx: q.x1, fy: q.y1, ox: q.x2, oy: q.y2
    };
    var fx = q.x1, fy = q.y1, ox = q.x2, oy = q.y2;
    var mid = { x: (fx + ox) / 2, y: (fy + oy) / 2 };
    if (anchor) {
      /* start (or finish) at the end nearest the cell that was touched */
      var da = Math.hypot(fx - anchor.x, fy - anchor.y);
      var db = Math.hypot(ox - anchor.x, oy - anchor.y);
      if (db < da) { item.fx = ox; item.fy = oy; item.ox = fx; item.oy = fy; }
      var d = Math.hypot(mid.x - anchor.x, mid.y - anchor.y);
      item.delay = Math.min(130, d * 0.8);
    }
    return item;
  }

  function drawAnim(now) {
    if (!S.anim.length) return;
    var face = S.face;
    var keep = [];
    for (var i = 0; i < S.anim.length; i++) {
      var a = S.anim[i];
      var start = a.t0 + a.delay;
      if (now >= start + a.dur) continue;
      keep.push(a);
      if (a.face !== face) continue;
      var t = (now - start) / a.dur;
      if (t < 0) t = 0;
      var e = 1 - Math.pow(1 - t, 3);
      ctx.save();
      if (a.kind === 'strap') {
        if (a.grow) {
          /* a pen line running from the cell you touched to its neighbour,
             with the tip showing where the drawing has got to */
          var w = Math.max(0.9, a.r * 0.42);
          var ex = a.fx + (a.ox - a.fx) * e, ey = a.fy + (a.oy - a.fy) * e;
          ctx.globalAlpha = 1 - 0.45 * e;
          ctx.strokeStyle = TH.animAdd;
          ctx.lineWidth = w;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(a.fx, a.fy);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          ctx.fillStyle = TH.animAdd;
          ctx.beginPath();
          ctx.arc(ex, ey, w * 0.75, 0, Math.PI * 2);
          ctx.fill();
        } else {
          /* a connection being taken away thins out and fades where it was:
             no stub left behind in the middle of a pad */
          ctx.globalAlpha = 0.8 * (1 - e);
          ctx.strokeStyle = TH.animDel;
          ctx.lineWidth = Math.max(0.7, a.r * 0.2) * (1 - 0.4 * e);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(a.fx, a.fy);
          ctx.lineTo(a.ox, a.oy);
          ctx.stroke();
        }
      } else if (a.kind === 'pad') {
        var r = a.grow ? a.r * (0.28 + 0.72 * e) : a.r * (1 - 0.72 * e);
        ctx.globalAlpha = a.grow ? (0.9 - 0.45 * e) : (0.8 * (1 - e));
        ctx.strokeStyle = a.grow ? TH.animAdd : TH.animDel;
        ctx.lineWidth = Math.max(0.8, 1.5 - e);
        ctx.beginPath();
        ctx.arc(a.x1, a.y1, r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (a.kind === 'cell') {
        var rr = a.r * (1 - e);
        if (rr > 0.1) {
          ctx.globalAlpha = 0.8 * (1 - e);
          ctx.strokeStyle = TH.animDel;
          ctx.lineWidth = Math.max(0.7, rr * 0.09);
          ctx.beginPath();
          ctx.arc(a.x1, a.y1, rr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = TH.animDel;
          ctx.font = (rr * 0.95) + 'px "Segoe UI", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(a.pol || '-', a.x1, a.y1 + rr * 0.04);
        }
      } else if (a.kind === 'flip') {
        ctx.globalAlpha = 0.75 * (1 - e);
        ctx.strokeStyle = TH.animFlip;
        ctx.lineWidth = Math.max(0.7, a.r * 0.07);
        ctx.beginPath();
        ctx.arc(a.x1, a.y1, a.r * (0.55 + 0.75 * e), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    S.anim = keep;
  }

  /* single place where an edit ends: rebuild, animate what changed, tell the
     user something happened */
  function finishEdit(before, f0, msg) {
    if (f0 !== undefined && f0 !== null && f0 !== frameSig()) S.anim = [];
    renderPalette();
    rebuildAll();
    animFromDiff(before, f0);
    S.animAnchor = null;
    S.dirty = true;
    if (msg) toast(msg);
  }

  /* ------------------------------------------------------------------ */
  /* undo, delete, rotate                                                */
  /* ------------------------------------------------------------------ */

  /* Removing a cell cannot be painted back, so keep a snapshot stack. Forty
     steps each way is far more than anyone needs and costs nothing. A new
     edit after an undo clears the redo branch, exactly like an editor. */
  var HISTORY = [], FUTURE = [];

  function snapshot() {
    try {
      HISTORY.push(JSON.stringify(S.doc));
      if (HISTORY.length > 40) HISTORY.shift();
      FUTURE.length = 0;
    } catch (e) { }
    S.unsaved = true;
    setSaveState('edited', true);
    scheduleSave();
    syncToolbar();
  }

  function undo() {
    if (!HISTORY.length) { toast('Nothing to undo'); return; }
    var txt = HISTORY.pop();
    try {
      FUTURE.push(JSON.stringify(S.doc));
      if (FUTURE.length > 40) FUTURE.shift();
      adoptDoc(JSON.parse(txt));
      toast('Undone');
    } catch (e) {
      toast('Could not undo');
    }
    syncToolbar();
  }

  function redo() {
    if (!FUTURE.length) { toast('Nothing to redo'); return; }
    var txt = FUTURE.pop();
    try {
      HISTORY.push(JSON.stringify(S.doc));
      if (HISTORY.length > 40) HISTORY.shift();
      adoptDoc(JSON.parse(txt));
      toast('Redone');
    } catch (e) {
      toast('Could not redo');
    }
    syncToolbar();
  }

  /* take a cell out of the pack completely - both faces and every island.
     A batch passes a stagger so a group pops away in order rather than all
     at once, which would read as a single flash and hide what went. */
  function deleteCell(id, delay) {
    var idx = -1;
    for (var i = 0; i < S.doc.cells.length; i++) if (S.doc.cells[i].id === id) { idx = i; break; }
    if (idx < 0) return false;
    var cell = S.doc.cells[idx];
    var fr = S.frame || (S.frame = G.frameOf(S.doc));
    var at = G.cellOnFace(S.doc, fr, S.face, cell);
    S.animAnchor = at;
    pushAnim({
      kind: 'cell', face: S.face, x1: at.x, y1: at.y, r: S.doc.params.cellD / 2,
      pol: G.polarityOnFace(cell, S.face), t0: performance.now(), delay: delay || 0,
      dur: ANIM_SHRINK, grow: false
    });
    S.doc.cells.splice(idx, 1);
    ['top', 'bottom'].forEach(function (f) {
      (S.doc.islands[f] || []).forEach(function (isl) {
        var k = isl.cells.indexOf(id);
        while (k >= 0) { isl.cells.splice(k, 1); k = isl.cells.indexOf(id); }
      });
    });
    if (S.hover && S.hover.id === id) S.hover = null;
    invalidate('top');
    invalidate('bottom');
    return true;
  }

  /* Take a whole island off one sheet. The cells stay in the pack - they are
     still welded by the other sheet - so only the metal goes: every pad and
     strap of the island shrinks away in place, which is exactly the outline
     the old build had minus the new, empty one. A pack end that sat on one of
     its pads goes too, because an end is a pad on an island. */
  function deleteIsland(face, id) {
    var list = S.doc.islands[face] || [];
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { idx = i; break; }
    if (idx < 0) return false;
    var isl = list[idx];
    var before = REDUCED ? null : snapPrims([face]);
    var f0 = frameSig();
    list.splice(idx, 1);
    var ends = 0;
    var t = S.doc.terminals;
    if (t) {
      ['neg', 'pos'].forEach(function (k) {
        var e = t[k];
        if (e && e.face === face && isl.cells.indexOf(e.cell) >= 0) { t[k] = null; ends++; }
      });
    }
    if (S.sel === id) S.sel = list.length ? list[0].id : null;
    invalidate(face);
    renderPalette();
    rebuildAll();
    animFromDiff(before, f0);
    S.animAnchor = null;
    S.dirty = true;
    toast((isl.name || 'Island') + ' removed from the ' + face + ' sheet' +
          (isl.cells.length ? ' - its ' + isl.cells.length + (isl.cells.length === 1 ? ' cell stays' : ' cells stay') +
            ' in the pack, welded by the other sheet' : '') +
          (ends ? ', and the pack end' + (ends === 1 ? '' : 's') + ' that sat on it' : ''));
    return true;
  }

  function rotateLayout(clockwise) {
    if (!S.doc.cells.length) { toast('No cells to rotate'); return; }
    snapshot();
    G.rotateDoc(S.doc, clockwise);
    S.anim = [];          /* half-played straps would be drawn in the old place */
    invalidate('top');
    invalidate('bottom');
    fitView();
    rebuildAll();
    toast('Turned ' + (clockwise ? 'clockwise' : 'anticlockwise') + ' - sheet is now ' +
          S.frame.W.toFixed(0) + ' x ' + S.frame.H.toFixed(0) + ' mm');
  }

  /* ------------------------------------------------------------------ */
  /* build                                                               */
  /* ------------------------------------------------------------------ */

  /* Distance between two islands on the same face. Straps never reach
     outside the bounding box of their own cells, so the worst case is
     always cell centre distance minus the widest radius used. */
  function gapCheck(face) {
    var out = [];
    var list = S.doc.islands[face] || [];
    if (list.length < 2) return out;
    var p = S.doc.params;
    var r = Math.max(p.padD, p.bridgeW) / 2;
    var warnAt = Math.max(0.5, p.kerf * 3);
    var errAt = p.kerf + 0.1;
    var f = S.frame || (S.frame = G.frameOf(S.doc));
    var pos = new Map();
    for (var i = 0; i < S.doc.cells.length; i++) {
      pos.set(S.doc.cells[i].id, G.cellOnFace(S.doc, f, face, S.doc.cells[i]));
    }
    var pts = [];
    for (var j = 0; j < list.length; j++) {
      var arr = [];
      for (var k = 0; k < list[j].cells.length; k++) {
        var q = pos.get(list[j].cells[k]);
        if (q) arr.push(q);
      }
      pts.push(arr);
    }
    for (var a = 0; a < list.length; a++) {
      for (var b = a + 1; b < list.length; b++) {
        var best = Infinity;
        for (var u = 0; u < pts[a].length; u++) {
          for (var v = 0; v < pts[b].length; v++) {
            var dx = pts[a][u].x - pts[b][v].x, dy = pts[a][u].y - pts[b][v].y;
            var d = dx * dx + dy * dy;
            if (d < best) best = d;
          }
        }
        if (!isFinite(best)) continue;
        var gap = Math.sqrt(best) - 2 * r;
        if (gap < warnAt) {
          out.push({
            level: gap < errAt ? 'error' : 'warn',
            kind: 'layout',
            text: (face === 'top' ? 'Top' : 'Bottom') + ': ' + list[a].name + ' and ' + list[b].name +
                  ' are ' + gap.toFixed(2) + ' mm apart' +
                  (gap < errAt ? ' - they will cut into each other.' : ' - only a thin web will be left.')
          });
        }
      }
    }
    return out;
  }

  /* An island is supposed to be one piece you can pick up. Removing cells can
     cut a group in half, which leaves one island drawn as two separate
     outlines - it would come off the cutter as two parts. Catch that. */
  function partsCheck(face) {
    var out = [];
    var sh = S.sheets[face];
    if (!sh) return out;
    for (var i = 0; i < sh.islands.length; i++) {
      var isl = sh.islands[i];
      if (isl.parts > 1) {
        out.push({
          level: 'error',
          face: face,
          text: (face === 'top' ? 'Top' : 'Bottom') + ': ' + isl.name + ' is ' + isl.parts +
                ' separate pieces - it will fall apart when cut.'
        });
      }
    }
    return out;
  }

  function ensureSheet(face) {
    if (S.sheets[face]) return S.sheets[face];
    var t0 = performance.now();
    if (!S.frame) S.frame = G.frameOf(S.doc);
    var sh = G.buildSheet(S.doc, face, { cache: S.cache[face], frame: S.frame });
    S.sheets[face] = sh;
    if (face === S.face) S.buildMs = Math.round(performance.now() - t0);
    return sh;
  }

  function rebuildAll() {
    S.sheets.top = null;
    S.sheets.bottom = null;
    S.frame = G.frameOf(S.doc);
    ensureSheet('top');
    ensureSheet('bottom');
    pruneTerminals();
    S.flowPath = G.currentPath(S.doc);
    S.drc = G.diagnose(S.doc)
      .concat(gapCheck('top'), gapCheck('bottom'), partsCheck('top'), partsCheck('bottom'));
    syncGroupControls();
    /* a full rebuild is exactly what "the sheet already matches these slider
       values" means, so the promise is renewed here rather than by whoever
       happened to change a number: the cut style changes two widths without
       going through a slider at all */
    SLIDE.settled = geomValues();
    updatePanels();
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */

  function resize() {
    var r = cv.parentElement.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    S.vw = Math.max(1, r.width);
    S.vh = Math.max(1, r.height);
    cv.width = Math.round(S.vw * dpr);
    cv.height = Math.round(S.vh * dpr);
    cv.style.width = S.vw + 'px';
    cv.style.height = S.vh + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.dirty = true;
  }

  function fitView() {
    S.frame = G.frameOf(S.doc);
    var f = S.frame;
    S.zoom = Math.min(S.vw / (f.W + 24), S.vh / (f.H + 24));
    S.px = (S.vw - f.W * S.zoom) / 2;
    S.py = (S.vh - f.H * S.zoom) / 2;
    S.zoomAnim = null;
    syncZoomLabel();
    S.dirty = true;
  }

  /* 100 % means one millimetre of sheet to 96 dpi of screen, which is the
     number a cutting template is usually checked against. */
  var PX_PER_MM = 96 / 25.4;
  var ZOOM_MIN = 0.4, ZOOM_MAX = 30;

  function syncZoomLabel() {
    var el = $('zoomPct');
    if (!el) return;
    el.textContent = Math.round(S.zoom / PX_PER_MM * 100) + '%';
    el.title = 'Zoom ' + Math.round(S.zoom / PX_PER_MM * 100) +
               '% of 1:1 - click for 100%';
  }

  function setView(z, px, py) {
    S.zoomAnim = null;
    S.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    S.px = px; S.py = py;
    syncZoomLabel();
    S.dirty = true;
  }

  /* Zoom is animated rather than snapped: the eye keeps the point it was
     looking at, which is what makes a zoom button usable on a dense pack. */
  function animateView(z2, px2, py2, dur) {
    z2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z2));
    if (REDUCED) { setView(z2, px2, py2); return; }
    S.zoomAnim = {
      z0: S.zoom, z1: z2, x0: S.px, x1: px2, y0: S.py, y1: py2,
      t0: performance.now(), dur: dur || 230
    };
    S.dirty = true;
  }

  function stepViewAnim(now) {
    var a = S.zoomAnim;
    if (!a) return;
    var t = (now - a.t0) / a.dur;
    if (t < 0) t = 0;
    if (t >= 1) {
      S.zoom = a.z1; S.px = a.x1; S.py = a.y1;
      S.zoomAnim = null;
    } else {
      var e = 1 - Math.pow(1 - t, 3);
      S.zoom = a.z0 + (a.z1 - a.z0) * e;
      S.px = a.x0 + (a.x1 - a.x0) * e;
      S.py = a.y0 + (a.y1 - a.y0) * e;
    }
    syncZoomLabel();
    S.dirty = true;
  }

  function zoomAt(factor, ax, ay) {
    if (ax === undefined) ax = S.vw / 2;
    if (ay === undefined) ay = S.vh / 2;
    var wx = (ax - S.px) / S.zoom;
    var wy = (ay - S.py) / S.zoom;
    var z2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, S.zoom * factor));
    animateView(z2, ax - wx * z2, ay - wy * z2, 200);
  }

  function setZoomPercent(pct) {
    var z2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (pct / 100) * PX_PER_MM));
    var ax = S.vw / 2, ay = S.vh / 2;
    var wx = (ax - S.px) / S.zoom, wy = (ay - S.py) / S.zoom;
    animateView(z2, ax - wx * z2, ay - wy * z2, 220);
  }

  function fitViewAnimated() {
    var f = G.frameOf(S.doc);
    S.frame = f;
    var z2 = Math.min(S.vw / (f.W + 24), S.vh / (f.H + 24));
    var px2 = (S.vw - f.W * z2) / 2;
    var py2 = (S.vh - f.H * z2) / 2;
    animateView(z2, px2, py2, 280);
  }

  function viewCenterSheet() {
    return { x: (S.vw / 2 - S.px) / S.zoom, y: (S.vh / 2 - S.py) / S.zoom };
  }

  function centerViewOn(pt, animate) {
    var px2 = S.vw / 2 - pt.x * S.zoom;
    var py2 = S.vh / 2 - pt.y * S.zoom;
    if (animate) animateView(S.zoom, px2, py2, 200);
    else setView(S.zoom, px2, py2);
  }

  /* Double-clicking an island in either list frames that piece. On a large
     pack it is the quickest way to inspect one strip without losing the
     overview first. */
  function zoomToIsland(face, id) {
    var isl = islandById(face, id);
    if (!isl || !isl.cells.length) { toast('That island has no cells'); return; }
    var f = G.frameOf(S.doc);
    S.frame = f;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < isl.cells.length; i++) {
      var c = findCell(isl.cells[i]);
      if (!c) continue;
      var p = G.cellOnFace(S.doc, f, face, c);
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    if (!isFinite(x0)) { toast('Could not find that island'); return; }
    var pad = 16;
    var z = Math.min(S.vw / (x1 - x0 + pad * 2), S.vh / (y1 - y0 + pad * 2));
    z = Math.max(ZOOM_MIN, Math.min(14, z));
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    animateView(z, S.vw / 2 - cx * z, S.vh / 2 - cy * z, 320);
    toast((isl.name || 'Island') + ' - ' + isl.cells.length + ' cells framed');
  }

  function toSheet(ev) {
    var r = cv.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left - S.px) / S.zoom,
      y: (ev.clientY - r.top - S.py) / S.zoom
    };
  }

  function cellAt(pt) {
    var f = S.frame;
    var best = null, bd = Infinity;
    var r2 = Math.pow(S.doc.params.cellD / 2, 2);
    for (var i = 0; i < S.doc.cells.length; i++) {
      var c = S.doc.cells[i];
      var p = G.cellOnFace(S.doc, f, S.face, c);
      var dx = p.x - pt.x, dy = p.y - pt.y;
      var d = dx * dx + dy * dy;
      if (d <= r2 && d < bd) { bd = d; best = c; }
    }
    return best;
  }

  function draw(nowOverride) {
    S.dirty = false;
    var f = S.frame || (S.frame = G.frameOf(S.doc));
    var zoom = S.zoom;
    ctx.fillStyle = TH.canvas;
    ctx.fillRect(0, 0, S.vw, S.vh);

    ctx.save();
    ctx.translate(S.px, S.py);
    ctx.scale(zoom, zoom);

    /* sheet plate */
    ctx.fillStyle = TH.sheet;
    ctx.fillRect(0, 0, f.W, f.H);
    ctx.strokeStyle = TH.sheetLine;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(0, 0, f.W, f.H);

    /* 10 mm grid - a view option, never part of the document */
    if (S.grid) {
      ctx.strokeStyle = TH.grid;
      ctx.lineWidth = 1 / zoom;
      ctx.beginPath();
      for (var gx = 0; gx <= f.W; gx += 10) { ctx.moveTo(gx, 0); ctx.lineTo(gx, f.H); }
      for (var gy = 0; gy <= f.H; gy += 10) { ctx.moveTo(0, gy); ctx.lineTo(f.W, gy); }
      ctx.stroke();
    }

    /* the row under the pointer in the Rows list, so a row number means
       something on the sheet */
    if (S.hiRow !== null) {
      var band = Math.max(4, S.doc.params.pitch * 0.5);
      var y0b = S.hiRow + f.oy - band / 2;
      ctx.fillStyle = TH.rowBand;
      ctx.fillRect(0, y0b, f.W, band);
      ctx.strokeStyle = TH.rowLine;
      ctx.lineWidth = 1 / zoom;
      ctx.beginPath();
      ctx.moveTo(0, y0b); ctx.lineTo(f.W, y0b);
      ctx.moveTo(0, y0b + band); ctx.lineTo(f.W, y0b + band);
      ctx.stroke();
    }

    /* While a paint stroke is down, refresh the exact face as often as its
       own build cost allows. Between those traces the changed islands are
       drawn from their primitives, so a pointer move never has to wait for a
       contour. The full both-face rebuild still waits for the release. */
    var wetLive = !!(S.dragging && S.wet);
    if (wetLive) {
      if (!S.sheets[S.face]) S.wet.gap = 0;
      paintPreviewDue(performance.now());
    }
    var sheet = S.sheets[S.face];
    var wetDirty = !!(wetLive && S.wet.builtGen !== S.wet.gen);

    /* the far sheet: its body lies under the near metal, its edges are drawn
       over it, so a plate you are not editing still reads at a glance */
    if (S.ghost) ghostFill();

    if (sheet) {
      for (var i = 0; i < sheet.islands.length; i++) {
        var fill = sheet.islands[i];
        if (wetDirty && S.wet.changed[fill.id]) continue;
        var hot = S.hiIsland && fill.id === S.hiIsland;
        ctx.fillStyle = hexA(fill.color,
          (S.sel && fill.id === S.sel) ? TH.fillSelA : hot ? TH.fillSelA * 0.8 : TH.fillA);
        ctx.fill(islandPath(fill), 'evenodd');
      }
    }

    if (S.ghost) ghostLines();

    if (sheet) {
      for (i = 0; i < sheet.islands.length; i++) {
        var isl = sheet.islands[i];
        if (wetDirty && S.wet.changed[isl.id]) continue;
        ctx.strokeStyle = isl.color;
        ctx.lineWidth = (S.sel && isl.id === S.sel ? 2.2
          : S.hiIsland && isl.id === S.hiIsland ? 1.9 : 1.4) / zoom;
        ctx.stroke(islandPath(isl));
      }
    }

    /* the changed islands are live, the rest of the sheet stays exact */
    if (wetDirty) drawWetIslands();

    /* cells */
    var r = S.doc.params.cellD / 2;
    var anyPick = S.pick.size > 0;
    for (var c = 0; c < S.doc.cells.length; c++) {
      var cell = S.doc.cells[c];
      var pos = G.cellOnFace(S.doc, f, S.face, cell);
      var pol = G.polarityOnFace(cell, S.face);
      var isPick = anyPick && S.pick.has(cell.id);
      var isHot = !isPick && S.hover && S.hover.id === cell.id;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      if (isPick) {
        ctx.fillStyle = 'rgba(239,107,107,0.17)';
        ctx.fill();
      } else if (isHot && S.tool === 'delete') {
        ctx.fillStyle = 'rgba(239,107,107,0.06)';
        ctx.fill();
      }
      /* a soft halo under the pointer: the cell you are about to paint, flip
         or take away is obvious without any colour being committed to it */
      if (isHot) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 3.2 / zoom, 0, Math.PI * 2);
        ctx.strokeStyle = hexA(S.tool === 'delete' ? TH.pick : TH.accent, 0.30);
        ctx.lineWidth = 5 / zoom;
        ctx.stroke();
      }

      ctx.strokeStyle = isPick ? TH.pick : (isHot ? TH.cellHot : TH.cell);
      ctx.lineWidth = (isPick ? 2.2 : isHot ? 1.6 : 1) / zoom;
      ctx.stroke();

      /* a picked cell wears a dashed halo, so "about to be removed" cannot be
         mistaken for an island colour */
      if (isPick) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 2.4 / zoom, 0, Math.PI * 2);
        ctx.setLineDash([2.4 / zoom, 2 / zoom]);
        ctx.lineWidth = 1.3 / zoom;
        ctx.strokeStyle = TH.pick;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = pol === '+' ? TH.plus : TH.minus;
      ctx.font = (r * 0.95) + 'px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pol, pos.x, pos.y + r * 0.04);
      if (r >= 9) {
        ctx.fillStyle = TH.label;
        ctx.font = (r * 0.42) + 'px "Segoe UI", sans-serif';
        ctx.fillText(String(c + 1), pos.x, pos.y + r * 0.62);
      }
    }

    /* the guide slits last, over the cell they mark */
    if (sheet) drawSlits(sheet);

    /* the stroke's own trail, so direction and the cell under the pointer are
       readable even when the island's metal did not change */
    var drawNow = nowOverride === undefined ? performance.now() : nowOverride;
    if (wetLive) drawWetTrail(drawNow);

    /* the main current path and the pack ends, over the metal and the cells */
    drawFlow(drawNow);
    drawEnds(drawNow);

    /* the box being dragged out, over the cells it has already picked */
    if (S.marquee && S.marquee.moved) {
      var mm = S.marquee;
      var bx = Math.min(mm.x0, mm.x1), by = Math.min(mm.y0, mm.y1);
      var bw = Math.abs(mm.x1 - mm.x0), bh = Math.abs(mm.y1 - mm.y0);
      ctx.fillStyle = hexA(TH.pick, 0.09);
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = TH.pick;
      ctx.lineWidth = 1.2 / zoom;
      ctx.setLineDash([4 / zoom, 3 / zoom]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]);
    }

    /* animation last, so a growing strap is drawn over the metal it becomes */
    if (S.anim.length) drawAnim(nowOverride === undefined ? performance.now() : nowOverride);

    ctx.restore();

    /* face label */
    ctx.fillStyle = TH.label;
    ctx.font = '600 11px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText((S.face === 'top' ? 'TOP SHEET' : 'BOTTOM SHEET (mirrored)') + '  -  ' +
                 f.W.toFixed(1) + ' x ' + f.H.toFixed(1) + ' mm', S.vw - 12, 10);
    if (S.ghost && S.sheets[otherFace()] && S.sheets[otherFace()].islands.length) {
      ctx.fillStyle = TH.subLabel;
      ctx.font = '600 10px "Segoe UI", sans-serif';
      ctx.fillText('dashed = ' + otherFace() + ' sheet, seen through', S.vw - 12, 25);
    }
    drawScale();

    /* an empty pack still says what to do next rather than showing a blank
       sheet with no explanation */
    if (!S.doc.cells.length) {
      var cx0 = S.vw / 2, cy0 = S.vh / 2;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TH.label;
      ctx.font = '600 17px "Segoe UI", sans-serif';
      ctx.fillText('Empty pack', cx0, cy0 - 14);
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.fillStyle = TH.subLabel;
      ctx.fillText('Fill the grid, or press Ctrl+K for the command palette.', cx0, cy0 + 10);
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.fillText('Ctrl+Z still brings the last pack back.', cx0, cy0 + 28);
    }

    drawMini(nowOverride === undefined ? performance.now() : nowOverride);
  }

  /* A scale bar is the fastest way to read a sheet whose zoom changes: it
     picks a round number of millimetres that lands between 55 and 150 screen
     pixels, so it is always legible and always true. */
  function drawScale() {
    if (!S.zoom || S.vw < 260) return;
    var options = [5, 10, 20, 50, 100, 200, 500];
    var target = 96, mm = options[0], len = mm * S.zoom, best = Infinity;
    for (var i = 0; i < options.length; i++) {
      var l = options[i] * S.zoom;
      if (l >= 55 && l <= 155) {
        var d = Math.abs(l - target);
        if (d < best) { best = d; mm = options[i]; len = l; }
      }
    }
    if (!isFinite(best)) {
      /* outside the comfortable range, take the nearest end of it */
      var lo = options[0] * S.zoom, hi = options[options.length - 1] * S.zoom;
      if (lo > 155) { mm = options[0]; len = lo; }
      else { mm = options[options.length - 1]; len = hi; }
    }
    var x1 = S.vw - 14, x0 = x1 - len, y = 48;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = TH.label;
    ctx.fillStyle = TH.label;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y); ctx.lineTo(x1, y);
    ctx.moveTo(x0, y - 3); ctx.lineTo(x0, y + 3);
    ctx.moveTo(x1, y - 3); ctx.lineTo(x1, y + 3);
    ctx.stroke();
    ctx.font = '600 9.5px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(mm + ' mm', (x0 + x1) / 2, y - 5);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* minimap                                                             */
  /*
   * At a fit view the whole sheet is already on screen, so the minimap is
   * only worth its pixels once you zoom in. It shows the same paper, the
   * pieces on it and the rectangle of the sheet the main view can see; click
   * or drag anywhere on it to move that rectangle.
   */
  /* ------------------------------------------------------------------ */

  function resizeMini() {
    if (!mini || !mctx) return;
    var r = mini.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var dpr = window.devicePixelRatio || 1;
    mini.width = Math.max(1, Math.round(r.width * dpr));
    mini.height = Math.max(1, Math.round(r.height * dpr));
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function miniMap() {
    var r = mini.getBoundingClientRect();
    var f = S.frame;
    if (!f) return null;
    var pad = 9;
    var z = Math.min((r.width - pad * 2) / Math.max(1, f.W), (r.height - pad * 2) / Math.max(1, f.H));
    return {
      r: r, f: f, z: z,
      ox: (r.width - f.W * z) / 2,
      oy: (r.height - f.H * z) / 2
    };
  }

  function drawMini(now) {
    if (!S.mini || !mini || !mctx) return;
    var mm = miniMap();
    if (!mm || !isFinite(mm.z) || mm.z <= 0) return;
    var w = mm.r.width, h = mm.r.height, f = mm.f;
    mctx.clearRect(0, 0, w, h);

    /* a quiet dark/light wash behind the paper, so the map reads as its own
       object without another border */
    mctx.fillStyle = TH.canvas;
    mctx.globalAlpha = 0.55;
    mctx.fillRect(0, 0, w, h);
    mctx.globalAlpha = 1;

    mctx.save();
    mctx.translate(mm.ox, mm.oy);
    mctx.scale(mm.z, mm.z);

    mctx.fillStyle = TH.sheet;
    mctx.fillRect(0, 0, f.W, f.H);
    mctx.strokeStyle = TH.sheetLine;
    mctx.lineWidth = 1 / mm.z;
    mctx.strokeRect(0, 0, f.W, f.H);

    var sheet = S.sheets[S.face];
    var wet = S.dragging ? S.wet : null;
    var wetDirty = !!(wet && wet.builtGen !== wet.gen);
    if (sheet) {
      for (var i = 0; i < sheet.islands.length; i++) {
        var isl = sheet.islands[i];
        if (wetDirty && wet.changed[isl.id]) continue;
        mctx.fillStyle = hexA(isl.color, S.sel === isl.id ? 0.55 : 0.34);
        mctx.fill(islandPath(isl), 'evenodd');
        mctx.strokeStyle = hexA(isl.color, 0.9);
        mctx.lineWidth = 0.9 / mm.z;
        mctx.stroke(islandPath(isl));
      }
    }
    if (wetDirty) {
      var live = S.doc.islands[S.face] || [];
      for (var w = 0; w < live.length; w++) {
        if (!wet.changed[live[w].id]) continue;
        mctx.fillStyle = hexA(live[w].color, S.sel === live[w].id ? 0.55 : 0.34);
        mctx.fill(wetPrimPath(live[w]));
      }
    }

    if (S.ghost) {
      mctx.save();
      mctx.translate(f.W, 0);
      mctx.scale(-1, 1);
      var other = S.sheets[otherFace()];
      if (other) {
        for (var k = 0; k < other.islands.length; k++) {
          mctx.strokeStyle = hexA(other.islands[k].color, 0.45);
          mctx.lineWidth = 0.8 / mm.z;
          mctx.setLineDash([2.5 / mm.z, 2 / mm.z]);
          mctx.stroke(islandPath(other.islands[k]));
        }
      }
      mctx.setLineDash([]);
      mctx.restore();
    }

    /* pack ends, if any */
    var flow = S.flowPath;
    if (flow && flow.neg && flow.pos) {
      [['neg', TH.endNeg], ['pos', TH.endPos]].forEach(function (pair) {
        var e = flow[pair[0]];
        if (!e) return;
        var c = findCell(e.cell);
        if (!c) return;
        var p = G.cellOnFace(S.doc, f, S.face, c);
        mctx.beginPath();
        mctx.arc(p.x, p.y, Math.max(1.4, 2.4 / mm.z), 0, Math.PI * 2);
        mctx.fillStyle = pair[1];
        mctx.fill();
      });
    }

    /* the window of the sheet the main view currently shows */
    var vx = (-S.px) / S.zoom, vy = (-S.py) / S.zoom;
    var vw = S.vw / S.zoom, vh = S.vh / S.zoom;
    mctx.strokeStyle = TH.accent;
    mctx.lineWidth = 1.4 / mm.z;
    mctx.setLineDash([4 / mm.z, 3 / mm.z]);
    mctx.strokeRect(vx, vy, vw, vh);
    mctx.setLineDash([]);
    mctx.restore();
  }

  /* the far sheet, drawn mirrored back into this sheet's coordinates so it
     lands where the metal really is: the body under the near metal, the edges
     over it. Each far piece keeps its own colour, so the two faces are told
     apart by the dash, not by a second palette. */
  function ghostFrame(fn) {
    /* no build on this path: the toggle builds both sheets, every full rebuild
       builds both, and a preview that moved the frame drops the ghost instead
       of drawing it in coordinates that no longer hold */
    var sh = S.sheets[otherFace()];
    if (!sh || !sh.islands.length) return;
    ctx.save();
    ctx.translate(S.frame.W, 0);
    ctx.scale(-1, 1);
    for (var i = 0; i < sh.islands.length; i++) fn(sh.islands[i]);
    ctx.setLineDash([]);
    ctx.restore();
  }

  function ghostFill() {
    ghostFrame(function (isl) {
      ctx.fillStyle = hexA(isl.color, TH.ghostFillA);
      ctx.fill(islandPath(isl), 'evenodd');
    });
  }

  function ghostLines() {
    ghostFrame(function (piece) {
      ctx.strokeStyle = hexA(piece.color, TH.ghostLineA);
      ctx.lineWidth = 1.5 / S.zoom;
      ctx.setLineDash([6 / S.zoom, 4.5 / S.zoom]);
      ctx.stroke(islandPath(piece));
    });
  }

  function islandPath(isl) {
    var path = new Path2D();
    addLoops(path, isl.polys);
    if (isl.slots) addLoops(path, isl.slots);
    return path;
  }

  function addLoops(path, list) {
    for (var p = 0; p < list.length; p++) {
      var poly = list[p];
      if (poly.length < 3) continue;
      path.moveTo(poly[0].x, poly[0].y);
      for (var k = 1; k < poly.length; k++) path.lineTo(poly[k].x, poly[k].y);
      path.closePath();
    }
  }

  /* The guide slits are cut through the plate, so they are drawn as openings
     and drawn last: a dark slot with a lit edge, over the cell it belongs to,
     which is the mark the electrode will actually line up on. */
  function drawSlits(sheet) {
    for (var i = 0; i < sheet.islands.length; i++) {
      var isl = sheet.islands[i];
      if (!isl.slots || !isl.slots.length) continue;
      var path = new Path2D();
      addLoops(path, isl.slots);
      ctx.fillStyle = TH.slit;
      ctx.fill(path, 'evenodd');
      ctx.strokeStyle = hexA(isl.color, TH.slitEdge);
      ctx.lineWidth = 0.8 / S.zoom;
      ctx.stroke(path);
    }
  }

  /* ------------------------------------------------------------------ */
  /* pack ends and current flow                                          */
  /*
   * The ends are annotations, not cut geometry: a red/blue ring marks the pad
   * the main lead lands on, and the two rings name the islands the current
   * enters and leaves. Between them the route follows the real cell edges and
   * the real metal graph, and moving dashes show the direction from - to +.
   * The path is drawn in pack coordinates, so it mirrors with the sheet like
   * the cells do.
   */
  /* ------------------------------------------------------------------ */

  function localPoint(p) {
    var f = S.frame;
    return { x: S.face === 'bottom' ? f.W - p.x : p.x, y: p.y };
  }

  function pathFromPoints(pts) {
    var path = new Path2D();
    path.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    return path;
  }

  function pointAlong(pts, t) {
    var len = [], total = 0, i;
    for (i = 1; i < pts.length; i++) {
      var d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      len.push(d);
      total += d;
    }
    if (!(total > 0)) return { x: pts[0].x, y: pts[0].y, a: 0 };
    var want = Math.max(0, Math.min(1, t)) * total, run = 0;
    for (i = 0; i < len.length; i++) {
      if (run + len[i] >= want || i === len.length - 1) {
        var f = len[i] > 0 ? (want - run) / len[i] : 0;
        f = Math.max(0, Math.min(1, f));
        return {
          x: pts[i].x + (pts[i + 1].x - pts[i].x) * f,
          y: pts[i].y + (pts[i + 1].y - pts[i].y) * f,
          a: Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x)
        };
      }
      run += len[i];
    }
    return { x: pts[0].x, y: pts[0].y, a: 0 };
  }

  function polyLength(pts) {
    var n = 0;
    for (var i = 1; i < pts.length; i++) {
      n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return n;
  }

  function pointAtDistance(pts, d) {
    var total = polyLength(pts);
    if (!(total > 0)) return { x: pts[0].x, y: pts[0].y, a: 0 };
    d = Math.max(0, Math.min(total, d));
    var run = 0;
    for (var i = 1; i < pts.length; i++) {
      var dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      var len = Math.hypot(dx, dy);
      if (!(len > 0)) continue;
      if (run + len >= d || i === pts.length - 1) {
        var f = Math.max(0, Math.min(1, (d - run) / len));
        return {
          x: pts[i - 1].x + dx * f,
          y: pts[i - 1].y + dy * f,
          a: Math.atan2(dy, dx)
        };
      }
      run += len;
    }
    return { x: pts[0].x, y: pts[0].y, a: 0 };
  }

  /* A route span is one island. Keeping the ends short of the shared pad is
     what turns the old single line into separate island runs: the eye sees
     where one piece of metal ends and the next begins. */
  function slicePolyline(pts, from, to) {
    var total = polyLength(pts);
    var out = [];
    if (!(total > 0)) return [{ x: pts[0].x, y: pts[0].y }];
    from = Math.max(0, Math.min(total, from));
    to = Math.max(from, Math.min(total, to));
    function push(p) {
      if (!out.length || Math.hypot(out[out.length - 1].x - p.x, out[out.length - 1].y - p.y) > 1e-4) {
        out.push({ x: p.x, y: p.y });
      }
    }
    push(pointAtDistance(pts, from));
    var acc = 0;
    for (var i = 1; i < pts.length; i++) {
      var d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (acc + d > from + 1e-4 && acc + d < to - 1e-4) push(pts[i]);
      acc += d;
    }
    push(pointAtDistance(pts, to));
    return out.length > 1 ? out : [{ x: pts[0].x, y: pts[0].y }, { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y }];
  }

  function flowIslandCount(flow) {
    var seen = Object.create(null), n = 0;
    for (var i = 0; i < (flow.spans || []).length; i++) {
      var k = flow.spans[i].face + ':' + flow.spans[i].island;
      if (!seen[k]) { seen[k] = 1; n++; }
    }
    return n;
  }

  /* The hop is a short dotted arc over the shared pad, not more metal. It is
     only drawn while the pulse is crossing, so the two island runs never join
     into one continuous-looking line. */
  function makeFlowHop(a, b, at, cellD) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var d = Math.hypot(dx, dy);
    var nx, ny;
    if (d > 0.01) { nx = -dy / d; ny = dx / d; }
    else { nx = 0; ny = -1; }
    if (ny > 0) { nx = -nx; ny = -ny; }
    var bulge = Math.max(cellD * 0.78, d * 1.15);
    var cx = (a.x + b.x) / 2 + nx * bulge;
    var cy = (a.y + b.y) / 2 + ny * bulge;
    var pts = [];
    for (var i = 0; i <= 12; i++) {
      var t = i / 12, u = 1 - t;
      pts.push({
        x: u * u * a.x + 2 * u * t * cx + t * t * b.x,
        y: u * u * a.y + 2 * u * t * cy + t * t * b.y
      });
    }
    return { pts: pts, at: at };
  }

  function buildCellFlowPlan(flow, now) {
    var cellD = (S.doc.params && S.doc.params.cellD) || 21.2;
    var spans = flow.spans || [];
    var runs = [], items = [], i;
    for (i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (!sp.points || sp.points.length < 2) continue;
      var pts = [];
      for (var p = 0; p < sp.points.length; p++) pts.push(localPoint(sp.points[p]));
      var len = polyLength(pts);
      if (!(len > 0.05)) continue;
      var headTrim = i > 0 ? Math.min(cellD * 0.38, len * 0.24) : 0;
      var tailTrim = i < spans.length - 1 ? Math.min(cellD * 0.38, len * 0.24) : 0;
      var disp = slicePolyline(pts, headTrim, len - tailTrim);
      var dlen = polyLength(disp);
      if (!(dlen > 0.05)) {
        disp = [];
        for (var q = 0; q < pts.length; q++) disp.push({ x: pts[q].x, y: pts[q].y });
        dlen = len;
      }
      var island = islandById(sp.face, sp.island);
      var shape = null, outline = null;
      var sheet = S.sheets[sp.face];
      if (sheet) {
        for (var k = 0; k < sheet.islands.length; k++) {
          if (String(sheet.islands[k].id) === String(sp.island)) { shape = sheet.islands[k]; break; }
        }
      }
      if (shape) {
        outline = new Path2D();
        addLoops(outline, shape.polys);
      }
      runs.push({
        face: sp.face, island: sp.island,
        name: island ? (island.name || sp.island) : sp.island,
        pts: pts, disp: disp, path: pathFromPoints(disp), len: dlen,
        start: disp[0], end: disp[disp.length - 1],
        junction: pts[pts.length - 1],
        outline: outline,
        mirror: sp.face !== S.face
      });
    }
    if (!runs.length) return null;

    items.push({ kind: 'hold', dur: 300, at: runs[0].start, first: true });
    for (i = 0; i < runs.length; i++) {
      var dur = Math.max(320, Math.min(1200, Math.round(runs[i].len / 0.16)));
      items.push({ kind: 'run', dur: dur, run: i });
      if (i + 1 < runs.length) {
        var hop = makeFlowHop(runs[i].end, runs[i + 1].start, runs[i].junction, cellD);
        hop.path = pathFromPoints(hop.pts);
        items.push({ kind: 'hop', dur: 320, hop: hop, from: i, to: i + 1 });
      }
    }
    items.push({ kind: 'hold', dur: 720, at: runs[runs.length - 1].end, last: true });
    var total = 0;
    for (i = 0; i < items.length; i++) total += items[i].dur;
    return { mode: 'cells', runs: runs, items: items, total: total };
  }

  function islandCenter(face, id) {
    var isl = islandById(face, id);
    if (!isl || !isl.cells.length) return null;
    var sx = 0, sy = 0, n = 0;
    for (var i = 0; i < isl.cells.length; i++) {
      var c = findCell(isl.cells[i]);
      if (!c) continue;
      var p = G.cellOnFace(S.doc, S.frame, S.face, c);
      sx += p.x;
      sy += p.y;
      n++;
    }
    return n ? { x: sx / n, y: sy / n } : null;
  }

  function flowEndPoint(term) {
    if (!term || term.cell === undefined || term.cell === null) return null;
    var c = findCell(term.cell);
    if (!c) return null;
    return G.cellOnFace(S.doc, S.frame, S.face, c);
  }

  function pushFlowNode(list, node) {
    if (!node) return;
    var last = list[list.length - 1];
    if (last && Math.hypot(last.x - node.x, last.y - node.y) < 0.25) return;
    list.push(node);
  }

  /* A second view of the same route: one node at the middle of each island,
     joined by straight arrows. It is a diagram, not a metal tracing - the
     pad-to-pad route is still available from the Cell route button. */
  function buildIslandFlowPlan(flow, now) {
    var nodes = [], segs = [], items = [], i;
    var neg = flowEndPoint(flow.neg);
    pushFlowNode(nodes, neg ? {
      x: neg.x, y: neg.y, kind: 'end', face: flow.neg.face, sign: 'neg'
    } : null);

    var seen = Object.create(null);
    for (i = 0; i < (flow.spans || []).length; i++) {
      var sp = flow.spans[i];
      if (!sp) continue;
      var key = sp.face + ':' + sp.island;
      if (seen[key]) continue;
      seen[key] = 1;
      var at = islandCenter(sp.face, sp.island);
      if (!at) continue;
      var isl = islandById(sp.face, sp.island);
      var shape = null, outline = null;
      var sheet = S.sheets[sp.face];
      if (sheet) {
        for (var k = 0; k < sheet.islands.length; k++) {
          if (String(sheet.islands[k].id) === String(sp.island)) { shape = sheet.islands[k]; break; }
        }
      }
      if (shape) {
        outline = new Path2D();
        addLoops(outline, shape.polys);
      }
      pushFlowNode(nodes, {
        x: at.x, y: at.y, kind: 'island', face: sp.face,
        island: sp.island, name: isl ? (isl.name || sp.island) : sp.island,
        outline: outline, mirror: sp.face !== S.face
      });
    }

    var pos = flowEndPoint(flow.pos);
    pushFlowNode(nodes, pos ? {
      x: pos.x, y: pos.y, kind: 'end', face: flow.pos.face, sign: 'pos'
    } : null);
    if (nodes.length < 2) return null;

    for (i = 0; i + 1 < nodes.length; i++) {
      var a = nodes[i], b = nodes[i + 1];
      var len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(len > 0.1)) continue;
      var pts = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
      segs.push({
        a: a, b: b, len: len, pts: pts, path: pathFromPoints(pts),
        angle: Math.atan2(b.y - a.y, b.x - a.x)
      });
    }
    if (!segs.length) return null;

    items.push({ kind: 'hold', dur: 320, at: nodes[0], first: true });
    for (i = 0; i < segs.length; i++) {
      var dur = Math.max(420, Math.min(1200, Math.round(segs[i].len / 0.18)));
      items.push({ kind: 'seg', dur: dur, seg: i });
      if (i + 1 < segs.length) {
        items.push({ kind: 'hold', dur: 140, at: segs[i].b, node: i + 1, land: true });
      }
    }
    items.push({ kind: 'hold', dur: 720, at: segs[segs.length - 1].b, last: true });
    var total = 0;
    for (i = 0; i < items.length; i++) total += items[i].dur;
    return { mode: 'islands', nodes: nodes, segments: segs, items: items, total: total };
  }

  function buildFlowPlan(flow, now) {
    return S.flowMode === 'cells' ? buildCellFlowPlan(flow, now) : buildIslandFlowPlan(flow, now);
  }

  function flowFrameAt(plan, t) {
    t = ((t % plan.total) + plan.total) % plan.total;
    var acc = 0;
    for (var i = 0; i < plan.items.length; i++) {
      var item = plan.items[i];
      if (t < acc + item.dur) return { item: item, u: Math.max(0, Math.min(1, (t - acc) / item.dur)) };
      acc += item.dur;
    }
    return { item: plan.items[plan.items.length - 1], u: 1 };
  }

  function drawFlowChevron(pts, t, alpha, zoom) {
    if (!pts || pts.length < 2) return;
    var q = pointAlong(pts, t);
    var s = 2.4 / zoom;
    ctx.save();
    ctx.translate(q.x, q.y);
    ctx.rotate(q.a);
    ctx.setLineDash([]);
    ctx.strokeStyle = hexA(TH.flow, alpha);
    ctx.lineWidth = 1.15 / zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-s, -s * 0.7);
    ctx.lineTo(0, 0);
    ctx.lineTo(-s, s * 0.7);
    ctx.stroke();
    ctx.restore();
  }

  function drawFlowJunction(p, alpha, pulse, zoom) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = hexA(TH.flow, alpha);
    ctx.fillStyle = hexA(TH.flow, alpha * 0.9);
    ctx.lineWidth = 1.1 / zoom;
    ctx.beginPath();
    ctx.arc(p.x, p.y, (3.1 + (pulse || 0) * 3.2) / zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 0.85 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFlowBase(plan, act) {
    var zoom = S.zoom, i;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (i = 0; i < plan.runs.length; i++) {
      var run = plan.runs[i];
      var same = run.face === S.face;
      var active = act.item.kind === 'run' && act.item.run === i;
      ctx.setLineDash([]);
      if (active) {
        ctx.strokeStyle = hexA(TH.flow, 0.10);
        ctx.lineWidth = 8 / zoom;
        ctx.stroke(run.path);
      }
      ctx.strokeStyle = hexA(TH.flow, same ? 0.34 : 0.16);
      ctx.lineWidth = (same ? 1.5 : 1.05) / zoom;
      ctx.setLineDash(same ? [4.5 / zoom, 5.2 / zoom] : [1.7 / zoom, 4.6 / zoom]);
      ctx.lineDashOffset = 0;
      ctx.stroke(run.path);
      if (!active) drawFlowChevron(run.disp, 0.55, same ? 0.42 : 0.20, zoom);
    }
    for (i = 0; i < plan.items.length; i++) {
      var item = plan.items[i];
      if (item.kind !== 'hop') continue;
      var near = plan.runs[item.from].face === S.face || plan.runs[item.to].face === S.face;
      var alpha = near ? 0.35 : 0.18, pulse = 0;
      if (act.item.kind === 'run' && act.item.run === item.from) {
        var nearEnd = Math.max(0, (act.u - 0.55) / 0.45);
        alpha = Math.min(0.85, alpha + nearEnd * 0.42);
        pulse = nearEnd * 0.7;
      }
      drawFlowJunction(item.hop.at, alpha, pulse, zoom);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawFlowIslandNode(node, near, active, now, zoom) {
    var base = near ? 0.72 : 0.38;
    var pulse = active ? (0.5 + 0.5 * Math.sin(now * 0.008)) : 0;
    var r = (5.0 + pulse * 1.6) / zoom;
    ctx.save();
    ctx.setLineDash([]);
    if (active) {
      ctx.fillStyle = hexA(TH.flow, 0.10);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 4.5 / zoom, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = hexA(TH.flow, base + (active ? 0.24 : 0));
    ctx.lineWidth = (active ? 1.7 : 1.25) / zoom;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = near ? 'rgba(255,255,255,0.88)' : hexA(TH.flow, base * 0.9);
    ctx.beginPath();
    ctx.arc(node.x, node.y, 1.15 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFlowIslandBase(plan, act, now) {
    var zoom = S.zoom, i;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (i = 0; i < plan.segments.length; i++) {
      var seg = plan.segments[i];
      var near = seg.a.face === S.face || seg.b.face === S.face;
      var active = act.item.kind === 'seg' && act.item.seg === i;
      ctx.setLineDash([]);
      if (active) {
        ctx.strokeStyle = hexA(TH.flow, 0.10);
        ctx.lineWidth = 8 / zoom;
        ctx.stroke(seg.path);
      }
      ctx.strokeStyle = hexA(TH.flow, near ? 0.42 : 0.20);
      ctx.lineWidth = (near ? 1.55 : 1.05) / zoom;
      ctx.setLineDash(near ? [5 / zoom, 5.4 / zoom] : [2 / zoom, 4.8 / zoom]);
      ctx.lineDashOffset = 0;
      ctx.stroke(seg.path);
      if (!active) drawFlowChevron(seg.pts, 0.52, near ? 0.45 : 0.22, zoom);
    }
    for (i = 0; i < plan.nodes.length; i++) {
      var node = plan.nodes[i];
      if (node.kind !== 'island') continue;
      var near = node.face === S.face;
      var active = false;
      if (act.item.kind === 'seg' && (act.item.seg === i - 1 || act.item.seg === i)) active = true;
      if (act.item.kind === 'hold' && act.item.node === i) active = true;
      if (active && node.outline) {
        ctx.save();
        ctx.setLineDash([]);
        if (node.mirror) {
          ctx.translate(S.frame.W, 0);
          ctx.scale(-1, 1);
        }
        ctx.strokeStyle = hexA(TH.flow, 0.14);
        ctx.lineWidth = 2.8 / zoom;
        ctx.stroke(node.outline);
        ctx.restore();
      }
      drawFlowIslandNode(node, near, active, now, zoom);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawFlowIslandSeg(plan, item, u, now) {
    var seg = plan.segments[item.seg], zoom = S.zoom;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = hexA(TH.flow, 0.10);
    ctx.lineWidth = 9 / zoom;
    ctx.stroke(seg.path);
    ctx.strokeStyle = hexA(TH.flow, 0.95);
    ctx.lineWidth = 2.4 / zoom;
    var dash = 6.5 / zoom, gap = 5 / zoom, cycle = dash + gap;
    ctx.setLineDash([dash, gap]);
    ctx.lineDashOffset = -((now * 0.06) % cycle);
    ctx.stroke(seg.path);
    ctx.setLineDash([]);
    ctx.restore();
    drawFlowPacket(seg.pts, u, now);
    var ring = Math.max(0, (u - 0.45) / 0.55);
    if (ring > 0) {
      ctx.save();
      ctx.strokeStyle = hexA(TH.flow, 0.45 * ring);
      ctx.lineWidth = 1.3 / zoom;
      ctx.beginPath();
      ctx.arc(seg.b.x, seg.b.y, (3.4 + ring * 6) / zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawFlowPacket(pts, u, now) {
    var zoom = S.zoom;
    var total = polyLength(pts);
    if (!(total > 0)) return;
    var head = Math.max(0, Math.min(1, u)) * total;
    var cellD = (S.doc.params && S.doc.params.cellD) || 21.2;
    var tail = Math.min(total, Math.max(cellD * 1.3, total * 0.30));
    var n = 9, i;
    ctx.save();
    ctx.fillStyle = TH.flow;
    for (i = n; i >= 1; i--) {
      var d = head - tail * (i / n);
      if (d < 0) continue;
      var q = pointAtDistance(pts, d);
      ctx.globalAlpha = 0.34 * (1 - i / n);
      ctx.beginPath();
      ctx.arc(q.x, q.y, (2.4 - 1.2 * i / n) / zoom, 0, Math.PI * 2);
      ctx.fill();
    }
    var p = pointAtDistance(pts, head);
    ctx.globalAlpha = 1;
    var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 10 / zoom);
    g.addColorStop(0, hexA(TH.flow, 0.55));
    g.addColorStop(1, hexA(TH.flow, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 10 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hexA(TH.flow, 0.95);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.1 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.25 / zoom, 0, Math.PI * 2);
    ctx.fill();
    var s = 3.0 / zoom;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.a);
    ctx.strokeStyle = hexA(TH.flow, 0.85);
    ctx.lineWidth = 1.4 / zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-s, -s * 0.7);
    ctx.lineTo(0, 0);
    ctx.lineTo(-s, s * 0.7);
    ctx.stroke();
    ctx.restore();
  }

  function drawFlowRun(plan, item, u, now) {
    var run = plan.runs[item.run];
    var zoom = S.zoom;
    if (run.outline) {
      ctx.save();
      if (run.mirror) {
        ctx.translate(S.frame.W, 0);
        ctx.scale(-1, 1);
      }
      var glow = 0.5 + 0.5 * Math.sin(now * 0.006);
      ctx.strokeStyle = hexA(TH.flow, 0.18 + 0.10 * glow);
      ctx.lineWidth = 3.0 / zoom;
      ctx.stroke(run.outline);
      ctx.restore();
    }
    var path = run.path;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = hexA(TH.flow, 0.10);
    ctx.lineWidth = 8 / zoom;
    ctx.stroke(path);
    ctx.strokeStyle = hexA(TH.flow, 0.95);
    ctx.lineWidth = 2.1 / zoom;
    var dash = 6 / zoom, gap = 5.2 / zoom, cycle = dash + gap;
    ctx.setLineDash([dash, gap]);
    ctx.lineDashOffset = -((now * 0.06) % cycle);
    ctx.stroke(path);
    ctx.setLineDash([]);
    ctx.restore();
    drawFlowPacket(run.disp, u, now);
  }

  function drawFlowHop(plan, item, u, now) {
    var hop = item.hop, zoom = S.zoom;
    var path = hop.path;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = hexA(TH.flow, 0.12);
    ctx.lineWidth = 8 / zoom;
    ctx.stroke(path);
    ctx.strokeStyle = hexA(TH.flow, 0.90);
    ctx.lineWidth = 2.1 / zoom;
    var dash = 3.2 / zoom, gap = 3.2 / zoom;
    ctx.setLineDash([dash, gap]);
    ctx.lineDashOffset = -((now * 0.09) % (dash + gap));
    ctx.stroke(path);
    ctx.setLineDash([]);
    ctx.restore();
    drawFlowPacket(hop.pts, u, now);
    ctx.save();
    ctx.strokeStyle = hexA(TH.flow, 0.55 * (1 - u));
    ctx.lineWidth = 1.4 / zoom;
    ctx.beginPath();
    ctx.arc(hop.at.x, hop.at.y, (3.4 + u * 7.5) / zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawFlowHold(plan, item, u, now) {
    var p = item.at, zoom = S.zoom;
    var pulse = (now * 0.0016) % 1;
    var rings = item.first ? 2 : 1;
    ctx.save();
    ctx.lineWidth = 1.4 / zoom;
    for (var i = 0; i < rings; i++) {
      var q = (pulse + i * 0.5) % 1;
      ctx.strokeStyle = hexA(TH.flow, 0.40 * (1 - q));
      ctx.beginPath();
      ctx.arc(p.x, p.y, (3.5 + q * 10) / zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = hexA(TH.flow, 0.85);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.6 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFlow(now) {
    var flow = S.flowPath;
    if (!S.flowOn || !flow || !flow.ok || flow.points.length < 2) return;
    now = now === undefined ? performance.now() : now;
    if (S.flowPlanFor !== flow || S.flowPlanFace !== S.face) {
      S.flowPlan = buildFlowPlan(flow, now);
      S.flowPlanFor = flow;
      S.flowPlanFace = S.face;
      S.flowPlanStart = now;
    }
    var plan = S.flowPlan;
    if (!plan || ((!plan.runs || !plan.runs.length) && (!plan.segments || !plan.segments.length))) return;
    if (REDUCED) {
      if (plan.mode === 'islands') drawFlowIslandBase(plan, { item: { kind: 'idle' } }, now);
      else drawFlowBase(plan, { item: { kind: 'idle' } });
      return;
    }
    var act = flowFrameAt(plan, now - S.flowPlanStart);
    if (plan.mode === 'islands') {
      drawFlowIslandBase(plan, act, now);
      if (act.item.kind === 'seg') drawFlowIslandSeg(plan, act.item, act.u, now);
      else drawFlowHold(plan, act.item, act.u, now);
      return;
    }
    if (!plan.runs || !plan.runs.length) return;
    drawFlowBase(plan, act);
    if (act.item.kind === 'run') drawFlowRun(plan, act.item, act.u, now);
    else if (act.item.kind === 'hop') drawFlowHop(plan, act.item, act.u, now);
    else drawFlowHold(plan, act.item, act.u, now);
  }

  function drawEndMark(end, sign, color) {
    if (!end || !end.cell) return;
    var f = S.frame;
    var p = G.cellOnFace(S.doc, f, S.face, end.cell);
    var r = S.doc.params.cellD / 2;
    var same = end.face === S.face;
    var zoom = S.zoom;
    ctx.save();
    ctx.globalAlpha = same ? 1 : 0.55;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 2.6 / zoom, 0, Math.PI * 2);
    ctx.fillStyle = hexA(color, 0.12);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4 / zoom;
    if (!same) ctx.setLineDash([3 / zoom, 2.4 / zoom]);
    ctx.stroke();
    ctx.setLineDash([]);

    var label = sign === '+' ? 'PACK +' : 'PACK \u2212';
    var fs = Math.max(6 / zoom, 1.75);
    ctx.font = '600 ' + fs + 'px "Segoe UI", sans-serif';
    var tw = ctx.measureText(label).width + 3.2 / zoom;
    var th = fs * 1.65;
    var tx = p.x + r * 0.35;
    var ty = p.y - r - th - 2.2 / zoom;
    if (ty < 1 / zoom) ty = p.y + r + 2.2 / zoom;
    ctx.fillStyle = color;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, th, th * 0.35);
      ctx.fill();
    } else {
      ctx.fillRect(tx, ty, tw, th);
    }
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, tx + tw / 2, ty + th / 2 + 0.15);
    ctx.restore();
  }

  function drawEnds(now) {
    var flow = S.flowPath;
    if (!flow) return;
    drawEndMark(flow.neg, '\u2212', TH.endNeg);
    drawEndMark(flow.pos, '+', TH.endPos);

    /* a slow halo on each tab, only while the path is live: the ends are the
       two places the eye needs to find first */
    if (!REDUCED && S.flowOn && flow.neg && flow.pos) {
      var phase = ((now === undefined ? performance.now() : now) % 1700) / 1700;
      var e = 1 - Math.pow(1 - phase, 2);
      var f = S.frame || (S.frame = G.frameOf(S.doc));
      var r = S.doc.params.cellD / 2;
      var zoom = S.zoom;
      [['neg', TH.endNeg], ['pos', TH.endPos]].forEach(function (pair) {
        var end = flow[pair[0]];
        if (!end) return;
        var p = G.cellOnFace(S.doc, f, S.face, end.cell);
        ctx.save();
        ctx.globalAlpha = 0.34 * (1 - e);
        ctx.strokeStyle = pair[1];
        ctx.lineWidth = 1.7 / zoom;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 2.5 / zoom + e * 9 / zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });
    }
  }

  /* How often the exact face is re-traced during a stroke. The first frames
     show the wet preview immediately; the gap then follows the last build's
     cost, so a 98-cell pack catches up every frame or two while a slow pack
     leaves the wet preview in place. */
  function paintPreviewDue(now) {
    var wet = S.wet;
    if (!wet || wet.builtGen === wet.gen) return false;
    if (now - wet.lastBuild < wet.gap) return false;
    var t0 = performance.now();
    S.sheets[S.face] = null;
    try {
      ensureSheet(S.face);
    } catch (e) {
      S.sheets[S.face] = null;
      return false;
    }
    wet.builtGen = wet.gen;
    wet.lastBuild = performance.now();
    var cost = wet.lastBuild - t0;
    /* past this point the exact trace is the thing that would drop the frame;
       the wet preview is already on screen, so let it carry the stroke and do
       the exact both-face build once, on release */
    wet.gap = cost > 30 ? 1e9 : Math.max(16, Math.round(cost * 1.8));
    return true;
  }

  /* The exact sheet is stale for the islands this stroke has touched. Hide
     those islands and draw their current pads and straps instead: one capsule
     per primitive, all in the same Path2D, then filled once. Overlapping pads
     and straps become a single silhouette instead of a patchwork of
     translucent circles, and no contour is needed, which is what keeps the
     preview cheap on a large island. It is deliberately a little translucent,
     so it reads as wet paint. */
  function addCapsule(path, x1, y1, x2, y2, r) {
    var dx = x2 - x1, dy = y2 - y1;
    if (dx * dx + dy * dy < 1e-8) {
      path.moveTo(x1 + r, y1);
      path.arc(x1, y1, r, 0, Math.PI * 2);
      return;
    }
    var a = Math.atan2(dy, dx);
    var nx = Math.cos(a + Math.PI / 2) * r;
    var ny = Math.sin(a + Math.PI / 2) * r;
    path.moveTo(x1 + nx, y1 + ny);
    path.lineTo(x2 + nx, y2 + ny);
    path.arc(x2, y2, r, a + Math.PI / 2, a - Math.PI / 2, true);
    path.lineTo(x1 - nx, y1 - ny);
    path.arc(x1, y1, r, a - Math.PI / 2, a + Math.PI / 2, true);
    path.closePath();
  }

  function wetPrimPath(isl) {
    var pts = islandPts(S.face, isl);
    var path = new Path2D();
    if (!pts.length) return path;
    var prims = G.islandPrimitives(pts, S.doc.params);
    for (var k = 0; k < prims.length; k++) {
      var q = prims[k];
      addCapsule(path, q.x1, q.y1, q.x2, q.y2, q.r);
    }
    return path;
  }

  function drawWetIslands() {
    var wet = S.wet;
    if (!wet) return;
    var list = S.doc.islands[S.face] || [];
    for (var i = 0; i < list.length; i++) {
      var isl = list[i];
      if (!wet.changed[isl.id]) continue;
      var path = wetPrimPath(isl);
      ctx.save();
      ctx.globalAlpha = isl.id === S.sel ? TH.fillSelA + 0.06 : TH.fillA;
      ctx.fillStyle = isl.color || '#8b98a9';
      ctx.fill(path);
      ctx.restore();
    }
  }

  /* The trail makes the direction of the stroke legible even when a cell was
     already in the island and its metal did not change: a quiet accent line
     through the cells the pointer has painted or erased, a small dot on each,
     and one big ring on the newest. Erased cells keep a red cross because
     their metal is already gone from the preview. The line only bridges small
     gaps, so a jump across the sheet does not draw a false run. */
  function drawWetTrail(now) {
    var wet = S.wet;
    if (!wet || !wet.trail.length) return;
    var f = S.frame, r = S.doc.params.cellD / 2, zoom = S.zoom;
    var from = Math.max(0, wet.trail.length - 24);
    var pts = [];
    for (var i = from; i < wet.trail.length; i++) {
      var e = wet.trail[i];
      var c = findCell(e.id);
      if (!c) continue;
      var p = G.cellOnFace(S.doc, f, S.face, c);
      pts.push({ x: p.x, y: p.y, kind: e.kind, at: i });
    }
    if (!pts.length) return;
    var maxGap = S.doc.params.pitch * 3.2;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    /* the run itself: a quiet line with a dot on every cell, never a ring on
       every cell - the exact metal already shows what has been painted, and
       rings on all of them would make one island look like a string of beads */
    ctx.strokeStyle = TH.accent;
    ctx.fillStyle = TH.accent;
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 1.15 / zoom;
    ctx.beginPath();
    var pen = false;
    for (i = 0; i < pts.length; i++) {
      if (!i || Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) > maxGap) {
        pen = false;
      }
      if (!pen) { ctx.moveTo(pts[i].x, pts[i].y); pen = true; }
      else ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
    for (i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, 1.35 / zoom, 0, Math.PI * 2);
      ctx.fill();
    }
    /* only the cell under the pointer wears the big ring: it answers "where am
       I now" without leaving a row of circles behind */
    var last = pts[pts.length - 1];
    var pulse = REDUCED ? 1 : 1 + 0.11 * Math.sin(now / 140);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = last.kind === 'erase' ? TH.pick : TH.accent;
    ctx.lineWidth = 2.1 / zoom;
    ctx.beginPath();
    ctx.arc(last.x, last.y, (r + 4.2 / zoom) * pulse, 0, Math.PI * 2);
    ctx.stroke();
    /* erased cells are gone from the preview, so each still gets a small red
       cross - otherwise the only sign would be a gap in the metal */
    ctx.strokeStyle = TH.pick;
    ctx.lineWidth = 1.35 / zoom;
    for (i = 0; i < pts.length; i++) {
      if (pts[i].kind !== 'erase') continue;
      var d = (r + 2.4 / zoom) * 0.55;
      ctx.beginPath();
      ctx.moveTo(pts[i].x - d, pts[i].y - d);
      ctx.lineTo(pts[i].x + d, pts[i].y + d);
      ctx.moveTo(pts[i].x + d, pts[i].y - d);
      ctx.lineTo(pts[i].x - d, pts[i].y + d);
      ctx.stroke();
    }
    ctx.restore();
  }

  function hexA(hex, a) {
    var h = hex.replace('#', '');
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ------------------------------------------------------------------ */
  /* panels                                                              */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* canvas furniture                                                    */
  /* ------------------------------------------------------------------ */

  function updateInspector() {
    var el = $('inspector');
    if (!el) return;
    if (!S.hover || !S.doc.cells.length) { el.classList.remove('show'); return; }
    var c = S.hover;
    var n = cellIndex(c.id) + 1;
    if (n < 1) { el.classList.remove('show'); return; }
    var isl = islandAt(S.face, c.id);
    var pol = G.polarityOnFace(c, S.face);
    $('insName').textContent = 'Cell ' + n;
    $('insPol').textContent = pol;
    $('insPol').className = pol === '+' ? 'plus' : 'minus';
    var ys = rowsOf(S.doc), tol = rowTol(), row = '?';
    for (var i = 0; i < ys.length; i++) if (Math.abs(c.y - ys[i]) <= tol) { row = i + 1; break; }
    $('insMeta').textContent = (isl ? isl.name : 'no island') + '  \u00b7  ' +
      faceShort(S.face) + '  \u00b7  row ' + row + '  \u00b7  ' +
      c.x.toFixed(1) + ', ' + c.y.toFixed(1) + ' mm';
    $('insDot').style.background = isl ? isl.color : 'var(--dim)';
    $('insDot').style.boxShadow = '0 0 8px ' + (isl ? isl.color : 'transparent');
    el.classList.add('show');
  }

  function syncToolbar() {
    var u = $('btnUndo'), r = $('btnRedo');
    if (u) {
      u.disabled = !HISTORY.length;
      u.title = HISTORY.length
        ? 'Undo (Ctrl+Z) - ' + HISTORY.length + (HISTORY.length === 1 ? ' step' : ' steps') + ' available'
        : 'Nothing to undo yet';
    }
    if (r) {
      r.disabled = !FUTURE.length;
      r.title = FUTURE.length
        ? 'Redo (Ctrl+Shift+Z) - ' + FUTURE.length + (FUTURE.length === 1 ? ' step' : ' steps') + ' available'
        : 'Nothing to redo';
    }
    var g = $('btnGrid');
    if (g) {
      g.classList.toggle('on', S.grid);
      g.setAttribute('aria-pressed', S.grid ? 'true' : 'false');
    }
    var m = $('btnMini');
    if (m) {
      m.classList.toggle('on', S.mini);
      m.setAttribute('aria-pressed', S.mini ? 'true' : 'false');
    }
    var l = $('btnLeft');
    if (l) {
      l.classList.toggle('on', S.leftOpen);
      l.setAttribute('aria-pressed', S.leftOpen ? 'true' : 'false');
    }
    var rr = $('btnRight');
    if (rr) {
      rr.classList.toggle('on', S.rightOpen);
      rr.setAttribute('aria-pressed', S.rightOpen ? 'true' : 'false');
    }
    syncZoomLabel();
  }

  function setGrid(on) {
    S.grid = !!on;
    saveUi();
    syncToolbar();
    S.dirty = true;
    toast(S.grid ? '10 mm guide grid on' : 'Guide grid off');
  }

  function setMini(on) {
    S.mini = !!on;
    if (mini) mini.hidden = !S.mini;
    saveUi();
    syncToolbar();
    if (S.mini) { resizeMini(); S.dirty = true; }
    toast(S.mini ? 'Minimap shown' : 'Minimap hidden');
  }

  /* Hiding a panel is a view choice, not a document edit: keep the point in
     the middle of the canvas where it was while the stage grows or shrinks. */
  function setPanel(side, on) {
    var key = side + 'Open';
    if (S[key] === !!on) return;
    var centre = viewCenterSheet();
    S[key] = !!on;
    var app = $('app');
    if (app) app.classList.toggle('no-' + side, !S[key]);
    saveUi();
    syncToolbar();
    setTimeout(function () {
      resize();
      resizeMini();
      centerViewOn(centre, false);
    }, 340);
  }

  function toggleTheme() {
    applyTheme(S.theme === 'day' ? 'midnight' : 'day', true);
    saveUi();
  }

  /* ------------------------------------------------------------------ */
  /* layers: help, command palette, toasts                               */
  /* ------------------------------------------------------------------ */

  var layerTimers = {};
  function openLayer(el, focus) {
    if (!el) return;
    if (layerTimers[el.id]) { clearTimeout(layerTimers[el.id]); layerTimers[el.id] = null; }
    el.hidden = false;
    if (focus && focus.focus) { try { focus.focus(); } catch (e) { } }
    requestAnimationFrame(function () { el.classList.add('show'); });
  }

  function closeLayer(el) {
    if (!el || el.hidden) return;
    el.classList.remove('show');
    layerTimers[el.id] = setTimeout(function () { el.hidden = true; layerTimers[el.id] = null; }, 190);
  }

  function helpOpen() { return $('helpModal') && !$('helpModal').hidden; }

  /* Keep Tab inside a modal rather than letting it wander into the canvas
     behind a dialog. */
  function trapTab(ev, root) {
    var nodes = root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.disabled && n.offsetParent !== null) list.push(n);
    }
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault(); last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault(); first.focus();
    }
  }
  function setHelp(on) {
    if (on) openLayer($('helpModal'), $('helpClose'));
    else closeLayer($('helpModal'));
  }

  function commandItems() {
    function act(fn) { return fn; }
    return [
      { label: 'Undo', hint: 'Ctrl Z', run: act(undo) },
      { label: 'Redo', hint: 'Ctrl Shift Z', run: act(redo) },
      { label: 'Fit the sheet to the window', hint: 'G', run: act(fitViewAnimated) },
      { label: 'Zoom in', hint: '+', run: act(function () { zoomAt(1.25); }) },
      { label: 'Zoom out', hint: '-', run: act(function () { zoomAt(0.8); }) },
      { label: 'Zoom to 100% (1:1)', hint: '', run: act(function () { setZoomPercent(100); }) },
      { label: 'Toggle the 10 mm grid', hint: '', run: act(function () { setGrid(!S.grid); }) },
      { label: 'Toggle the minimap', hint: '', run: act(function () { setMini(!S.mini); }) },
      { label: 'Toggle the midnight / daylight theme', hint: '', run: act(toggleTheme) },
      { label: 'Show or hide the left panel', hint: '[', run: act(function () { setPanel('left', !S.leftOpen); }) },
      { label: 'Show or hide the right panel', hint: ']', run: act(function () { setPanel('right', !S.rightOpen); }) },
      { label: 'Fill the grid from the Cells panel', hint: '', keywords: 'layout new pack cells', run: act(function () { $('btnFill').click(); }) },
      { label: 'Empty the pack', hint: '', keywords: 'clear delete all', run: act(function () { $('btnClear').click(); }) },
      { label: 'Auto stripe the islands', hint: '', keywords: 'design auto series', run: act(function () { $('btnStripe').click(); }) },
      { label: 'Turn the pack clockwise', hint: 'R', keywords: 'rotate turn', run: act(function () { rotateLayout(true); }) },
      { label: 'Turn the pack anticlockwise', hint: '', keywords: 'rotate turn', run: act(function () { rotateLayout(false); }) },
      { label: 'Add a row', hint: '', keywords: 'cells row grow', run: act(function () { $('btnRowAdd').click(); }) },
      { label: 'Remove the bottom row', hint: '', keywords: 'cells row shrink', run: act(function () { $('btnRowDel').click(); }) },
      { label: 'Look at the TOP sheet', hint: 'T', keywords: 'face', run: act(function () { setFace('top'); }) },
      { label: 'Look at the BOTTOM sheet', hint: 'B', keywords: 'face mirror', run: act(function () { setFace('bottom'); }) },
      { label: 'See the other sheet through', hint: 'X', keywords: 'ghost view', run: act(function () { setGhost(!S.ghost); }) },
      { label: 'Show or hide the current flow', hint: 'C', keywords: 'path ends', run: act(function () { setFlow(!S.flowOn); }) },
      { label: 'Cut a solid plate', hint: '', keywords: 'style cut', run: act(function () { setCut('plate'); }) },
      { label: 'Cut to the weld lines', hint: '', keywords: 'style strip slot', run: act(function () { setCut('lines'); }) },
      { label: 'Toggle the cell guide slits', hint: '', keywords: 'mark cut', run: act(function () { setGuides(!S.doc.params.guides); }) },
      { label: 'Add a new island on this face', hint: '', keywords: 'group paint', run: act(function () { snapshot(); addIsland(S.face); renderPalette(); rebuildAll(); }) },
      { label: 'Delete the selected group', hint: 'I', keywords: 'island remove', run: act(function () { $('btnRmGroup').click(); }) },
      { label: 'Clear every island on this face', hint: '', keywords: 'island remove all', run: act(function () { $('btnClearFace').click(); }) },
      { label: 'Export both sheets as SVG', hint: '', keywords: 'download cut file', run: act(function () { exportSheets('svg', 'both'); }) },
      { label: 'Export both sheets as DXF', hint: '', keywords: 'download cut file', run: act(function () { exportSheets('dxf', 'both'); }) },
      { label: 'Export the TOP sheet as SVG', hint: '', keywords: 'download cut file', run: act(function () { exportSheets('svg', 'top'); }) },
      { label: 'Export the BOTTOM sheet as SVG', hint: '', keywords: 'download cut file', run: act(function () { exportSheets('svg', 'bottom'); }) },
      { label: 'Export the TOP sheet as DXF', hint: '', keywords: 'download cut file', run: act(function () { exportSheets('dxf', 'top'); }) },
      { label: 'Export the BOTTOM sheet as DXF', hint: '', keywords: 'download cut file', run: act(function () { exportSheets('dxf', 'bottom'); }) },
      { label: 'Export the assembly map', hint: '', keywords: 'print pdf', run: act(function () { $('btnPrint').click(); }) },
      { label: 'Export a design report (Markdown)', hint: '', keywords: 'document summary checks', run: act(exportReport) },
      { label: 'Export a PNG of this view', hint: '', keywords: 'image download', run: act(exportPNG) },
      { label: 'Copy the document JSON', hint: '', keywords: 'clipboard share save', run: act(copyJSON) },
      { label: 'Save the document as .json', hint: '', keywords: 'download file', run: act(function () { $('btnSave').click(); }) },
      { label: 'Load a .json document', hint: '', keywords: 'open import file', run: act(function () { $('btnLoad').click(); }) },
      { label: 'Keyboard shortcuts and help', hint: '?', run: act(function () { setHelp(true); }) }
    ];
  }

  function cmdSearch(q) {
    q = (q || '').trim().toLowerCase();
    var all = commandItems();
    if (!q) return all;
    var parts = q.split(/\s+/);
    return all.filter(function (it) {
      var hay = (it.label + ' ' + (it.keywords || '') + ' ' + (it.hint || '')).toLowerCase();
      return parts.every(function (p) { return hay.indexOf(p) >= 0; });
    });
  }

  function renderCmd() {
    var ul = $('cmdList');
    if (!ul) return;
    ul.innerHTML = '';
    S.cmd.items = cmdSearch($('cmdInput').value);
    if (S.cmd.index >= S.cmd.items.length) S.cmd.index = Math.max(0, S.cmd.items.length - 1);
    if (!S.cmd.items.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No command matches that.';
      ul.appendChild(empty);
      return;
    }
    S.cmd.items.forEach(function (it, i) {
      var li = document.createElement('li');
      li.className = i === S.cmd.index ? 'sel' : '';
      li.setAttribute('role', 'option');
      li.innerHTML = '<span>' + esc(it.label) + '</span>' +
                     (it.hint ? '<span class="ck">' + esc(it.hint) + '</span>' : '');
      li.onmouseenter = function () {
        S.cmd.index = i;
        Array.prototype.forEach.call(ul.children, function (x, j) { x.classList.toggle('sel', j === i); });
      };
      li.onclick = function () { runCmd(i); };
      ul.appendChild(li);
    });
    var sel = ul.children[S.cmd.index];
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  function openCmd() {
    S.cmd.open = true;
    S.cmd.index = 0;
    $('cmdInput').value = '';
    openLayer($('paletteModal'), $('cmdInput'));
    renderCmd();
  }

  function closeCmd() {
    S.cmd.open = false;
    closeLayer($('paletteModal'));
  }

  function runCmd(i) {
    var it = S.cmd.items[i];
    if (!it) return;
    closeCmd();
    setTimeout(function () { it.run(); }, 20);
  }

  function updatePanels() {
    /* picks can outlive the cells they point at - fill grid, empty, undo, a
       loaded file - so the bar is rebuilt from cells that actually exist */
    if (S.pick.size) {
      var live = new Set();
      for (var lp = 0; lp < S.doc.cells.length; lp++) live.add(S.doc.cells[lp].id);
      S.pick.forEach(function (id) { if (!live.has(id)) S.pick.delete(id); });
    }
    selBar();
    var f = S.frame || G.frameOf(S.doc);
    $('sSize').textContent = f.W.toFixed(1) + ' x ' + f.H.toFixed(1) + ' mm';
    $('sCells').textContent = S.doc.cells.length;
    var plus = 0;
    for (var q = 0; q < S.doc.cells.length; q++) if (!S.doc.cells[q].flip) plus++;
    $('sPol').textContent = plus + ' + / ' + (S.doc.cells.length - plus) + ' \u2212';
    var faceIslands = S.doc.islands[S.face];
    $('sIslands').textContent = faceIslands.length;
    var area = 0;
    ['top', 'bottom'].forEach(function (fc) {
      var sh = S.sheets[fc];
      if (sh) sh.islands.forEach(function (i) { area += i.area; });
    });
    $('sArea').textContent = (area / 100).toFixed(1) + ' cm2';
    $('sTime').textContent = S.buildMs + ' ms';
    if ($('islandCount')) $('islandCount').textContent = faceIslands.length;
    var ft = $('faceTag');
    if (ft) {
      ft.textContent = S.face === 'top' ? 'TOP' : 'BOTTOM';
      ft.title = S.face === 'top' ? 'Editing the top sheet' : 'Editing the mirrored bottom sheet';
    }

    var ul = $('islands');
    ul.innerHTML = '';
    faceIslands.forEach(function (isl) {
      var li = document.createElement('li');
      li.className = S.sel === isl.id ? 'sel' : '';
      li.innerHTML = '<span class="sw" style="background:' + isl.color + '"></span>' +
                     '<span class="nm">' + esc(isl.name) + '</span>' +
                     '<span class="ct">' + isl.cells.length + '</span>' +
                     '<span class="x" title="delete this island (the cells stay in the pack)">&times;</span>';
      li.onclick = function (ev) {
        if (ev.target.classList.contains('x')) {
          snapshot();
          deleteIsland(S.face, isl.id);
        } else {
          selectIsland(isl.id);
        }
      };
      var sw = li.querySelector('.sw');
      if (sw) {
        sw.title = 'Click to put this piece in the next unused colour';
        sw.onclick = function (ev) {
          ev.stopPropagation();
          cycleIslandColor(S.face, isl.id);
        };
      }
      li.onmouseenter = function () { S.hiIsland = isl.id; S.dirty = true; };
      li.onmouseleave = function () { if (S.hiIsland === isl.id) S.hiIsland = null; S.dirty = true; };
      li.ondblclick = function (ev) {
        if (ev.target.classList.contains('x') || ev.target.classList.contains('sw')) return;
        ev.stopPropagation();
        zoomToIsland(S.face, isl.id);
      };
      li.title = isl.name + ' - ' + isl.cells.length + ' cells; double-click to zoom to it';
      ul.appendChild(li);
    });
    if (!faceIslands.length) {
      var none = document.createElement('li');
      none.className = 'note';
      none.textContent = 'No islands on the ' + S.face + ' sheet.';
      ul.appendChild(none);
    }

    var checks = $('checks');
    checks.innerHTML = '';
    var rank = { error: 0, warn: 1, info: 2 };
    var sorted = S.drc.slice().sort(function (a, b) {
      return (rank[a.level] || 0) - (rank[b.level] || 0);
    });
    var errs = sorted.filter(function (d) { return d.level === 'error'; });
    var warns = sorted.filter(function (d) { return d.level === 'warn'; });
    var infos = sorted.filter(function (d) { return d.level === 'info'; });
    var cc = $('checkCount');
    if (cc) {
      cc.textContent = sorted.length;
      cc.className = 'badge' + (errs.length ? ' bad' : warns.length ? ' warn' : '');
      cc.title = sorted.length
        ? errs.length + ' error(s), ' + warns.length + ' warning(s), ' + infos.length + ' note(s)'
        : 'No problems';
    }
    var shorts = sorted.filter(function (d) { return d.kind === 'short'; });
    var elecErr = sorted.filter(function (d) {
      return d.level === 'error' && (d.kind === 'short' || d.kind === 'net' || d.kind === 'flow');
    });
    var elecWarn = sorted.filter(function (d) {
      return d.level === 'warn' && (d.kind === 'short' || d.kind === 'net' || d.kind === 'flow');
    });
    var hs = $('healthStrip');
    if (hs) {
      if (errs.length) {
        hs.className = 'health bad';
        $('hIco').textContent = '!';
        $('hTitle').textContent = errs.length + (errs.length === 1 ? ' error' : ' errors') +
          (warns.length ? ' \u00b7 ' + warns.length + ' warning' + (warns.length === 1 ? '' : 's') : '');
        $('hSub').textContent = 'Fix these before you cut the sheet.';
        hs.title = errs[0].text;
      } else if (warns.length) {
        hs.className = 'health warn';
        $('hIco').textContent = '!';
        $('hTitle').textContent = warns.length + (warns.length === 1 ? ' warning' : ' warnings');
        $('hSub').textContent = 'The sheets still export; check the list below.';
        hs.title = warns[0].text;
      } else if (infos.length) {
        hs.className = 'health ok';
        $('hIco').textContent = 'i';
        $('hTitle').textContent = 'No faults';
        $('hSub').textContent = infos.length + (infos.length === 1 ? ' note' : ' notes') +
          ' \u00b7 design information, nothing to fix.';
        hs.title = infos[0].text;
      } else {
        hs.className = 'health ok';
        $('hIco').textContent = '\u2713';
        $('hTitle').textContent = 'All clear';
        $('hSub').textContent = 'No electrical or geometry problems.';
        hs.title = '';
      }
    }

    var net = $('sNet');
    if (shorts.length) {
      net.textContent = shorts.length + (shorts.length === 1 ? ' short' : ' shorts');
      net.className = 'v bad';
    } else if (elecErr.length) {
      net.textContent = elecErr.length + (elecErr.length === 1 ? ' fault' : ' faults');
      net.className = 'v bad';
    } else if (elecWarn.length) {
      net.textContent = elecWarn.length + (elecWarn.length === 1 ? ' warning' : ' warnings');
      net.className = 'v warn';
    } else {
      net.textContent = 'no shorts';
      net.className = 'v ok';
    }
    var t = S.doc.terminals || { neg: null, pos: null };
    function endLabel(term) {
      if (!term) return '-';
      var n = termCellLabel(term);
      return faceShort(termFace(term)) + ' ' + (n || '?');
    }
    $('sEnds').textContent = (t.neg ? '\u2212 ' + endLabel(t.neg) : '\u2212 -') +
      ' / ' + (t.pos ? '+ ' + endLabel(t.pos) : '+ -');
    $('sPath').textContent = S.flowPath && S.flowPath.ok
      ? S.flowPath.cells.length + (S.flowPath.cells.length === 1 ? ' cell' : ' cells')
      : (t.neg && t.pos ? 'open' : '-');
    paintFlowPanel();
    if (!sorted.length) {
      checks.innerHTML = '<li class="check"><span class="dot" style="background:#7bd88f"></span><span class="ok">No electrical or geometry problems.</span></li>';
    }
    var LIMIT = 16;
    sorted.slice(0, LIMIT).forEach(function (d) {
      var li = document.createElement('li');
      li.className = 'check';
      var col = d.level === 'error' ? '#ef6b6b' : d.level === 'warn' ? '#ffb74d' : '#8b98a9';
      li.innerHTML = '<span class="dot" style="background:' + col + '"></span>' +
                     '<span class="' + d.level + '">' + esc(d.text) + '</span>';
      checks.appendChild(li);
    });
    if (sorted.length > LIMIT) {
      var more = document.createElement('li');
      more.className = 'note';
      more.textContent = (sorted.length - LIMIT) + ' more check(s) - fix these first.';
      checks.appendChild(more);
    }
    if (!errs.length && warns.length) {
      var li2 = document.createElement('li');
      li2.className = 'note';
      li2.textContent = warns.length + ' warning(s) - the sheets still export.';
      checks.appendChild(li2);
    } else if (!errs.length && !warns.length && infos.length) {
      var li3 = document.createElement('li');
      li3.className = 'note';
      li3.textContent = infos.length + ' note(s) - design information, nothing to fix.';
      checks.appendChild(li3);
    }
    renderRows();
    updateInspector();
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* the palette chip and the island list are two views of the same choice, so
     both are repainted whenever it changes */
  function selectIsland(id) {
    S.sel = id;
    renderPalette();
    var lis = $('islands') ? $('islands').children : [];
    for (var i = 0; i < lis.length; i++) lis[i].classList.remove('sel');
    var list = S.doc.islands[S.face] || [];
    for (var j = 0; j < list.length && j < lis.length; j++) {
      if (list[j].id === id) lis[j].classList.add('sel');
    }
    S.dirty = true;
  }

  /* A colour is only a label, but on a fourteen-piece pack the labels are how
     you talk about the design. Clicking a swatch steps to the next colour that
     no other piece is using, so two groups can always be told apart. */
  function cycleIslandColor(face, id) {
    var isl = islandById(face, id);
    if (!isl) return;
    var used = {};
    ['top', 'bottom'].forEach(function (f) {
      (S.doc.islands[f] || []).forEach(function (x) {
        if (x !== isl) used[x.color] = 1;
      });
    });
    var at = PALETTE.indexOf(isl.color);
    var pick = null;
    for (var k = 1; k <= PALETTE.length; k++) {
      var c = PALETTE[(at + k + PALETTE.length) % PALETTE.length];
      if (!used[c]) { pick = c; break; }
    }
    if (!pick) pick = PALETTE[(at + 1 + PALETTE.length) % PALETTE.length];
    snapshot();
    isl.color = pick;
    rebuildAll();
    renderPalette();
    S.dirty = true;
    toast((isl.name || 'Island') + ' is now ' + pick);
  }

  function renderPalette() {
    var p = $('palette');
    p.innerHTML = '';
    S.doc.islands[S.face].forEach(function (isl) {
      var b = document.createElement('div');
      b.className = 'chip' + (S.sel === isl.id ? ' on' : '');
      b.style.background = isl.color;
      b.innerHTML = '<span class="n">' + isl.cells.length + '</span>';
      b.onclick = function () { selectIsland(isl.id); };
      b.onmouseenter = function () { S.hiIsland = isl.id; S.dirty = true; };
      b.onmouseleave = function () { if (S.hiIsland === isl.id) S.hiIsland = null; S.dirty = true; };
      b.ondblclick = function () { zoomToIsland(S.face, isl.id); };
      b.title = isl.name + ' - ' + isl.cells.length + ' cells; double-click to zoom to it';
      p.appendChild(b);
    });
    var add = document.createElement('div');
    add.className = 'chip';
    add.style.background = 'var(--panel2)';
    add.style.color = 'var(--dim)';
    add.textContent = '+';
    add.title = 'new island';
    add.onclick = function () { snapshot(); addIsland(S.face); renderPalette(); rebuildAll(); };
    p.appendChild(add);

    /* the counterpart of the + chip: it takes the group that is selected, the
       one ringed in white. With nothing selected there is nothing to take, so
       the chip is greyed out and says why rather than deleting something else */
    var del = document.createElement('div');
    del.id = 'chipDel';
    del.className = 'chip del';
    del.style.background = 'var(--panel2)';
    del.style.color = 'var(--dim)';
    del.textContent = '\u2212';
    del.onclick = function () {
      if (!S.sel) { toast('Select a group first - click one of the coloured groups'); return; }
      snapshot();
      deleteIsland(S.face, S.sel);
    };
    p.appendChild(del);
    syncGroupControls();
  }

  /* Remove group has to know whether there is anything to remove. The
     selection changes in a dozen places - a new face, a deleted island, undo,
     a load - and not all of them repaint the palette, so this reads the live
     document instead of trusting whatever the last repaint saw. */
  function syncGroupControls() {
    var target = S.sel ? islandById(S.face, S.sel) : null;
    if (S.sel && !target) S.sel = null;     /* the selected group is gone */
    var del = $('chipDel');
    if (del) {
      del.classList.toggle('off', !target);
      del.title = target
        ? 'delete the selected group, ' + target.name + ' (' + target.cells.length + ' cells)'
        : 'select a group first';
    }
    var rmg = $('btnRmGroup');
    if (rmg) {
      rmg.classList.toggle('off', !target);
      rmg.title = target
        ? 'Delete the selected group, ' + target.name + ' (' + target.cells.length + ' cells) - the cells stay in the pack'
        : 'Select a group first';
    }
    var rmn = $('rmGroupNote');
    if (rmn) {
      rmn.innerHTML = target
        ? '<b>' + esc(target.name) + '</b> is selected (' + target.cells.length + ' cells). <b>Remove group</b> deletes it; its cells stay in the pack. <b>Ctrl+Z</b> puts it back.'
        : 'Click a coloured group to select it, then <b>Remove group</b> (<b>&minus;</b> beside the <b>+</b>, or <b>I</b>) deletes it. Its cells stay in the pack.';
    }
  }

  /* ------------------------------------------------------------------ */
  /* export                                                              */
  /* ------------------------------------------------------------------ */

  function download(name, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function baseName() {
    return (S.doc.name || 'pack').replace(/[^\w\-]+/g, '_');
  }

  function exportSheets(kind, which) {
    rebuildAll();
    var sheets = which === 'top' ? [S.sheets.top] : which === 'bottom' ? [S.sheets.bottom] : [S.sheets.top, S.sheets.bottom];
    if (kind === 'svg') {
      download(baseName() + (which === 'both' ? '' : '-' + which) + '.svg', G.toSVG(sheets), 'image/svg+xml');
    } else {
      download(baseName() + (which === 'both' ? '' : '-' + which) + '.dxf', G.toDXF(sheets), 'application/dxf');
    }
    toast(kind.toUpperCase() + ' written - ' + sheets.length + ' sheet(s)');
  }

  function downloadBlob(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  /* A picture of what is on screen, at the device pixel ratio the canvas is
     already rendering, is the fastest way to put a layout in a message. */
  function exportPNG() {
    rebuildAll();
    S.anim = [];        /* a still picture should not catch a half-drawn strap */
    var name = baseName() + '-' + S.face + '.png';
    if (!cv.toBlob) { toast('This browser cannot export the canvas'); return; }
    /* Render the same view at twice the CSS resolution: the canvas is a
       vector drawing until the last moment, so the extra pixels are real
       detail rather than an upscaled screenshot. */
    var scale = Math.min(2, 6000 / Math.max(S.vw, S.vh, 1));
    if (scale < 1) scale = 1;
    var cssW = S.vw, cssH = S.vh;
    cv.width = Math.round(cssW * scale);
    cv.height = Math.round(cssH * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    draw(performance.now());
    var pxW = cv.width, pxH = cv.height;
    cv.toBlob(function (blob) {
      resize();
      draw(performance.now());
      S.dirty = true;
      if (!blob) { toast('Could not make the PNG'); return; }
      downloadBlob(name, blob);
      toast('PNG written - ' + pxW + ' x ' + pxH + ' px');
    }, 'image/png');
  }

  /* A written record of the pack is the thing you hand to the person who
     asked for it: the layout, the cut numbers, every piece on both faces and
     the checks that were open when the file was written. */
  function reportText() {
    var p = S.doc.params;
    var f = S.frame || G.frameOf(S.doc);
    var plus = 0, i;
    for (i = 0; i < S.doc.cells.length; i++) if (!S.doc.cells[i].flip) plus++;
    var lines = [];
    function line(s) { lines.push(s === undefined ? '' : s); }
    var name = S.doc.name || 'my pack';

    line('# ' + name + ' - design report');
    line();
    line('_Generated ' + new Date().toISOString().slice(0, 10) + ' by Battery Architect._');
    line();

    line('## Layout');
    line();
    line('| | |');
    line('|---|---|');
    line('| Cells | ' + S.doc.cells.length + ' (' + plus + ' plus-up, ' + (S.doc.cells.length - plus) + ' minus-up) |');
    line('| Cell type | ' + (S.doc.cellType || 'custom') + ', ' +
         (isFinite(p.cellD) ? p.cellD : 21.2).toFixed(1) + ' mm |');
    line('| Packing | ' + (S.doc.arrangement === 'square' ? 'square' : 'staggered') +
         ', gap ' + (isFinite(p.gap) ? p.gap : 0).toFixed(2) + ' mm, pitch ' +
         (isFinite(p.pitch) ? p.pitch : (p.cellD || 0)).toFixed(2) + ' mm |');
    line('| Sheet | ' + f.W.toFixed(1) + ' x ' + f.H.toFixed(1) + ' mm (' + (f.W * f.H / 100).toFixed(1) + ' cm2) |');
    line('| Turn | ' + (((S.doc.rot || 0) % 360 + 360) % 360) + ' degrees |');
    line('| Margin | ' + (isFinite(p.margin) ? p.margin : 8) + ' mm |');
    line();

    line('## Cut');
    line();
    line('| | |');
    line('|---|---|');
    line('| Style | ' + (p.cut === 'lines'
      ? 'weld lines at ' + (isFinite(p.lineAngle) ? p.lineAngle : 90) + ' degrees'
      : 'solid plate') + ' |');
    line('| Pad / strap | ' + (isFinite(p.padD) ? p.padD : 0).toFixed(1) + ' / ' +
         (isFinite(p.bridgeW) ? p.bridgeW : 0).toFixed(1) + ' mm |');
    line('| Kerf | ' + (isFinite(p.kerf) ? p.kerf : 0).toFixed(2) + ' mm |');
    line('| Precision | ' + (isFinite(p.step) ? p.step : 0.1).toFixed(2) + ' mm |');
    line('| Guide slits | ' + (p.guides
      ? 'on - ' + Math.min(p.guideL || 8, G.guideMaxLen(p)).toFixed(1) + ' mm at ' +
        (isFinite(p.lineAngle) ? p.lineAngle : 0) + ' degrees'
      : 'off') + ' |');
    line();

    ['top', 'bottom'].forEach(function (face) {
      var sh = S.sheets[face];
      var label = face === 'top' ? 'Top sheet' : 'Bottom sheet (mirrored)';
      line('## ' + label);
      line();
      var islands = S.doc.islands[face] || [];
      if (!islands.length) {
        line('_No islands on this face._');
        line();
        return;
      }
      var area = sh ? sh.islands.reduce(function (a, s) { return a + (s.area || 0); }, 0) : 0;
      line(islands.length + ' island' + (islands.length === 1 ? '' : 's') +
           ', ' + (area / 100).toFixed(2) + ' cm2 of metal.');
      line();
      line('| Island | Cells | Area (cm2) | Pieces |');
      line('|---|---:|---:|---:|');
      islands.forEach(function (isl) {
        var built = null;
        if (sh) for (var k = 0; k < sh.islands.length; k++) if (sh.islands[k].id === isl.id) built = sh.islands[k];
        line('| ' + (isl.name || isl.id) + ' | ' + isl.cells.length + ' | ' +
             (built ? (built.area / 100).toFixed(2) : '-') + ' | ' +
             (built ? (built.parts || 1) : '-') + ' |');
      });
      line();
    });

    var t = S.doc.terminals || { neg: null, pos: null };
    function endName(term) {
      if (!term) return 'not set';
      return faceShort(termFace(term)) + ' cell ' + (termCellLabel(term) || '?');
    }
    line('## Electrical');
    line();
    line('- Negative end: ' + endName(t.neg));
    line('- Positive end: ' + endName(t.pos));
    line('- Main path: ' + (S.flowPath && S.flowPath.ok
      ? S.flowPath.cells.length + ' series cells, ' + S.flowPath.length.toFixed(0) + ' mm of metal'
      : (t.neg && t.pos ? 'open - no directed path between the ends' : 'not traced')));
    line();

    var rank = { error: 0, warn: 1, info: 2 };
    var checks = (S.drc || []).slice().sort(function (a, b) {
      return (rank[a.level] || 0) - (rank[b.level] || 0);
    });
    line('## Checks');
    line();
    if (!checks.length) {
      line('No electrical or geometry problems.');
    } else {
      checks.forEach(function (d) {
        line('- **' + String(d.level || 'info').toUpperCase() + '** - ' +
             String(d.text || '').replace(/\|/g, '\\|'));
      });
    }
    line();
    line('## Files');
    line();
    line('- ' + baseName() + '.svg / .dxf - both sheets, 1:1 in millimetres');
    line('- ' + baseName() + '-assembly-map.svg - both faces, 1:1 with a legend');
    line('- ' + baseName() + '.json - the editable document');
    line();

    return lines.join('\n');
  }

  function exportReport() {
    rebuildAll();
    download(baseName() + '-report.md', reportText(), 'text/markdown');
    var n = (S.drc || []).length;
    toast('Design report written - ' + n + ' check' + (n === 1 ? '' : 's') + ' listed');
  }

  function copyJSON() {
    var text = JSON.stringify(S.doc, null, 1);
    function done() { toast('Document JSON copied - paste it anywhere'); }
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        if (ok) done(); else toast('Could not copy - use Save .json instead', 'warn');
      } catch (e) {
        toast('Could not copy - use Save .json instead', 'warn');
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  /* ------------------------------------------------------------------ */
  /* autosave                                                            */
  /* ------------------------------------------------------------------ */

  function setSaveState(label, busy) {
    var el = $('saveState');
    if (!el) return;
    el.classList.toggle('saving', !!busy);
    el.innerHTML = '<i></i>' + label;
  }

  var saveSoon = 0;
  function scheduleSave() {
    if (saveSoon) clearTimeout(saveSoon);
    saveSoon = setTimeout(function () { saveSoon = 0; persistDoc(); }, 900);
  }

  function persistDoc(force) {
    if (!S.unsaved && force !== true) { setSaveState('saved', false); return; }
    setSaveState('saving', true);
    try {
      localStorage.setItem('battery-architect.doc', JSON.stringify(S.doc));
      S.unsaved = false;
      setTimeout(function () { if (!S.unsaved) setSaveState('saved', false); }, 220);
    } catch (e) {
      setSaveState('not saved', false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* toast                                                               */
  /* ------------------------------------------------------------------ */

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    if (!t) return;
    if (!kind) kind = /could not|failed|nothing|no |not /i.test(String(msg)) ? 'warn' : '';
    t.className = 'show' + (kind ? ' ' + kind : '');
    t.innerHTML = '<span class="ti" aria-hidden="true"></span>' +
                  '<span class="tm">' + esc(msg) + '</span>' +
                  '<span class="tp"></span>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  /* ------------------------------------------------------------------ */
  /* input                                                               */
  /* ------------------------------------------------------------------ */

  function setFace(face) {
    S.face = face;
    S.hiIsland = null;
    $('btnTop').classList.toggle('on', face === 'top');
    $('btnBottom').classList.toggle('on', face === 'bottom');
    var list = S.doc.islands[face];
    S.sel = list.length ? list[0].id : null;
    renderPalette();
    rebuildAll();
    S.dirty = true;
  }

  /* ------------------------------------------------------------------ */
  /* seeing the other sheet through                                      */
  /*
   * The two sheets are cut separately and welded on opposite ends of the same
   * cells, so the one thing you cannot see while you work on one of them is
   * the other: which cells the far strip already holds, whether the strips
   * alternate or sit directly on top of each other, and whether the far plate
   * reaches a cell you have just left out of this one.
   *
   * The far sheet is built in print coordinates - mirrored in x, because it is
   * cut flat and flipped over - so the mirror is undone when it is drawn: the
   * ghost sits exactly where that metal will lie in the pack, not where it
   * prints. That is the whole difference between a useful overlay and a
   * mirrored one, and it is the reason this reads the built sheet rather than
   * the island list.
   *
   * It is a view option. It is not in the document, not in the exports and not
   * in the undo stack, and it costs nothing while it is off.
   */
  /* ------------------------------------------------------------------ */

  function otherFace() { return S.face === 'top' ? 'bottom' : 'top'; }

  function setGhost(on) {
    S.ghost = !!on;
    $('ghostOther').checked = S.ghost;
    if (S.ghost) {
      ensureSheet(S.face);
      ensureSheet(otherFace());
    }
    S.dirty = true;
    if (!S.ghost) { toast('Only the ' + S.face + ' sheet drawn'); return; }
    var n = (S.doc.islands[otherFace()] || []).length;
    if (!n) { toast('Nothing on the ' + otherFace() + ' sheet to show through'); return; }
    toast((otherFace() === 'top' ? 'Top' : 'Bottom') + ' sheet seen through - ' +
          n + (n === 1 ? ' piece' : ' pieces') + ', dashed');
  }

  function islandAt(face, id) {
    var list = S.doc.islands[face] || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].cells.indexOf(id) >= 0) return list[i];
    }
    return null;
  }

  function paintCursor() {
    cv.style.cursor = S.terminalPick ? 'copy'
      : S.tool === 'paint' ? 'crosshair'
      : S.tool === 'island' ? 'pointer' : 'cell';
  }

  function setTerminalPick(which) {
    S.terminalPick = S.terminalPick === which ? null : which;
    paintFlowPanel();
    paintCursor();
    S.dirty = true;
    if (!S.terminalPick) return;
    toast('Click a pad on the ' + S.face + ' sheet for the ' +
          (which === 'neg' ? '\u2212' : '+') + ' end');
  }

  function cancelTerminalPick() {
    if (!S.terminalPick) return;
    S.terminalPick = null;
    paintFlowPanel();
    paintCursor();
    S.dirty = true;
  }

  function placeTerminal(which, cell) {
    if (!cell) { cancelTerminalPick(); return; }
    if (!islandAt(S.face, cell.id)) {
      toast('Cell ' + (cellIndex(cell.id) + 1) + ' is not in an island on the ' + S.face +
            ' sheet - paint it first');
      return;
    }
    var t = S.doc.terminals || (S.doc.terminals = { neg: null, pos: null });
    var other = which === 'neg' ? 'pos' : 'neg';
    if (t[other] && t[other].face === S.face && t[other].cell === cell.id) {
      toast('The other end is already on that pad');
      return;
    }
    snapshot();
    t[which] = { face: S.face, cell: cell.id };
    S.terminalPick = null;
    paintCursor();
    S.dirty = true;
    rebuildAll();
    toast('Pack ' + (which === 'neg' ? 'negative' : 'positive') + ' end on the ' + S.face +
          ' sheet, cell ' + (cellIndex(cell.id) + 1));
  }

  function clearTerminals() {
    var t = S.doc.terminals || { neg: null, pos: null };
    if (!t.neg && !t.pos) { toast('No pack ends set'); return; }
    snapshot();
    t.neg = t.pos = null;
    S.terminalPick = null;
    paintCursor();
    S.dirty = true;
    rebuildAll();
    toast('Pack ends cleared');
  }

  function setFlow(on) {
    S.flowOn = !!on;
    $('flowOn').checked = S.flowOn;
    S.flowPlanFor = null;
    S.flowPlanStart = performance.now();
    S.dirty = true;
    if (!S.flowOn) { toast('Current flow hidden'); return; }
    if (!S.flowPath || !S.flowPath.ok) toast('Set both ends to draw the current path');
    else toast('Current flow shown - the pulse hops island to island');
  }

  function syncFlowMode() {
    var islands = $('btnFlowIslands'), cells = $('btnFlowCells');
    if (islands) islands.classList.toggle('on', S.flowMode !== 'cells');
    if (cells) cells.classList.toggle('on', S.flowMode === 'cells');
  }

  function setFlowMode(mode, announce) {
    S.flowMode = mode === 'cells' ? 'cells' : 'islands';
    syncFlowMode();
    S.flowPlanFor = null;
    S.flowPlanStart = performance.now();
    S.dirty = true;
    saveUi();
    paintFlowPanel();
    if (announce) {
      toast(S.flowMode === 'cells'
        ? 'Flow route: pad to pad'
        : 'Flow route: island center to island center');
    }
  }

  function polCounts() {
    var plus = 0;
    for (var i = 0; i < S.doc.cells.length; i++) if (!S.doc.cells[i].flip) plus++;
    return plus + ' plus-up, ' + (S.doc.cells.length - plus) + ' minus-up';
  }

  /* turning a cell over changes no geometry at all - only which side its
     terminal faces - so it only has to redraw */
  function flipCell(c) {
    c.flip = !c.flip;
    var fr = S.frame || (S.frame = G.frameOf(S.doc));
    var at = G.cellOnFace(S.doc, fr, S.face, c);
    pushAnim({
      kind: 'flip', face: S.face, x1: at.x, y1: at.y, r: S.doc.params.cellD / 2,
      t0: performance.now(), delay: 0, dur: 320, grow: true
    });
    S.dirty = true;
  }

  /* ------------------------------------------------------------------ */
  /* picking the cells to remove                                         */
  /*
   * A click that deletes is a click you cannot look at before it happens,
   * and a group of cells - a vent, a BMS window, a corner to clear - cannot
   * be taken out in one go. So Remove picks: the cells are ringed in red and
   * stay in the pack until Remove or Del confirms, one undo step for the lot.
   * Dragging on the bare sheet draws a box and picks everything it covers,
   * showing the count as it grows.
   */
  /* ------------------------------------------------------------------ */

  /* the little bar is the only place that says how many cells are picked, so
     every path that touches the set goes through here */
  function selBar() {
    var n = S.pick.size;
    var bar = $('selBar');
    if (n > 0) $('selCount').textContent = n;
    bar.classList.toggle('show', S.tool === 'delete' && n > 0);
  }

  function pickCell(id, add) {
    if (add || !S.pick.has(id)) S.pick.add(id);
    else S.pick.delete(id);
    selBar();
    S.dirty = true;
  }

  function unpick() {
    if (!S.pick.size && !S.marquee) return;
    S.pick.clear();
    S.marquee = null;
    selBar();
    S.dirty = true;
  }

  /* the cells whose centre falls inside the rubber band */
  function marqueeCells(m) {
    var f = S.frame || (S.frame = G.frameOf(S.doc));
    var x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
    var y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    var out = [];
    for (var i = 0; i < S.doc.cells.length; i++) {
      var p = G.cellOnFace(S.doc, f, S.face, S.doc.cells[i]);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push(S.doc.cells[i].id);
    }
    return out;
  }

  /* one snapshot, one rebuild: a picked group leaves the pack as a unit and
     comes back with a single Ctrl+Z */
  function removePicked() {
    var ids = [];
    S.pick.forEach(function (id) { ids.push(id); });
    if (!ids.length) return;
    var f = S.frame || (S.frame = G.frameOf(S.doc));
    var cx = 0, cy = 0;
    for (var q = 0; q < ids.length; q++) {
      var cell = findCell(ids[q]);
      if (cell) { var at = G.cellOnFace(S.doc, f, S.face, cell); cx += at.x; cy += at.y; }
    }
    var before = REDUCED ? null : snapPrims(['top', 'bottom']);
    var f0 = frameSig();
    snapshot();
    var gone = 0;
    for (var i = 0; i < ids.length; i++) {
      if (deleteCell(ids[i], Math.min(180, i * 30))) gone++;
    }
    S.pick.clear();
    selBar();
    if (!gone) return;
    /* the straps of a group retract outward from its middle, not from
       whichever cell happened to be deleted last */
    if (gone > 1) S.animAnchor = { x: cx / ids.length, y: cy / ids.length };
    finishEdit(before, f0, gone === 1
      ? 'Cell removed - ' + S.doc.cells.length + ' left'
      : gone + ' cells removed together - ' + S.doc.cells.length + ' left');
  }

  cv.addEventListener('pointerdown', function (ev) {
    if (ev.button === 1 || ev.altKey) {
      S.pan = { x: ev.clientX - S.px, y: ev.clientY - S.py };
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { }
      return;
    }
    var pt = toSheet(ev);
    var c = cellAt(pt);

    /* a pack end is a pad on an island: one click, one end, then disarm */
    if (S.terminalPick) {
      if (ev.button !== 0) return;
      if (c) { placeTerminal(S.terminalPick, c); return; }
      cancelTerminalPick();
      toast('Pack end cancelled');
      return;
    }

    /* remove picks cells; nothing leaves the pack until it is confirmed */
    if (S.tool === 'delete') {
      if (ev.button !== 0) return;      /* no accidental erasing in this tool */
      if (c) { pickCell(c.id, ev.shiftKey); return; }
      /* bare sheet: a box to drag out, a click to unpick everything */
      S.pickBase = ev.shiftKey ? new Set(S.pick) : new Set();
      S.marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, moved: false };
      S.hover = null;
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { }
      S.dirty = true;
      return;
    }

    if (!c) return;

    /* the island tool is one click, one whole piece: the cells stay, the
       metal goes, and one Ctrl+Z puts the piece back */
    if (ev.button === 0 && S.tool === 'island') {
      var isl = islandAt(S.face, c.id);
      if (!isl) { toast('That cell is not in an island on the ' + S.face + ' sheet'); return; }
      snapshot();
      deleteIsland(S.face, isl.id);
      return;
    }

    /* flip is one click, one cell, no drag */
    if (ev.button === 0 && S.tool === 'flip') {
      var label = cellIndex(c.id) + 1;
      var f0 = frameSig();
      snapshot();
      flipCell(c);
      finishEdit(null, f0, 'Cell ' + label + ' turned over - ' + polCounts());
      return;
    }

    /* paint and erase are a stroke: the primitives are photographed once at
       the top and diffed once at the bottom, so a fast drag over thirty
       cells animates as one motion instead of thirty */
    var eraseMode = ev.button === 2;
    snapshot();
    S.strokeBefore = REDUCED ? null : snapPrims(['top']);
    S.strokeFrame = frameSig();
    S.dragging = true;
    S.paintMode = eraseMode ? 'erase' : (ev.shiftKey ? 'row' : 'paint');
    S.wet = {
      changed: Object.create(null), gen: 0, builtGen: -1,
      lastBuild: performance.now(), gap: 16, trail: []
    };
    S.animAnchor = G.cellOnFace(S.doc, S.frame, S.face, c);
    try { cv.setPointerCapture(ev.pointerId); } catch (e) { }
    applyPaint(c, S.paintMode);
  });

  function applyPaint(c, mode) {
    if (mode === 'erase') erase(c.id);
    else if (mode === 'row') paintRow(c.id);
    else paint(c.id);
    renderPalette();
    S.dirty = true;
  }

  cv.addEventListener('pointermove', function (ev) {
    if (S.pan) {
      S.px = ev.clientX - S.pan.x;
      S.py = ev.clientY - S.pan.y;
      S.dirty = true;
      return;
    }
    var pt = toSheet(ev);
    if (S.marquee) {
      var mq = S.marquee;
      mq.x1 = pt.x; mq.y1 = pt.y;
      /* three screen pixels of travel is a drag, below that it is a click */
      if (!mq.moved && Math.hypot(mq.x1 - mq.x0, mq.y1 - mq.y0) * S.zoom > 3) mq.moved = true;
      if (mq.moved) {
        S.pick = new Set(S.pickBase);
        var inside = marqueeCells(mq);
        for (var q = 0; q < inside.length; q++) S.pick.add(inside[q]);
        selBar();
      }
      S.dirty = true;
      return;
    }
    var c = cellAt(pt);
    var changed = (c ? c.id : null) !== (S.hover ? S.hover.id : null);
    S.hover = c;
    if (changed) { S.dirty = true; updateInspector(); }
    if (S.dragging && c && S.paintMode !== 'row') {
      applyPaint(c, S.paintMode);
    }
  });

  function endDrag() {
    if (S.dragging) {
      S.dragging = false;
      S.wet = null;
      finishEdit(S.strokeBefore, S.strokeFrame, null);
      S.strokeBefore = null;
      S.strokeFrame = null;
    }
    if (S.marquee) {
      /* no travel means it was a click on the bare sheet: unpick, unless the
         shift key was held to add to what was already picked */
      if (!S.marquee.moved) {
        S.pick = new Set(S.pickBase || []);
        selBar();
      }
      S.marquee = null;
      S.pickBase = null;
      S.dirty = true;
    }
    S.pan = null;
  }
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  /* capture should keep the release on the canvas, but alt-tab or a pointer
     that leaves before capture is set must still land the stroke, or the
     sheet would stay stale with no button left to release */
  window.addEventListener('pointerup', function () { if (S.dragging) endDrag(); });
  window.addEventListener('pointercancel', function () { if (S.dragging) endDrag(); });
  window.addEventListener('blur', function () { if (S.dragging) endDrag(); });
  cv.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  cv.addEventListener('pointerleave', function () {
    if (S.pan || S.dragging || S.marquee) return;
    if (!S.hover) return;
    S.hover = null;
    updateInspector();
    S.dirty = true;
  });

  cv.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    if (ev.shiftKey) {
      S.zoomAnim = null;
      S.px -= ev.deltaY;
      S.py -= ev.deltaX;
      S.dirty = true;
      return;
    }
    var r = cv.getBoundingClientRect();
    var mx = ev.clientX - r.left, my = ev.clientY - r.top;
    var before = { x: (mx - S.px) / S.zoom, y: (my - S.py) / S.zoom };
    var k = Math.exp(-ev.deltaY * 0.0015);
    S.zoomAnim = null;
    S.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, S.zoom * k));
    S.px = mx - before.x * S.zoom;
    S.py = my - before.y * S.zoom;
    syncZoomLabel();
    S.dirty = true;
  }, { passive: false });

  document.addEventListener('keydown', function (ev) {
    var el = ev.target || {};
    var tag = el.tagName;
    var range = tag === 'INPUT' && el.type === 'range';
    var typing = (tag === 'INPUT' && !range) || tag === 'SELECT' || tag === 'TEXTAREA';

    /* the command palette owns the keyboard while it is open */
    if (S.cmd.open) {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
        ev.preventDefault(); closeCmd(); return;
      }
      if (ev.key === 'Escape') { ev.preventDefault(); closeCmd(); return; }
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        S.cmd.index = Math.min(S.cmd.items.length - 1, S.cmd.index + 1);
        renderCmd();
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        S.cmd.index = Math.max(0, S.cmd.index - 1);
        renderCmd();
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        runCmd(S.cmd.index);
        return;
      }
      if (ev.key === 'Tab') { trapTab(ev, $('paletteModal')); return; }
      return;
    }
    if (helpOpen()) {
      if (ev.key === 'Escape') { ev.preventDefault(); setHelp(false); }
      else if (ev.key === 'Tab') trapTab(ev, $('helpModal'));
      return;
    }

    /* Undo is the one shortcut that has to work straight after a slider drag:
       the thumb still has focus, and the drag is exactly what is being undone.
       Everything else stays out of the way while a field has the keyboard. */
    if ((ev.ctrlKey || ev.metaKey) && !typing) {
      var k = (ev.key || '').toLowerCase();
      if (k === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) redo(); else undo();
        return;
      }
      if (k === 'y') { ev.preventDefault(); redo(); return; }
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      if (S.cmd.open) closeCmd(); else openCmd();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      download(baseName() + '.json', JSON.stringify(S.doc, null, 1), 'application/json');
      toast('Document saved as ' + baseName() + '.json');
      return;
    }
    if (typing || range) return;
    if (ev.ctrlKey || ev.metaKey) return;
    if (ev.key === '?') { ev.preventDefault(); setHelp(true); return; }
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomAt(1.25); return; }
    if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomAt(0.8); return; }
    if (ev.key === '0') { ev.preventDefault(); fitViewAnimated(); return; }
    if (ev.key === '1') { ev.preventDefault(); setZoomPercent(100); return; }
    if (ev.key.indexOf('Arrow') === 0) {
      ev.preventDefault();
      var panStep = ev.shiftKey ? 120 : 40;
      if (ev.key === 'ArrowLeft') S.px += panStep;
      else if (ev.key === 'ArrowRight') S.px -= panStep;
      else if (ev.key === 'ArrowUp') S.py += panStep;
      else if (ev.key === 'ArrowDown') S.py -= panStep;
      S.zoomAnim = null;
      S.dirty = true;
      return;
    }
    if (ev.key === '[') { ev.preventDefault(); setPanel('left', !S.leftOpen); return; }
    if (ev.key === ']') { ev.preventDefault(); setPanel('right', !S.rightOpen); return; }
    if (ev.key === 'f' || ev.key === 'F') {
      if (S.hover) {
        var f0f = frameSig();
        var target = S.hover;
        snapshot();
        flipCell(target);
        finishEdit(null, f0f, 'Cell ' + (cellIndex(target.id) + 1) + ' turned over - ' + polCounts());
      }
    } else if (ev.key === 'i' || ev.key === 'I') {
      /* hover a piece and press I: the whole island goes, cells and all metal
         untouched everywhere else */
      if (S.hover) {
        var isl = islandAt(S.face, S.hover.id);
        if (isl) { snapshot(); deleteIsland(S.face, isl.id); }
        else toast('That cell is not in an island on the ' + S.face + ' sheet');
      } else if (S.sel) {
        snapshot();
        deleteIsland(S.face, S.sel);
      }
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      /* picked cells go together; with nothing picked, the cell under the
         pointer still works, which is how the keyboard has always felt */
      if (S.pick.size) {
        ev.preventDefault();
        removePicked();
      } else if (S.hover) {
        ev.preventDefault();
        var label = cellIndex(S.hover.id) + 1;
        var f0d = frameSig();
        var before = REDUCED ? null : snapPrims(['top', 'bottom']);
        snapshot();
        if (deleteCell(S.hover.id)) {
          finishEdit(before, f0d, 'Cell ' + label + ' removed - ' + S.doc.cells.length + ' left');
        }
      }
    } else if (ev.key === 'Escape') {
      if (S.terminalPick) cancelTerminalPick();
      else unpick();
    } else if (ev.key === 'c' || ev.key === 'C') setFlow(!S.flowOn);
    else if (ev.key === 'r' || ev.key === 'R') rotateLayout(true);
    else if (ev.key === 't' || ev.key === 'T') setFace('top');
    else if (ev.key === 'b' || ev.key === 'B') setFace('bottom');
    else if (ev.key === 'x' || ev.key === 'X') setGhost(!S.ghost);
    else if (ev.key === 'g' || ev.key === 'G') { fitViewAnimated(); }
  });

  /* ------------------------------------------------------------------ */
  /* document <> controls                                                */
  /* ------------------------------------------------------------------ */

  function syncInputs() {
    var p = S.doc.params;
    var dn = $('docName');
    if (dn) dn.value = S.doc.name || 'my pack';
    /* the bounds first: a slider clamps what you assign to it, so a loaded
       file cannot leave the thumb at one number and the metal at another */
    $('padD').max = Math.max(8, p.cellD - 0.4);
    $('bridgeW').max = p.cellD + 6;
    syncGuideMax();
    $('cellD').value = p.cellD;
    $('gap').value = p.gap;
    refreshLineDefaults();
    var vals = {
      padD: p.padD, bridgeW: p.bridgeW, kerf: p.kerf, margin: p.margin,
      step: p.step, lineAngle: p.lineAngle, guideL: p.guideL
    };
    allRanges().forEach(function (el) {
      if (vals[el.id] !== undefined) el.value = vals[el.id];
    });
    /* a file whose slit is longer than its pad can take: the slider has just
       clamped it, so the document follows the thumb rather than the reverse */
    if (parseFloat($('guideL').value) !== S.doc.params.guideL) {
      S.doc.params.guideL = parseFloat($('guideL').value);
    }
    $('cellType').value = S.doc.cellType || 'custom';
    $('arrangement').value = S.doc.arrangement || 'hex';
    paintCut();
    paintGeom();
    SLIDE.settled = geomValues();
  }

  /* a document from an older version, or one saved before an option existed, is
     still a valid pack: the new fields get a value and everything else is left
     alone */
  function normalise(doc) {
    var p = doc.params;
    if (!p) return doc;
    p.cut = p.cut === 'lines' ? 'lines' : 'plate';
    p.lineAngle = isFinite(p.lineAngle) ? Math.max(0, Math.min(90, p.lineAngle)) : 90;
    p.guides = !!p.guides;
    p.guideL = isFinite(p.guideL) ? Math.max(2, Math.min(20, p.guideL)) : 8;
    if (!doc.terminals || typeof doc.terminals !== 'object') doc.terminals = { neg: null, pos: null };
    ['neg', 'pos'].forEach(function (k) {
      var e = doc.terminals[k];
      if (e && typeof e === 'object' && e.cell !== undefined &&
          (e.face === 'top' || e.face === 'bottom')) {
        doc.terminals[k] = { face: e.face, cell: e.cell };
      } else {
        doc.terminals[k] = null;
      }
    });
    return doc;
  }

  /* make a document (from a file, from undo, from storage) the live one */
  function adoptDoc(doc) {
    if (!doc || !doc.cells || !doc.islands || !doc.params) throw new Error('not a pack file');
    if (!doc.islands.top) doc.islands.top = [];
    if (!doc.islands.bottom) doc.islands.bottom = [];
    doc.params.step = doc.params.step || 0.1;
    doc.params.margin = doc.params.margin === undefined ? 8 : doc.params.margin;
    if (!doc.arrangement) doc.arrangement = 'hex';
    doc.params.pitch = doc.params.cellD + doc.params.gap;
    normalise(doc);
    S.doc = doc;
    S.hover = null;
    S.hiIsland = null;
    S.frame = null;
    S.anim = [];        /* undo or a loaded file replaces the layout wholesale */
    S.hiRow = null;
    S.pick.clear();
    S.marquee = null;
    S.sheets.top = null;
    S.sheets.bottom = null;
    var list = S.doc.islands[S.face] || [];
    S.sel = list.length ? list[0].id : null;
    S.unsaved = true;
    syncInputs();
    renderPalette();
    fitView();
    rebuildAll();
    scheduleSave();
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                              */
  /* ------------------------------------------------------------------ */

  function num(id) { return parseFloat($(id).value); }

  function applyCellSize() {
    var d = num('cellD') || 21.2;
    S.doc.params.cellD = d;
    S.doc.params.gap = Math.max(0, num('gap'));
    S.doc.params.pitch = d + S.doc.params.gap;
    if (S.doc.params.padD > d - 0.4) {
      S.doc.params.padD = Math.max(6, d - 0.4);
      $('padD').value = S.doc.params.padD;
      paintReadout($('padD'));
    }
    $('padD').max = Math.max(8, d - 0.4);
    $('bridgeW').max = d + 6;
    refreshLineDefaults();
    paintGeom();
  }

  $('cellType').addEventListener('change', function () {
    var v = this.value;
    var map = { '18650': 18.4, '21700': 21.2, '26650': 26.5, '32700': 32.2, '4680': 46.2 };
    if (map[v]) {
      snapshot();
      $('cellD').value = map[v];
      S.doc.cellType = v;
      applyCellSize();
      var rows = parseInt($('rows').value, 10) || 13;
      var cols = parseInt($('cols').value, 10) || 8;
      fillGrid(S.doc, rows, cols);
      S.sel = null;
      renderPalette();
      fitView();
      rebuildAll();
    } else {
      S.doc.cellType = 'custom';
    }
  });

  ['cellD', 'gap'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      applyCellSize();
      rebuildAll();
      S.unsaved = true;
      scheduleSave();
      S.dirty = true;
    });
  });

  $('arrangement').addEventListener('change', function () {
    snapshot();
    S.doc.arrangement = this.value;
    /* a square pack has a 45 degree direction, a staggered one does not, so
       the angle is snapped to what the new packing can actually do before the
       sheet is built from it */
    paintCut();
    fillGrid(S.doc, parseInt($('rows').value, 10) || 13, parseInt($('cols').value, 10) || 8);
    S.sel = null;
    renderPalette();
    fitView();
    rebuildAll();
  });

  $('btnFill').addEventListener('click', function () {
    snapshot();
    fillGrid(S.doc, Math.max(1, parseInt($('rows').value, 10) || 13), Math.max(1, parseInt($('cols').value, 10) || 8));
    S.sel = null;
    renderPalette();
    fitView();
    rebuildAll();
  });

  $('btnClear').addEventListener('click', function () {
    snapshot();
    S.doc.cells = [];
    S.doc.islands = { top: [], bottom: [] };
    S.sel = null;
    renderPalette();
    fitView();
    rebuildAll();
  });

  $('btnStripe').addEventListener('click', function () {
    snapshot();
    autoStripe();
    renderPalette();
    rebuildAll();
    S.dirty = true;
    toast('Striped into ' + S.doc.islands.top.length + ' top / ' + S.doc.islands.bottom.length + ' bottom islands');
  });

  $('btnClearFace').addEventListener('click', function () {
    snapshot();
    S.doc.islands[S.face] = [];
    S.sel = null;
    renderPalette();
    rebuildAll();
  });

  /* Remove group: the named counterpart of the + chip, for the group that is
     selected. Nothing to remove means nothing happens - it does not fall back
     to clear the face, which is a different and much bigger edit. */
  $('btnRmGroup').addEventListener('click', function () {
    if (!S.sel) { toast('Select a group first - click one of the coloured groups'); return; }
    snapshot();
    deleteIsland(S.face, S.sel);
  });

  $('btnTop').addEventListener('click', function () { setFace('top'); });
  $('btnBottom').addEventListener('click', function () { setFace('bottom'); });

  var TOOL_NOTES = {
    paint: 'Paint: drag over cells to join them to the highlighted island. <b>Shift</b> paints the whole row, right-click erases.',
    delete: 'Remove: click cells to pick them (click one again to drop it, drag a box on the bare sheet for many) - then <b>Del</b> or the bar. Nothing leaves the pack until you confirm, and one <b>Ctrl+Z</b> puts the lot back.',
    flip: 'Flip: click a cell to turn it over. Its + moves to the other face, which is how a series chain is built.',
    island: 'Island: click a piece to delete that whole island from the ' + S.face + ' sheet. Its cells stay in the pack - the other sheet still welds them - and one <b>Ctrl+Z</b> brings the piece back.'
  };

  function setTool(tool) {
    S.tool = tool;
    /* a selection belongs to the tool that made it */
    if (tool !== 'delete') { S.pick.clear(); S.marquee = null; S.pickBase = null; }
    if (S.terminalPick) { S.terminalPick = null; paintFlowPanel(); }
    $('btnToolPaint').classList.toggle('on', tool === 'paint');
    $('btnToolDel').classList.toggle('on', tool === 'delete');
    $('btnToolFlip').classList.toggle('on', tool === 'flip');
    $('btnToolIsland').classList.toggle('on', tool === 'island');
    paintCursor();
    $('toolNote').innerHTML = TOOL_NOTES[tool] || TOOL_NOTES.paint;
    selBar();
    S.dirty = true;
  }

  $('btnToolPaint').addEventListener('click', function () { setTool('paint'); });
  $('btnToolDel').addEventListener('click', function () { setTool('delete'); });
  $('btnToolFlip').addEventListener('click', function () { setTool('flip'); });
  $('btnToolIsland').addEventListener('click', function () { setTool(S.tool === 'island' ? 'paint' : 'island'); });
  $('btnTermNeg').addEventListener('click', function () { setTerminalPick('neg'); });
  $('btnTermPos').addEventListener('click', function () { setTerminalPick('pos'); });
  $('btnTermClear').addEventListener('click', function () { clearTerminals(); });
  $('flowOn').addEventListener('change', function () { setFlow(this.checked); });
  $('btnFlowIslands').addEventListener('click', function () { setFlowMode('islands', true); });
  $('btnFlowCells').addEventListener('click', function () { setFlowMode('cells', true); });
  $('btnSelDel').addEventListener('click', function () { removePicked(); });
  $('btnSelClear').addEventListener('click', function () { unpick(); });
  $('btnRotL').addEventListener('click', function () { rotateLayout(false); });
  $('btnRotR').addEventListener('click', function () { rotateLayout(true); });

  $('btnRowAdd').addEventListener('click', function () {
    var before = REDUCED ? null : snapPrims(['top', 'bottom']);
    var f0 = frameSig();
    snapshot();
    addRow();
    finishEdit(before, f0, 'Row added - ' + S.doc.cells.length + ' cells in the pack');
  });

  $('btnRowDel').addEventListener('click', function () {
    var before = REDUCED ? null : snapPrims(['top', 'bottom']);
    var f0 = frameSig();
    snapshot();
    var n = delRow();
    if (!n) { toast('No rows left'); return; }
    finishEdit(before, f0, 'Row removed - ' + n + ' cells gone, ' + S.doc.cells.length + ' left');
  });

  /* ------------------------------------------------------------------ */
  /* cut style                                                           */
  /*
   * A plate is the strongest sheet and the shortest current path, but it
   * spends metal on fields that carry nothing and it cannot give when the
   * cells are not all exactly the same height. The weld-line cut keeps only
   * what the welder and the current need: a pad on every spot, one band along
   * the lines between them, and the fields between the bands cut away.
   *
   * Both are the same document with one flag, so the switch is one undo step,
   * the cut files and the assembly map follow it, and a saved file remembers
   * it. What follows the mode is what the reset arrows call a default: a
   * 9.5 mm pad and a 6.5 mm band are right for a routed strip and silly for a
   * plate, so the same two numbers mean different things in the two modes and
   * the arrows put back the pair that belongs to the mode you are in.
   */
  /* ------------------------------------------------------------------ */

  /* What the weld-line cut wants, scaled to the cell: a pad that covers the
     weld spot and a band narrow enough to leave a slot between bands. The two
     proportions are the ones in the reference strip - a 21700 gets a 9.5 mm
     pad and a 6.5 mm band, a 18650 an 8.5 and a 5.5. */
  function lineDefaults() {
    var d = S.doc.params.cellD || 21.2;
    return {
      padD: Math.max(4, Math.round(d * 0.45 * 2) / 2),
      bridgeW: Math.max(1.5, Math.round(d * 0.3 * 2) / 2)
    };
  }

  /* the cut defaults move with the cell size, so they are written into the
     sliders rather than fixed in the markup */
  function refreshLineDefaults() {
    var d = lineDefaults();
    $('padD').dataset.defLines = String(d.padD);
    $('bridgeW').dataset.defLines = String(d.bridgeW);
    /* the slits scale with the pad they are cut into rather than with the
       cell: a 9.5 mm strip pad gets half the slit an 18 mm plate pad does */
    $('guideL').dataset.def = String(Math.round((S.doc.params.padD || 18) * 0.45 * 2) / 2);
  }

  /* The slit has to stay inside the pad, or it would cut the pad free of the
     strip: its longest length is a pad's worth of metal, and the slider's top
     follows Pad D. The same "a default is a wish, not a promise" rule the pad
     itself follows against the cell, one level down. */
  function syncGuideMax() {
    var el = $('guideL');
    var m = Math.max(2, Math.floor(G.guideMaxLen(S.doc.params) * 2) / 2);
    if (parseFloat(el.max) !== m) el.max = String(m);
  }

  /* The packing decides which directions the metal can run in: a square grid
     has rows, diagonals and columns; a staggered one has rows, two diagonals
     and columns. Offering 45 degrees on a staggered pack draws a strip that
     crosses itself and fills the fields it was supposed to cut away, so the
     slider only has the stops the lattice actually has. */
  function angleStep() { return S.doc.arrangement === 'square' ? 45 : 30; }

  function snapAngle(v) {
    var s = angleStep();
    return Math.max(0, Math.min(90, Math.round((isFinite(v) ? v : 90) / s) * s));
  }

  function syncAngleControl() {
    var el = $('lineAngle');
    /* read the value before the step is changed: a range rounds what it is
       holding to the new step, so the number in the document has to be taken
       from the value that was there and snapped by hand */
    var v = snapAngle(parseFloat(el.value));
    el.step = angleStep();
    if (v !== parseFloat(el.value)) el.value = v;
    S.doc.params.lineAngle = v;
  }

  function paintCut() {
    var p = S.doc.params;
    var lines = p.cut === 'lines';
    var guides = !!p.guides;
    syncAngleControl();
    $('btnCutPlate').classList.toggle('on', !lines);
    $('btnCutLines').classList.toggle('on', lines);
    $('guideOn').checked = guides;
    $('guideLRow').hidden = !guides;
    /* the angle is the direction of the cut features - the bands, the slits, or
       both - so it belongs to whichever of them is on */
    $('lineAngleRow').hidden = !(lines || guides);
    var how = '<b>Angle</b> sets which way the ' +
      (lines && guides ? 'bands and the slits run' : guides ? 'slits run' : 'bands run') +
      ' &mdash; rows, diagonals or columns.';
    $('cutNote').innerHTML = lines
      ? (guides
          ? 'Weld lines with guide slits: a pad and a slit on every weld spot, one band along the lines between them. ' + how
          : 'Weld lines: a pad on every weld spot, one band along the lines between them, and the fields between the bands cut away. ' + how)
      : (guides
          ? 'Plate with guide slits: the plate stays one piece, and every weld spot gets a 1.2 mm slit at the cell centre to see, feel and weld by &mdash; the same short line the strips on the market carry. ' + how
          : 'Plate: one solid piece per island, the union of every pad and strap &mdash; strongest, and the shortest current path.');
  }

  function setCut(mode) {
    if (mode !== 'lines') mode = 'plate';
    var p = S.doc.params;
    if ((p.cut || 'plate') === mode) return;
    snapshot();
    p.cut = mode;
    var preset = null;
    if (mode === 'lines' && (p.bridgeW > p.pitch * 0.5 || p.padD > p.pitch * 0.5)) {
      /* plate-sized numbers leave no room for a slot: the bands would meet and
         the cut would look like a slightly chewed plate. Start the strip at the
         widths this cut is for - the same snapshot puts both back. */
      preset = lineDefaults();
      $('bridgeW').value = preset.bridgeW;
      applyRange($('bridgeW'));
      $('padD').value = preset.padD;
      applyRange($('padD'));
    }
    paintCut();
    paintGeom();
    rebuildAll();
    S.dirty = true;
    var deg = (p.lineAngle || 0) + '\u00b0';
    toast(mode === 'lines'
      ? 'Weld-line cut at ' + deg + (preset
          ? ' - pad ' + preset.padD.toFixed(1) + ', strap ' + preset.bridgeW.toFixed(1) + ' mm so the slots stay open'
          : '')
      : 'Solid plate again');
  }

  /* The slits are a cut like the rest of the sheet, so this is one undo step,
     it lands in the document, and the exports and the assembly map follow it.
     It is not a third cut style: a strip with slits is exactly what the market
     sells, so it has to be able to sit on top of either style. */
  function setGuides(on) {
    on = !!on;
    var p = S.doc.params;
    if (!!p.guides === on) { $('guideOn').checked = on; return; }
    snapshot();
    p.guides = on;
    paintCut();
    paintGeom();
    rebuildAll();
    S.dirty = true;
    if (!on) { toast('Guide slits off - plain ' + (p.cut === 'lines' ? 'weld-line cut' : 'plate')); return; }
    var n = 0;
    var list = (S.sheets[S.face] || { islands: [] }).islands;
    for (var i = 0; i < list.length; i++) n += list[i].slots ? list[i].slots.length : 0;
    var len = Math.min(p.guideL || 8, G.guideMaxLen(p));
    toast(n + (n === 1 ? ' guide slit' : ' guide slits') + ' on the ' + S.face + ' - ' +
          (Math.round(len * 10) / 10) + ' mm at ' + (p.lineAngle || 0) + '\u00b0');
  }

  /* ------------------------------------------------------------------ */
  /* the geometry sliders                                                */
  /*
   * Three things turn these from form fields into instruments.
   *
   * The sheet follows the thumb. A range input only fires "change" when the
   * button comes up, so a drag used to be invisible until it was over: the
   * number moved and the drawing did not, which reads as a slider that does
   * not work. Every "input" now redraws, throttled, and "change" does the
   * full rebuild.
   *
   * One drag is one undo step. The snapshot is taken on the first value that
   * actually differs, not on every pointer move.
   *
   * Any number can be put back. Every row knows its own default, so a slider
   * that was nudged while hunting for a look can just be reset.
   */
  /* ------------------------------------------------------------------ */

  var PREVIEW_MS = 55;
  var SLIDE = { down: false, took: false, timer: 0, last: -1e9, gap: 55, settled: '' };

  /* every slider in the panel, including the ones whose row is hidden: the
     listeners are bound to all of them, while the reset count and the "has the
     sheet settled" signature only look at what is on screen */
  function allRanges() {
    return Array.prototype.slice.call(document.querySelectorAll('#geom input[type=range]'));
  }

  function geomRanges() {
    return allRanges().filter(function (el) { return !el.parentElement.hidden; });
  }

  function geomValues() {
    return geomRanges().map(function (el) { return el.value; }).join(',');
  }

  /* a default is a wish, not a promise: a 4680 pack cannot have an 18 mm pad
     back once the cell size says otherwise, so the value is bounded first and
     then compared, which keeps the "changed" marks honest. The weld-line cut
     brings its own pair of defaults for the two widths, since a routed strip
     wants a much narrower band than a plate does. */
  function rangeDefault(el) {
    var d = parseFloat(el.dataset.def);
    if (el.dataset.defLines && S.doc.params.cut === 'lines') d = parseFloat(el.dataset.defLines);
    var lo = parseFloat(el.min), hi = parseFloat(el.max);
    if (!isFinite(hi)) return d;
    return Math.min(hi, Math.max(lo, d));
  }

  /* the filled part of the track is a CSS gradient, so every value change has
     to hand it the new position; the accent on the number and on the reset
     arrow is the cheap way to see at a glance what has been touched */
  function paintRange(el) {
    var lo = parseFloat(el.min), hi = parseFloat(el.max), v = parseFloat(el.value);
    var pct = hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 100 : 0;
    el.style.setProperty('--p', pct.toFixed(2) + '%');
    var row = el.parentElement;
    if (row && row.classList) row.classList.toggle('changed', Math.abs(v - rangeDefault(el)) > 1e-9);
  }

  function paintReadout(el) {
    var out = $(el.id + 'v');
    if (!out) return;
    var dig = parseInt(el.dataset.dig, 10) || 0;
    var v = parseFloat(el.value);
    out.textContent = (dig > 0 ? v.toFixed(dig) : String(Math.round(v))) + (el.dataset.unit || '');
  }

  function paintGeomHeader() {
    var btn = $('btnGeomReset'), n = 0;
    geomRanges().forEach(function (el) {
      if (Math.abs(parseFloat(el.value) - rangeDefault(el)) > 1e-9) n++;
    });
    btn.textContent = n ? 'reset ' + n : 'reset';
    btn.classList.toggle('on', n > 0);
    btn.title = n
      ? 'Put ' + n + (n > 1 ? ' sliders' : ' slider') + ' back to ' + (n > 1 ? 'their defaults' : 'its default')
      : 'Every geometry slider is at its default';
  }

  /* the arrow has to name the default it will actually restore, which now
     depends on the cut style and on the cell size */
  function paintGeomTitles() {
    geomRanges().forEach(function (el) {
      var btn = document.querySelector('#geom .rst[data-for="' + el.id + '"]');
      if (!btn) return;
      var d = rangeDefault(el);
      var dig = parseInt(el.dataset.dig, 10) || 0;
      btn.title = 'Put ' + el.dataset.label + ' back to ' +
        (dig > 0 ? d.toFixed(dig) : String(Math.round(d))) + (el.dataset.unit || ' mm');
    });
  }

  function paintGeom() {
    refreshLineDefaults();
    syncGuideMax();
    allRanges().forEach(paintReadout);
    allRanges().forEach(paintRange);
    paintGeomHeader();
    paintGeomTitles();
  }

  /* the one place where a slider's number lands in the document */
  function applyRange(el) {
    var key = el.dataset.key;
    var v = parseFloat(el.value);
    if (key === 'padD') v = Math.min(v, S.doc.params.cellD - 0.4);
    if (key === 'guideL') v = Math.min(v, parseFloat(el.max));
    S.doc.params[key] = v;
    /* a pad narrowed under a slit brings the slit with it: the number that no
       longer fits is replaced by the length a pad of this size deserves, rather
       than left at a value the metal does not have room for */
    if (key === 'padD') {
      refreshLineDefaults();
      syncGuideMax();
      var gl = $('guideL');
      if (parseFloat(gl.value) !== S.doc.params.guideL) {
        var want = Math.min(rangeDefault(gl), parseFloat(gl.max));
        gl.value = want;
        S.doc.params.guideL = want;
        paintReadout(gl);
        paintRange(gl);
      }
    }
    paintReadout(el);
    paintRange(el);
    paintGeomHeader();
    S.dirty = true;
  }

  /* A 250 cell pack takes about 40 ms to trace, so a rebuild on every pointer
     move would crawl. Spacing the previews keeps the thumb responsive, and
     only the face on screen has to be built - the other one is put back by
     the full rebuild when the value stops moving. */
  function previewGeom() {
    SLIDE.timer = 0;
    var t0 = performance.now();
    var before = S.frame;
    S.frame = G.frameOf(S.doc);
    S.sheets[S.face] = null;
    /* a ghost of the far sheet is better stale than gone while the thumb is
       down: it is rebuilt with everything else when the value settles. It only
       has to go if the frame moved, since it is drawn in these coordinates. */
    var moved = !before || before.W !== S.frame.W || before.H !== S.frame.H ||
                before.ox !== S.frame.ox || before.oy !== S.frame.oy;
    if (!S.ghost || moved) S.sheets[otherFace()] = null;
    ensureSheet(S.face);
    S.flowPath = G.currentPath(S.doc);
    S.dirty = true;
    SLIDE.last = performance.now();
    /* a big pack traces slower than a small one, so the gap is set from what
       the last preview actually cost: about a third of the time goes to the
       drawing, the rest to the hand on the mouse */
    SLIDE.gap = Math.max(PREVIEW_MS, Math.round((SLIDE.last - t0) * 2.2));
    if (!isFinite(SLIDE.gap)) SLIDE.gap = PREVIEW_MS;
  }

  function previewSoon() {
    if (SLIDE.timer) return;
    var wait = SLIDE.gap - (performance.now() - SLIDE.last);
    SLIDE.timer = setTimeout(previewGeom, wait > 0 ? wait : 0);
  }

  /* the value stopped moving: build everything, once */
  function commitSlide() {
    if (SLIDE.timer) { clearTimeout(SLIDE.timer); SLIDE.timer = 0; }
    SLIDE.down = false;
    var sig = geomValues();
    /* a drag that ends where it started still has to put the other face back */
    if (sig === SLIDE.settled && S.sheets.top && S.sheets.bottom) return;
    SLIDE.settled = sig;
    rebuildAll();
    S.unsaved = true;
    scheduleSave();
  }

  function resetRanges(only) {
    /* every slider, including the ones whose row is hidden: "reset" is a
       promise about the numbers, and a hidden one is still a number the sheet
       will be cut with. A visible-only reset left the guide length belonging
       to the pad that had just been replaced - the slider was gone, so the
       stale value was too. */
    var list = allRanges().filter(function (el) { return !only || el.id === only; });
    var todo = list.filter(function (el) {
      return Math.abs(parseFloat(el.value) - rangeDefault(el)) > 1e-9;
    });
    if (!todo.length) {
      toast(only ? $(only).dataset.label + ' is already at its default'
                 : 'Every geometry slider is already at its default');
      return;
    }
    snapshot();
    /* Pad D first, because the guide length is a proportion of the pad: the
       panel order is not the dependency order, so the slider whose size other
       defaults read has to land before them. */
    var ordered = list.filter(function (el) { return el.id === 'padD'; })
                      .concat(list.filter(function (el) { return el.id !== 'padD'; }));
    ordered.forEach(function (el) {
      var d = rangeDefault(el);
      if (Math.abs(parseFloat(el.value) - d) <= 1e-9) return;
      el.value = d;
      applyRange(el);
    });
    commitSlide();
    toast(only
      ? $(only).dataset.label + ' back to ' + $(only).value + ($(only).dataset.unit || ' mm')
      : todo.length + (todo.length > 1 ? ' sliders' : ' slider') + ' back to default');
  }

  function initRange(el) {
    el.addEventListener('pointerdown', function () {
      SLIDE.down = true;
      SLIDE.took = false;
    });
    el.addEventListener('input', function () {
      /* the first value that differs earns the undo step, so a whole drag is
         put back by one Ctrl+Z rather than forty */
      if (!SLIDE.took) { SLIDE.took = true; snapshot(); }
      applyRange(el);
      if (SLIDE.down) previewSoon();
    });
    el.addEventListener('change', function () {
      applyRange(el);
      commitSlide();
      SLIDE.took = false;
    });
    el.addEventListener('dblclick', function (ev) {
      ev.preventDefault();
      resetRanges(el.id);
    });
    paintRange(el);
  }

  allRanges().forEach(initRange);

  /* a release that never reaches the slider (pointer left the window) still
     has to finish the edit */
  window.addEventListener('pointerup', function () { if (SLIDE.down) commitSlide(); });
  window.addEventListener('pointercancel', function () { if (SLIDE.down) commitSlide(); });
  window.addEventListener('blur', function () { if (SLIDE.down) commitSlide(); });

  $('btnGeomReset').addEventListener('click', function () { resetRanges(null); });

  Array.prototype.forEach.call(document.querySelectorAll('#geom .rst'), function (btn) {
    btn.addEventListener('click', function () { resetRanges(btn.dataset.for); });
  });

  $('btnCutPlate').addEventListener('click', function () { setCut('plate'); });
  $('btnCutLines').addEventListener('click', function () { setCut('lines'); });
  $('guideOn').addEventListener('change', function () { setGuides(this.checked); });

  $('ghostOther').addEventListener('change', function () { setGhost(this.checked); });

  $('btnSvg').addEventListener('click', function () { exportSheets('svg', 'both'); });
  $('btnDxf').addEventListener('click', function () { exportSheets('dxf', 'both'); });
  $('btnSvgTop').addEventListener('click', function () { exportSheets('svg', 'top'); });
  $('btnSvgBot').addEventListener('click', function () { exportSheets('svg', 'bottom'); });
  $('btnDxfTop').addEventListener('click', function () { exportSheets('dxf', 'top'); });
  $('btnDxfBot').addEventListener('click', function () { exportSheets('dxf', 'bottom'); });

  $('btnPrint').addEventListener('click', function () {
    rebuildAll();
    download(baseName() + '-assembly-map.svg', G.toPrint(S.doc, S.sheets.top, S.sheets.bottom), 'image/svg+xml');
    toast('Assembly map written');
  });

  $('btnSave').addEventListener('click', function () {
    download(baseName() + '.json', JSON.stringify(S.doc, null, 1), 'application/json');
  });

  $('btnLoad').addEventListener('click', function () { $('file').click(); });
  $('file').addEventListener('change', function (ev) {
    var f = ev.target.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var doc = JSON.parse(rd.result);
        snapshot();
        adoptDoc(doc);
        toast('Loaded ' + doc.cells.length + ' cells');
      } catch (e) {
        toast('Could not read that file: ' + e.message);
      }
      ev.target.value = '';
    };
    rd.readAsText(f);
  });

  /* ------------------------------------------------------------------ */
  /* new chrome                                                          */
  /* ------------------------------------------------------------------ */

  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnZoomOut').addEventListener('click', function () { zoomAt(0.8); });
  $('btnZoomIn').addEventListener('click', function () { zoomAt(1.25); });
  $('btnFit').addEventListener('click', fitViewAnimated);
  $('zoomPct').addEventListener('click', function () { setZoomPercent(100); });
  $('btnGrid').addEventListener('click', function () { setGrid(!S.grid); });
  $('btnMini').addEventListener('click', function () { setMini(!S.mini); });
  $('btnLeft').addEventListener('click', function () { setPanel('left', !S.leftOpen); });
  $('btnRight').addEventListener('click', function () { setPanel('right', !S.rightOpen); });
  $('btnTheme').addEventListener('click', toggleTheme);
  $('btnCmd').addEventListener('click', openCmd);
  $('btnHelp').addEventListener('click', function () { setHelp(true); });
  $('helpClose').addEventListener('click', function () { setHelp(false); });
  $('cmdClose').addEventListener('click', closeCmd);
  $('helpModal').addEventListener('click', function (ev) { if (ev.target === this) setHelp(false); });
  $('paletteModal').addEventListener('click', function (ev) { if (ev.target === this) closeCmd(); });
  $('cmdInput').addEventListener('input', function () { S.cmd.index = 0; renderCmd(); });

  $('btnPng').addEventListener('click', exportPNG);
  $('btnCopy').addEventListener('click', copyJSON);
  $('btnReport').addEventListener('click', exportReport);

  $('docName').addEventListener('input', function () {
    S.doc.name = this.value;
    S.unsaved = true;
    setSaveState('edited', true);
    scheduleSave();
  });
  $('docName').addEventListener('change', function () {
    this.value = (this.value || '').trim() || 'my pack';
    S.doc.name = this.value;
  });

  if (mini) {
    mini.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      miniDrag = { id: ev.pointerId };
      try { mini.setPointerCapture(ev.pointerId); } catch (e) { }
      miniFollow(ev);
    });
    mini.addEventListener('pointermove', function (ev) {
      if (!miniDrag) return;
      miniFollow(ev);
    });
    var miniEnd = function () { miniDrag = null; };
    mini.addEventListener('pointerup', miniEnd);
    mini.addEventListener('pointercancel', miniEnd);
  }

  function miniFollow(ev) {
    var mm = miniMap();
    if (!mm) return;
    var r = mm.r;
    var pt = { x: (ev.clientX - r.left - mm.ox) / mm.z, y: (ev.clientY - r.top - mm.oy) / mm.z };
    centerViewOn(pt, false);
    drawMini(performance.now());
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    var saved = null;
    try { saved = localStorage.getItem('battery-architect.doc'); } catch (e) { }
    S.doc = saved ? JSON.parse(saved) : defaultDoc();
    if (!S.doc.arrangement) S.doc.arrangement = 'hex';
    if (!S.doc.islands.top) S.doc.islands.top = [];
    if (!S.doc.islands.bottom) S.doc.islands.bottom = [];
    S.doc.params.pitch = S.doc.params.cellD + S.doc.params.gap;
    normalise(S.doc);

    if (!S.doc.cells.length) {
      fillGrid(S.doc, 13, 8);
    }
    if (!S.doc.islands.top.length && !S.doc.islands.bottom.length) {
      autoStripe();
    }
    S.sel = S.doc.islands.top.length ? S.doc.islands.top[0].id : null;

    /* view preferences are not part of the document: they belong to this
       browser, and a pack you share should not carry somebody else's theme */
    var ui = readUi();
    S.theme = ui.theme === 'day' ? 'day' : 'midnight';
    S.grid = ui.grid !== false;
    S.mini = ui.mini !== false;
    S.leftOpen = ui.leftOpen !== false;
    S.rightOpen = ui.rightOpen !== false;
    S.flowMode = ui.flowMode === 'cells' ? 'cells' : 'islands';
    applyTheme(S.theme, false);
    syncFlowMode();
    $('app').classList.toggle('no-left', !S.leftOpen);
    $('app').classList.toggle('no-right', !S.rightOpen);
    if (mini) mini.hidden = !S.mini;

    syncInputs();
    setTool('paint');
    resize();
    resizeMini();
    fitView();
    renderPalette();
    rebuildAll();
    syncToolbar();
    persistDoc(true);

    setInterval(function () { persistDoc(false); }, 4000);
    window.addEventListener('beforeunload', persistDoc);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') persistDoc();
    });
  }

  window.addEventListener('resize', function () {
    var w = S.vw, h = S.vh;
    resize();
    resizeMini();
    /* keep the middle of the sheet in the middle when the window changes */
    if (w && h && (Math.abs(w - S.vw) > 1 || Math.abs(h - S.vh) > 1)) {
      S.px += (S.vw - w) / 2;
      S.py += (S.vh - h) / 2;
    }
    S.dirty = true;
  });

  function loop() {
    /* an animation is the only thing that keeps asking for frames */
    if (S.zoomAnim) stepViewAnim(performance.now());
    if (S.anim.length) S.dirty = true;
    if (S.flowOn && !REDUCED && S.flowPath && S.flowPath.ok && S.flowPath.points.length > 1) {
      var now = performance.now();
      if (now - S.flowLast >= 33) { S.flowLast = now; S.dirty = true; }
    }
    if (S.dirty) draw();
    requestAnimationFrame(loop);
  }

  boot();
  requestAnimationFrame(loop);

  /* A handle for tests/smoke-app.js and for poking at the state from the
     browser console. The app never reads it back. */
  window.__ba = {
    state: S, geo: G, rebuild: rebuildAll, tool: setTool, rows: renderRows,
    anim: drawAnim, frame: draw, ghost: setGhost, guides: setGuides, flow: setFlow,
    flowMode: setFlowMode,
    theme: applyTheme, grid: setGrid, mini: setMini, panel: setPanel,
    fit: fitViewAnimated, zoom: zoomAt, undo: undo, redo: redo,
    help: setHelp, cmd: openCmd, save: persistDoc, report: reportText,
    flowInfo: function () {
      var p = S.flowPlan;
      if (!p) return null;
      var hops = 0;
      for (var i = 0; i < p.items.length; i++) if (p.items[i].kind === 'hop') hops++;
      return {
        mode: p.mode,
        runs: p.runs ? p.runs.length : 0,
        hops: hops,
        segments: p.segments ? p.segments.length : 0,
        nodes: p.nodes ? p.nodes.length : 0,
        total: Math.round(p.total),
        islands: flowIslandCount(S.flowPath)
      };
    },
    flowNow: function () {
      var p = S.flowPlan;
      if (!p || !S.flowOn) return null;
      var f = flowFrameAt(p, performance.now() - S.flowPlanStart);
      return {
        mode: p.mode, kind: f.item.kind, seg: f.item.seg, run: f.item.run,
        from: f.item.from, to: f.item.to, node: f.item.node,
        u: Math.round(f.u * 1000) / 1000
      };
    }
  };
})();
