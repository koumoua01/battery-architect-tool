/* Headless check of the geometry core.
 * Builds a 13-row staggered layout like the reference drawing, splits it into
 * stripe islands alternating between the two faces, then exercises every
 * exporter. Writes artefacts to out/ for visual inspection.
 *
 *   node tests/run-tests.js
 */
const fs = require('fs');
const path = require('path');
const G = require('../geometry.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function ok(cond, label, detail) {
  if (cond) {
    console.log('  PASS  ' + label + (detail ? '  (' + detail + ')' : ''));
  } else {
    failures++;
    console.log('  FAIL  ' + label + (detail ? '  (' + detail + ')' : ''));
  }
}

/* ------------------------------------------------------------------ */
/* build a reference-like layout                                       */
/* ------------------------------------------------------------------ */

function makeDoc() {
  const cellD = 21.2;
  const gap = 0.6;
  const pitch = cellD + gap;
  const rows = 13;
  const cols = 8;
  const rowH = pitch * Math.sqrt(3) / 2;

  const cells = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    const odd = r % 2 === 1;
    const n = odd ? cols - 1 : cols;
    const xOff = odd ? pitch / 2 : 0;
    for (let c = 0; c < n; c++) {
      cells.push({
        id: 'c' + (id++),
        x: c * pitch + xOff,
        y: r * rowH,
        flip: false,
        row: r
      });
    }
  }

  const doc = {
    version: 1,
    name: 'test pack',
    cellType: '21700',
    cells,
    islands: { top: [], bottom: [] },
    params: {
      cellD, gap, pitch, padD: 18, bridgeW: 18, kerf: 0.1,
      margin: 8, step: 0.1, islandGap: 0.8
    }
  };

  /* Two full partitions of the cells, one per face, offset by one row.
     Every terminal must be connected, so each face covers every cell; the
     bottom partition is shifted, which is what turns the stack into a
     series chain instead of a short. This is the classic overlapping-stripe
     pack and it is exactly what the hand drawing shows. */
  const palette = ['#4fc3f7', '#aed581', '#ffb74d', '#ba68c8', '#4db6ac', '#e57373', '#fff176', '#9575cd'];
  function stripe(list, start, size, tag, ci) {
    const ids = cells.filter(c => c.row >= start && c.row < start + size).map(c => c.id);
    if (!ids.length) return;
    list.push({ id: tag, name: tag.toUpperCase(), color: palette[ci % palette.length], cells: ids });
  }
  let ti = 0;
  for (let r = 0; r < rows; r += 2) stripe(doc.islands.top, r, 2, 't' + ti++, ti);
  let bi = 0;
  stripe(doc.islands.bottom, 0, 1, 'b' + bi++, bi);
  for (let r = 1; r < rows; r += 2) stripe(doc.islands.bottom, r, 2, 'b' + bi++, bi);
  return doc;
}

/* ------------------------------------------------------------------ */

console.log('layout');
const doc = makeDoc();
console.log('  ' + doc.cells.length + ' cells, ' + doc.islands.top.length + ' top islands, ' + doc.islands.bottom.length + ' bottom islands');

const frame = G.frameOf(doc);
console.log('  sheet ' + frame.W.toFixed(2) + ' x ' + frame.H.toFixed(2) + ' mm');

console.log('contours');
const t0 = Date.now();
const top = G.buildSheet(doc, 'top');
const bot = G.buildSheet(doc, 'bottom');
const ms = Date.now() - t0;
console.log('  built both sheets in ' + ms + ' ms');

ok(top.islands.length > 0, 'top sheet has islands', top.islands.length);
ok(bot.islands.length > 0, 'bottom sheet has islands', bot.islands.length);

let totalVerts = 0;
let allInside = true;
for (const sh of [top, bot]) {
  for (const isl of sh.islands) {
    ok(isl.polys.length > 0, sh.face + ' ' + isl.name + ' has contour', isl.polys.length + ' loops, ' + isl.area.toFixed(1) + ' mm2');
    for (const poly of isl.polys) {
      totalVerts += poly.length;
      ok(poly.length >= 3, '  loop closed', poly.length + ' pts');
      const b = G.polyArea(poly);
      if (!isFinite(b) || b === 0) allInside = false;
    }
    /* a piece must not be smaller than the pads it is made of */
    const padArea = isl.cells * Math.PI * Math.pow(doc.params.padD / 2, 2);
    ok(isl.area >= padArea * 0.98, sh.face + ' ' + isl.name + ' area >= sum of pads', (isl.area / padArea).toFixed(3) + 'x');
  }
}
ok(allInside, 'no degenerate loops');
console.log('  ' + totalVerts + ' vertices total');

console.log('mirror invariant');
/* the bottom sheet must be the exact reflection of the top sheet layout */
let mirrorOk = true;
for (const cell of doc.cells) {
  const a = G.cellOnFace(doc, frame, 'top', cell);
  const b = G.cellOnFace(doc, frame, 'bottom', cell);
  if (Math.abs((frame.W - a.x) - b.x) > 1e-9 || Math.abs(a.y - b.y) > 1e-9) mirrorOk = false;
  if (a.x < -1e-6 || a.x > frame.W + 1e-6 || b.x < -1e-6 || b.x > frame.W + 1e-6) mirrorOk = false;
}
ok(mirrorOk, 'bottom = reflect(top) about the sheet centre line');

console.log('kerf');
const noKerf = JSON.parse(JSON.stringify(doc));
noKerf.params.kerf = 0;
const t1 = G.buildSheet(noKerf, 'top').islands[0];
const t2 = G.buildSheet(doc, 'top').islands[0];
ok(t2.area > t1.area, 'kerf grows the cut path', '+' + (t2.area - t1.area).toFixed(1) + ' mm2');

console.log('diagnostics');
const drc = G.diagnose(doc);
ok(drc.filter(d => d.level === 'error').length === 0, 'no errors on a complete layout');
ok(drc.filter(d => d.level === 'warn').length === 0, 'every terminal is connected');

const broken = JSON.parse(JSON.stringify(doc));
broken.islands.bottom[0].cells.pop();
const drc2 = G.diagnose(broken);
ok(drc2.some(d => d.level === 'warn'), 'detects an unconnected terminal');

/* ------------------------------------------------------------------ */
/* rotate                                                              */
/* ------------------------------------------------------------------ */

console.log('rotate');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rot = JSON.parse(JSON.stringify(doc));
const f0 = G.frameOf(rot);
G.rotateDoc(rot, true);
const f1 = G.frameOf(rot);
ok(Math.abs(f0.W - f1.H) < 5e-4 && Math.abs(f0.H - f1.W) < 5e-4,
  '90 deg swaps the sheet',
  f0.W.toFixed(1) + 'x' + f0.H.toFixed(1) + ' -> ' + f1.W.toFixed(1) + 'x' + f1.H.toFixed(1));
ok(rot.cells.length === doc.cells.length, 'every cell survives the turn', rot.cells.length);
ok(rot.rot === 90, 'the quarter turn is remembered', 'rot=' + rot.rot);

let rigid = true;
for (let i = 0; i < doc.cells.length; i += 5) {
  for (let j = i + 1; j < doc.cells.length; j += 9) {
    if (Math.abs(dist(doc.cells[i], doc.cells[j]) - dist(rot.cells[i], rot.cells[j])) > 2e-3) rigid = false;
  }
}
ok(rigid, 'cell-to-cell distances unchanged - it is a rigid turn');

const rotTop = G.buildSheet(rot, 'top');
ok(rotTop.islands.length === top.islands.length, 'island count unchanged');
ok(rotTop.islands.every((isl, k) => isl.cells === top.islands[k].cells), 'island membership unchanged');
const areaBefore = top.islands.reduce((s, i) => s + i.area, 0);
const areaAfter = rotTop.islands.reduce((s, i) => s + i.area, 0);
ok(Math.abs(areaAfter - areaBefore) / areaBefore < 0.03,
  'metal area unchanged', areaBefore.toFixed(1) + ' -> ' + areaAfter.toFixed(1) + ' mm2');

const full = JSON.parse(JSON.stringify(doc));
for (let i = 0; i < 4; i++) G.rotateDoc(full, true);
ok(full.rot === 0 && Math.abs(G.frameOf(full).W - f0.W) < 1e-6, 'four turns are a full circle');

/* ------------------------------------------------------------------ */
/* remove cells                                                        */
/* ------------------------------------------------------------------ */

console.log('remove cells');
function removeCell(d, id) {
  d.cells = d.cells.filter(c => c.id !== id);
  for (const f of ['top', 'bottom']) for (const isl of d.islands[f]) isl.cells = isl.cells.filter(x => x !== id);
}

const cut = JSON.parse(JSON.stringify(doc));
const victim = cut.cells[Math.floor(cut.cells.length / 2)].id;
removeCell(cut, victim);
ok(cut.cells.length === doc.cells.length - 1, 'cell removed from the pack', cut.cells.length + ' left');
ok(cut.islands.top.every(i => !i.cells.includes(victim)) &&
   cut.islands.bottom.every(i => !i.cells.includes(victim)), 'cell removed from both faces');
ok(G.diagnose(cut).length === 0, 'no orphan terminal warnings after a clean removal');
const cutTop = G.buildSheet(cut, 'top');
ok(cutTop.islands.every(i => i.parts === 1), 'remaining islands are still one piece each');
ok(cutTop.islands.every(i => i.polys.length >= 1), 'remaining islands still have contours');

/* a group that has been split in two must be reported, not silently drawn */
const twoPiece = {
  version: 1, name: 'split', cellType: '21700', arrangement: 'hex',
  cells: [
    { id: 'a', x: 0, y: 0, flip: false }, { id: 'b', x: 21.8, y: 0, flip: false },
    { id: 'c', x: 0, y: 300, flip: false }, { id: 'd', x: 21.8, y: 300, flip: false }
  ],
  islands: { top: [{ id: 'x', name: 'X', color: '#4fc3f7', cells: ['a', 'b', 'c', 'd'] }], bottom: [] },
  params: { cellD: 21.2, gap: 0.6, pitch: 21.8, padD: 18, bridgeW: 18, kerf: 0.1, margin: 8, step: 0.1 }
};
const split = G.buildSheet(twoPiece, 'top');
ok(split.islands[0].parts === 2, 'an island in two clusters counts as two pieces', split.islands[0].parts + ' parts, ' + split.islands[0].polys.length + ' loops');

/* ------------------------------------------------------------------ */
/* weld-line cut                                                       */
/* ------------------------------------------------------------------ */
/* The option keeps a pad on every weld spot and one band along the lines
   between them, so the fields between bands fall out as slots. The route has
   to visit every cell exactly once, keep every step short enough to be a strap
   rather than a bar across the sheet, and still cut as one piece. */

console.log('weld-line cut');
const lineDoc = JSON.parse(JSON.stringify(doc));
lineDoc.params.cut = 'lines';
lineDoc.params.lineAngle = 90;
lineDoc.params.padD = 9.5;
lineDoc.params.bridgeW = 6.5;
const lineTop = G.buildSheet(lineDoc, 'top');

const plateArea = top.islands.reduce((s, i) => s + i.area, 0);
const lineArea = lineTop.islands.reduce((s, i) => s + i.area, 0);
ok(lineArea < plateArea * 0.55, 'the weld-line cut uses far less metal',
  plateArea.toFixed(0) + ' -> ' + lineArea.toFixed(0) + ' mm2, ' + Math.round(lineArea / plateArea * 100) + '%');
ok(lineTop.islands.length === top.islands.length, 'one strip per island, same count', lineTop.islands.length);
ok(lineTop.islands.every(i => i.parts === 1), 'every routed strip is still one piece');
ok(lineTop.islands.every(i => i.polys.length === 1), 'no field left enclosed inside a strip');

const spotOf = id => G.cellOnFace(lineDoc, frame, 'top', doc.cells.find(c => c.id === id));
const stripPts = lineDoc.islands.top[0].cells.map(spotOf);
const route = G.weldOrder(stripPts, 90, lineDoc.params.pitch);
ok(route.length === stripPts.length, 'the route visits every cell', route.length + ' of ' + stripPts.length);
ok(new Set(route).size === stripPts.length, 'and none of them twice');

let maxStep = 0;
for (let i = 1; i < route.length; i++) {
  maxStep = Math.max(maxStep, dist(stripPts[route[i - 1]], stripPts[route[i]]));
}
ok(maxStep < lineDoc.params.pitch * 1.9, 'every step is one strap long',
  maxStep.toFixed(1) + ' mm, pitch ' + lineDoc.params.pitch.toFixed(1));

/* one pad per cell plus one band between consecutive cells: no more metal */
const stripPrims = G.islandPrimitives(stripPts, lineDoc.params);
ok(stripPrims.length === stripPts.length * 2 - 1, 'a pad per spot and a band between neighbours',
  stripPrims.length + ' primitives for ' + stripPts.length + ' cells');
ok(stripPrims.filter(q => !q.inv).length === stripPts.length, 'every weld spot keeps its pad');

/* the orientation is a real choice, not a label */
const route0 = G.weldOrder(stripPts, 0, lineDoc.params.pitch);
ok(route0.join() !== route.join(), 'turning the angle turns the route',
  '0 deg starts ' + route0.slice(0, 3).join('-') + ', 90 deg starts ' + route.slice(0, 3).join('-'));
const byAngle = {};
for (const a of [0, 30, 60, 90]) {
  const d2 = JSON.parse(JSON.stringify(lineDoc));
  d2.params.lineAngle = a;
  const sh = G.buildSheet(d2, 'top');
  byAngle[a] = Math.round(sh.islands.reduce((s, i) => s + i.area, 0));
  ok(sh.islands.every(i => i.parts === 1 && i.polys.length === 1),
    'the packing directions all give a clean strip', a + ' deg, ' + byAngle[a] + ' mm2');
}
ok(new Set(Object.values(byAngle)).size > 1, 'the angle changes the shape',
  JSON.stringify(byAngle));

/* a square pack can do 45 degrees, where a staggered one cannot */
const squareDoc = JSON.parse(JSON.stringify(lineDoc));
squareDoc.arrangement = 'square';
for (const c of squareDoc.cells) {
  const row = Math.round(c.y / (doc.params.pitch * Math.sqrt(3) / 2));
  c.y = row * doc.params.pitch;
  c.x = Math.round((c.x - (row % 2 ? doc.params.pitch / 2 : 0)) / doc.params.pitch) * doc.params.pitch;
}
squareDoc.params.lineAngle = 45;
const squareTop = G.buildSheet(squareDoc, 'top');
ok(squareTop.islands.every(i => i.polys.length === 1),
  'a square pack routes at 45 degrees without crossing itself',
  squareTop.islands.map(i => i.polys.length).join(',') + ' loops');

/* a document saved before the option existed is a plate, unchanged */
const legacy = JSON.parse(JSON.stringify(doc));
delete legacy.params.cut;
delete legacy.params.lineAngle;
const legacyTop = G.buildSheet(legacy, 'top');
ok(legacyTop.islands.every((i, k) => Math.abs(i.area - top.islands[k].area) < 1e-9),
  'a file from before the option still builds the same plate');

/* switching the mode must miss the contour cache, or the plate would be
   reused as if it were a strip */
const cutCache = new Map();
const cachedPlate = G.buildSheet(doc, 'top', { cache: cutCache });
const cachedLines = G.buildSheet(lineDoc, 'top', { cache: cutCache });
ok(cachedLines.islands[0].polys !== cachedPlate.islands[0].polys,
  'switching the cut style re-contours the islands');
const cachedAgain = G.buildSheet(lineDoc, 'top', { cache: cutCache });
ok(cachedAgain.islands.every((i, k) => i.polys === cachedLines.islands[k].polys),
  'and the new shape is then cached');

/* a single cell and a pair still work */
ok(G.weldOrder([{ x: 0, y: 0 }], 90, 21.8).join() === '0', 'one cell is a route of one');
ok(G.weldOrder([{ x: 0, y: 0 }, { x: 21.8, y: 0 }], 90, 21.8).length === 2, 'two cells are a route of two');
const solo = {
  version: 1, name: 'solo', cellType: '21700', arrangement: 'hex',
  cells: [{ id: 'a', x: 0, y: 0, flip: false }],
  islands: { top: [{ id: 'x', name: 'X', color: '#4fc3f7', cells: ['a'] }], bottom: [] },
  params: { cellD: 21.2, gap: 0.6, pitch: 21.8, padD: 9.5, bridgeW: 6.5, kerf: 0.1, margin: 8, step: 0.1, cut: 'lines', lineAngle: 90 }
};
const soloSheet = G.buildSheet(solo, 'top');
ok(soloSheet.islands[0].parts === 1 && soloSheet.islands[0].polys.length === 1, 'one cell is one pad');

/* a saved file round-trips the two new fields */
const saved = JSON.parse(JSON.stringify(lineDoc));
ok(saved.params.cut === 'lines' && saved.params.lineAngle === 90, 'the cut style is part of the document');

/* the strip is a sheet you can print or cut like the plate, so the writers get
   the same exercise and the artefacts land in out/ */
const lineBot = G.buildSheet(lineDoc, 'bottom');
const lineSvg = G.toSVG([lineTop, lineBot]);
const lineDxf = G.toDXF([lineTop, lineBot]);
ok(lineSvg.indexOf('BOTTOM_CUT') > 0, 'the weld-line sheets export to svg', lineSvg.length + ' bytes');
ok(lineDxf.trim().endsWith('EOF'), 'and to dxf');
const lineMap = G.toPrint(lineDoc, lineTop, lineBot);
ok(lineMap.indexOf('weld-line cut') > 0, 'the assembly map says which cut it is');
fs.writeFileSync(path.join(OUT, 'pack-lines.svg'), lineSvg);
fs.writeFileSync(path.join(OUT, 'pack-lines.dxf'), lineDxf);
fs.writeFileSync(path.join(OUT, 'assembly-map-lines.svg'), lineMap);
writePreview(lineDoc, 'preview-lines.json');

/* ------------------------------------------------------------------ */
/* cell guide slits                                                    */
/* ------------------------------------------------------------------ */
/* A guide slit is a cut, so it has to behave like one: one per weld spot,
   inside the pad it marks, out of the metal area, carried by the writers,
   cached like the rest, and unable to shorten into something that would cut
   the pad free of the sheet. */

console.log('cell guide slits');
const slotAreaOf = list => list.reduce((s, loop) =>
  s + Math.abs(loop.reduce((a, p, i) => a + (loop[(i + loop.length - 1) % loop.length].x * p.y - p.x * loop[(i + loop.length - 1) % loop.length].y), 0) / 2), 0);

const gDoc = JSON.parse(JSON.stringify(doc));
gDoc.params.guides = true;
gDoc.params.guideL = 8;
gDoc.params.lineAngle = 0;
const gTop = G.buildSheet(gDoc, 'top');
const gIsl = gTop.islands[0];
const plateIsl = top.islands[0];

ok(gIsl.slots.length === gIsl.cells, 'one slit per weld spot',
  gIsl.slots.length + ' slits, ' + gIsl.cells + ' cells');
ok(gIsl.polys.length === plateIsl.polys.length && gIsl.parts === plateIsl.parts,
  'the outline itself is untouched', gIsl.parts + ' piece, ' + gIsl.polys.length + ' loops');
ok(gIsl.parts === 1, 'a slitted plate is still one piece');

const cutArea = slotAreaOf(gIsl.slots);
ok(cutArea > 0, 'the slits have real area', cutArea.toFixed(1) + ' mm2 over ' + gIsl.slots.length + ' slits');
ok(Math.abs(gIsl.area - (plateIsl.area - cutArea)) < 1e-6,
  'and they come straight out of the metal area',
  plateIsl.area.toFixed(1) + ' -> ' + gIsl.area.toFixed(1) + ' mm2');

/* every point of every slit has to be inside the pad it marks, or the cut
   would hang in the air and the pad would lose metal it needs */
let outside = 0, widest = 0, longest = 0;
for (let i = 0; i < gIsl.slots.length; i++) {
  const cell = gDoc.islands.top[0].cells[i];
  const at = G.cellOnFace(gDoc, frame, 'top', gDoc.cells.find(c => c.id === cell));
  const loop = gIsl.slots[i];
  const xs = loop.map(p => p.x), ys = loop.map(p => p.y);
  widest = Math.max(widest, Math.max(...xs) - Math.min(...xs));
  longest = Math.max(longest, Math.max(...ys) - Math.min(...ys));
  for (const p of loop) {
    if (Math.hypot(p.x - at.x, p.y - at.y) > gDoc.params.padD / 2) outside++;
  }
}
ok(outside === 0, 'every slit sits inside its pad', outside + ' points outside');
ok(Math.abs(widest - 8) < 0.01 && Math.abs(longest - 1.2) < 0.01,
  'at 0 degrees it is one pad wide and 1.2 mm tall',
  widest.toFixed(2) + ' x ' + longest.toFixed(2) + ' mm');

const turned = JSON.parse(JSON.stringify(gDoc));
turned.params.lineAngle = 90;
const tIsl = G.buildSheet(turned, 'top').islands[0];
const txs = tIsl.slots[0].map(p => p.x), tys = tIsl.slots[0].map(p => p.y);
ok(Math.abs((Math.max(...tys) - Math.min(...tys)) - 8) < 0.01 &&
   Math.abs((Math.max(...txs) - Math.min(...txs)) - 1.2) < 0.01,
  'and the angle turns the slit with the bands',
  (Math.max(...txs) - Math.min(...txs)).toFixed(2) + ' x ' + (Math.max(...tys) - Math.min(...tys)).toFixed(2));

/* asking for a slit longer than the pad can take is answered, not obeyed */
const greedy = JSON.parse(JSON.stringify(gDoc));
greedy.params.guideL = 40;
const gLen = G.buildSheet(greedy, 'top').islands[0].slots[0].map(p => p.x);
ok(Math.max(...gLen) - Math.min(...gLen) <= G.guideMaxLen(greedy.params) + 0.01,
  'a slit longer than the pad is cut down to the rim',
  (Math.max(...gLen) - Math.min(...gLen)).toFixed(2) + ' mm, limit ' + G.guideMaxLen(greedy.params).toFixed(2));
ok(G.guideMaxLen({ padD: 9.5 }) < G.guideMaxLen({ padD: 18 }),
  'a strip pad takes a shorter slit than a plate pad',
  G.guideMaxLen({ padD: 9.5 }).toFixed(1) + ' vs ' + G.guideMaxLen({ padD: 18 }).toFixed(1) + ' mm');

/* the bottom sheet is cut flat and flipped, so its slits are mirrored with it */
const gBot = G.buildSheet(gDoc, 'bottom');
const bSlot = gBot.islands[0].slots[0];
const bxs = bSlot.map(p => p.x);
ok(Math.abs((gTop.W - Math.max(...bxs)) - Math.min(...gIsl.slots[0].map(p => p.x))) < 0.01,
  'the bottom slits are mirrored with the sheet');

/* the writers carry the slits, since a cut file without them is a plate */
const gSvg = G.toSVG([gTop, gBot]);
const gDxf = G.toDXF([gTop, gBot]);
const slotsBoth = [gTop, gBot].reduce((s, sh) => s + sh.islands.reduce((a, i) => a + i.slots.length, 0), 0);
const plainBoth = [top, bot].reduce((s, sh) => s + sh.islands.reduce((a, i) => a + i.polys.length, 0), 0);
ok(gSvg.indexOf('TOP_CUT') > 0, 'the slitted sheets export to svg', gSvg.length + ' bytes');
const svgShapes = (gSvg.match(/ d="([^"]*)"/g) || [])
  .reduce((s, d) => s + (d.match(/M/g) || []).length, 0);
ok(svgShapes - plainBoth === slotsBoth,
  'with one extra contour per slit', (svgShapes - plainBoth) + ' extra contours for ' + slotsBoth + ' slits');
const dxfPolys = (gDxf.match(/POLYLINE/g) || []).length;
ok(dxfPolys - plainBoth === slotsBoth,
  'and the dxf has them as closed polylines', dxfPolys + ' polylines');
const gMap = G.toPrint(gDoc, gTop, gBot);
ok(gMap.indexOf('guide slits') > 0, 'the assembly map says the slits are there');

/* the slits are not in the distance field, so turning them on must not cost a
   re-trace of the sheet - the cache key has to stay the same */
const gCache = new Map();
const cachedPlain = G.buildSheet(doc, 'top', { cache: gCache });
const cachedSlits = G.buildSheet(gDoc, 'top', { cache: gCache });
ok(cachedSlits.islands[0].polys === cachedPlain.islands[0].polys,
  'turning the slits on reuses the plate it was already traced');

/* a document saved before the option existed has no slits at all */
const oldDoc = JSON.parse(JSON.stringify(doc));
delete oldDoc.params.guides;
delete oldDoc.params.guideL;
ok(G.buildSheet(oldDoc, 'top').islands[0].slots.length === 0, 'a file from before the option has no slits');

fs.writeFileSync(path.join(OUT, 'pack-guides.svg'), G.toSVG([gTop, gBot]));
fs.writeFileSync(path.join(OUT, 'pack-guides.dxf'), G.toDXF([gTop, gBot]));
fs.writeFileSync(path.join(OUT, 'assembly-map-guides.svg'), G.toPrint(gDoc, gTop, gBot));

/* ------------------------------------------------------------------ */
/* fast path                                                           */
/* ------------------------------------------------------------------ */
/* The contourer now evaluates a bucketed distance field on a coarser grid
   than the drawing tolerance, and buildSheet can reuse the contours of
   islands that did not change. Both are easy ways to be subtly wrong, so
   they are pinned here against the exact, brute-force implementation. */

console.log('fast distance field');
const byId = new Map(doc.cells.map(c => [c.id, c]));
const islandPts = doc.islands.top[0].cells.map(id => G.cellOnFace(doc, frame, 'top', byId.get(id)));
const islandPrims = G.islandPrimitives(islandPts, doc.params);
const bnd = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
for (const p of islandPrims) {
  bnd.x0 = Math.min(bnd.x0, p.bx0); bnd.y0 = Math.min(bnd.y0, p.by0);
  bnd.x1 = Math.max(bnd.x1, p.bx1); bnd.y1 = Math.max(bnd.y1, p.by1);
}
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const idx = G.sdfIndex(islandPrims, 0.34);
let worstNear = 0, signMiss = 0, insideSeen = 0;
for (let i = 0; i < 20000; i++) {
  const x = bnd.x0 + rnd() * (bnd.x1 - bnd.x0);
  const y = bnd.y0 + rnd() * (bnd.y1 - bnd.y0);
  const a = G.sdf(islandPrims, x, y);
  const b = G.sdfFast(idx, x, y);
  if ((a < 0) !== (b < 0)) signMiss++;
  if (a < 0) insideSeen++;
  /* every value an interpolation can touch is within one grid step */
  if (Math.abs(a) <= 0.34) worstNear = Math.max(worstNear, Math.abs(a - b));
}
ok(insideSeen > 1000, 'sampled inside the metal', insideSeen + ' of 20000');
ok(signMiss === 0, 'bucketed field never flips the sign', signMiss + ' misses');
ok(worstNear < 1e-6, 'bucketed field is exact within a grid step', worstNear.toExponential(1));

console.log('grid resolution');
const fineRef = G.contour(islandPrims, 0.1, null, null, { grid: 0.06, brute: true });
const fineArea = fineRef.reduce((s, p) => s + G.polyArea(p), 0);
const fastPolys = G.contour(islandPrims, 0.1);
const fastArea = fastPolys.reduce((s, p) => s + G.polyArea(p), 0);
ok(Math.abs(fastArea - fineArea) / fineArea < 0.002,
  'coarse grid matches the exact contour', fineArea.toFixed(1) + ' -> ' + fastArea.toFixed(1) + ' mm2');
ok(fastPolys.length === fineRef.length, 'same loop count as the exact contour', fastPolys.length);

/* a 1 mm strap is the thinnest thing the UI can make: it must still be one
   connected piece, not a row of loose pads */
const thin = JSON.parse(JSON.stringify(doc));
thin.params.bridgeW = 1;
const thinSheet = G.buildSheet(thin, 'top');
ok(thinSheet.islands.every(i => i.parts === 1), '1 mm straps keep every island in one piece',
  thinSheet.islands[0].parts + ' parts');

console.log('contour cache');
const cache = new Map();
const first = G.buildSheet(doc, 'top', { cache });
const again = G.buildSheet(doc, 'top', { cache });
ok(again.islands.every((i, k) => i.polys === first.islands[k].polys), 'a rebuild reuses cached contours');
ok(again.islands.every((i, k) => Math.abs(i.area - first.islands[k].area) < 1e-9), 'cached areas are identical');

const edited = JSON.parse(JSON.stringify(doc));
edited.islands.top[0].cells.pop();
const afterEdit = G.buildSheet(edited, 'top', { cache });
ok(afterEdit.islands.slice(1).every((i, k) => i.polys === first.islands[k + 1].polys),
  'only the edited island is re-contoured');
ok(afterEdit.islands[0].polys !== first.islands[0].polys, 'the edited island is rebuilt');

/* a param change must invalidate everything, including the cached islands */
const wider = JSON.parse(JSON.stringify(doc));
wider.params.padD = 20;
const wide = G.buildSheet(wider, 'top', { cache });
ok(wide.islands.every((i, k) => i.polys !== first.islands[k].polys), 'a parameter change rebuilds every island');

const tFresh = Date.now();
for (let i = 0; i < 10; i++) G.buildSheet(doc, 'top', { cache: new Map() });
const freshMs = (Date.now() - tFresh) / 10;
const tWarm = Date.now();
for (let i = 0; i < 10; i++) G.buildSheet(doc, 'top', { cache });
const warmMs = (Date.now() - tWarm) / 10;
ok(warmMs * 4 < freshMs, 'a cached rebuild is far cheaper',
  freshMs.toFixed(1) + ' ms fresh -> ' + warmMs.toFixed(1) + ' ms cached');

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */
const svg = G.toSVG([top, bot]);
ok(svg.indexOf('<svg') > 0, 'svg header');
ok((svg.match(/Z/g) || []).length >= 14, 'svg has closed paths', (svg.match(/Z/g) || []).length);
fs.writeFileSync(path.join(OUT, 'pack.svg'), svg);
fs.writeFileSync(path.join(OUT, 'pack-top.svg'), G.toSVG([top]));
fs.writeFileSync(path.join(OUT, 'pack-bottom.svg'), G.toSVG([bot]));

const dxf = G.toDXF([top, bot]);
ok(dxf.indexOf('AC1009') > 0, 'dxf is R12');
ok((dxf.match(/POLYLINE/g) || []).length >= 2, 'dxf has polylines', (dxf.match(/POLYLINE/g) || []).length);
ok(dxf.trim().endsWith('EOF'), 'dxf terminates');
fs.writeFileSync(path.join(OUT, 'pack.dxf'), dxf);
fs.writeFileSync(path.join(OUT, 'pack-top.dxf'), G.toDXF([top]));

const print = G.toPrint(doc, top, bot);
ok(print.indexOf('<svg') > 0, 'print sheet');
fs.writeFileSync(path.join(OUT, 'assembly-map.svg'), print);

/* preview payload for tests/preview.py */
function writePreview(d, name) {
  const fr = G.frameOf(d);
  const t = G.buildSheet(d, 'top');
  const b = G.buildSheet(d, 'bottom');
  const p = { W: fr.W, H: fr.H, groups: [] };
  for (const sh of [t, b]) {
    for (const isl of sh.islands) p.groups.push({ face: sh.face, color: isl.color, loops: isl.polys });
  }
  p.cells = d.cells.map(c => {
    const q = G.cellOnFace(d, fr, 'top', c);
    return { x: q.x, y: q.y, r: d.params.cellD / 2 };
  });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(p));
  return { top: t, bottom: b };
}
writePreview(doc, 'preview.json');

/* A rotated one-piece plate with the middle cell taken out. The outline has
   to come back with a clean round hole - a void enclosed by metal - and still
   count as one piece. */
const plate = JSON.parse(JSON.stringify(doc));
const allIds = plate.cells.map(c => c.id);
plate.islands.top = [{ id: 'tp', name: 'TOP PLATE', color: '#4fc3f7', cells: allIds.slice() }];
plate.islands.bottom = [{ id: 'bp', name: 'BOT PLATE', color: '#aed581', cells: allIds.slice() }];
G.rotateDoc(plate, true);
const pfr = G.frameOf(plate);
const pcx = pfr.W / 2 - pfr.ox, pcy = pfr.H / 2 - pfr.oy;
let mid = plate.cells[0], midD = Infinity;
for (const c of plate.cells) {
  const d2 = (c.x - pcx) * (c.x - pcx) + (c.y - pcy) * (c.y - pcy);
  if (d2 < midD) { midD = d2; mid = c; }
}
removeCell(plate, mid.id);
const plateSheets = writePreview(plate, 'preview-rot.json');
const rotHole = plateSheets.top.islands.find(i => i.polys.length > 1);
ok(!!rotHole, 'a removed interior cell leaves a hole in the plate',
  rotHole ? rotHole.polys.length + ' loops' : 'no hole found');
if (rotHole) {
  const hole = rotHole.polys.filter(p => G.polyArea(p) < 0)[0];
  ok(!!hole && rotHole.parts === 1, 'hole is one negative loop inside one piece',
    hole ? 'hole area ' + Math.abs(G.polyArea(hole)).toFixed(0) + ' mm2' : 'no inner loop');
}
fs.writeFileSync(path.join(OUT, 'pack-rotated.svg'), G.toSVG([plateSheets.top, plateSheets.bottom]));

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
