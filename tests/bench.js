/* Timing harness for the geometry core.
 *
 *   node tests/bench.js            run the default set
 *   node tests/bench.js --json     machine readable
 *
 * Measures the numbers the app shows in the "Build" field: one full rebuild
 * (both faces) of a stripe-laid pack, plus the cheaper operations that run on
 * every pointer move. Keep this honest - it is the only way to tell whether a
 * change made the tool faster or just different.
 */
const G = require('../geometry.js');

const now = () => Number(process.hrtime.bigint()) / 1e6;

const PALETTE = ['#4fc3f7', '#aed581', '#ffb74d', '#ba68c8', '#4db6ac', '#e57373', '#fff176', '#9575cd'];

function makeDoc(rows, cols, cellD = 21.2, gap = 0.6) {
  const pitch = cellD + gap;
  const rowH = pitch * Math.sqrt(3) / 2;
  const cells = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    const odd = r % 2 === 1;
    const n = odd ? cols - 1 : cols;
    const xOff = odd ? pitch / 2 : 0;
    for (let c = 0; c < n; c++) {
      cells.push({ id: 'c' + (id++), x: c * pitch + xOff, y: r * rowH, flip: false, row: r });
    }
  }
  const doc = {
    version: 1, name: 'bench', cellType: '21700', arrangement: 'hex',
    cells, islands: { top: [], bottom: [] },
    params: { cellD, gap, pitch, padD: 18, bridgeW: 18, kerf: 0.1, margin: 8, step: 0.1 }
  };
  let ti = 0, bi = 0;
  for (let r = 0; r < rows; r += 2) {
    const ids = cells.filter(c => c.row >= r && c.row < r + 2).map(c => c.id);
    doc.islands.top.push({ id: 't' + ti, name: 'TOP ' + (++ti), color: PALETTE[ti % 8], cells: ids });
  }
  const b0 = cells.filter(c => c.row === 0).map(c => c.id);
  doc.islands.bottom.push({ id: 'b0', name: 'BOT 1', color: PALETTE[1], cells: b0 });
  for (let r = 1; r < rows; r += 2) {
    const ids = cells.filter(c => c.row >= r && c.row < r + 2).map(c => c.id);
    doc.islands.bottom.push({ id: 'b' + (++bi), name: 'BOT ' + (bi + 1), color: PALETTE[bi % 8], cells: ids });
  }
  return doc;
}

/* median of n runs - a single sample is noise on a busy machine */
function time(n, fn) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    fn();
    runs.push(now() - t);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

const json = process.argv.includes('--json');
const out = { version: G.version, cases: [] };

function report(label, data) {
  out.cases.push(Object.assign({ label }, data));
  if (json) return;
  console.log(label);
  for (const k of Object.keys(data)) {
    const v = data[k];
    console.log('  ' + k.padEnd(22) + (typeof v === 'number' ? v.toFixed(2) : v));
  }
}

for (const [label, rows, cols] of [['98 cells, 8+8 islands', 13, 8], ['250 cells, 10+10 islands', 20, 12]]) {
  const doc = makeDoc(rows, cols);
  const frame = G.frameOf(doc);

  const one = time(7, () => G.buildSheet(doc, 'top'));
  const both = time(7, () => { G.buildSheet(doc, 'top'); G.buildSheet(doc, 'bottom'); });
  const diag = time(11, () => G.diagnose(doc));
  const fr = time(11, () => G.frameOf(doc));

  /* one island on its own - this is the cost of painting a single cell */
  const solo = { ...doc, islands: { top: [doc.islands.top[0]], bottom: [] } };
  const oneIsland = time(7, () => G.buildSheet(solo, 'top'));

  /* what the app actually does when you delete a cell: both faces rebuilt
     with the island cache warm, so only the islands that lost the cell are
     re-contoured. This is the number that decides how it feels. */
  const cut = JSON.parse(JSON.stringify(doc));
  const pre = { top: new Map(), bottom: new Map() };
  G.buildSheet(cut, 'top', { cache: pre.top });
  G.buildSheet(cut, 'bottom', { cache: pre.bottom });
  const victim = cut.cells[Math.floor(cut.cells.length / 2)];
  cut.cells = cut.cells.filter(c => c.id !== victim.id);
  for (const f of ['top', 'bottom']) for (const i of cut.islands[f]) i.cells = i.cells.filter(x => x !== victim.id);
  const editMs = time(11, () => {
    G.buildSheet(cut, 'top', { cache: new Map(pre.top) });
    G.buildSheet(cut, 'bottom', { cache: new Map(pre.bottom) });
  });

  /* the weld-line cut traces one route per island instead of a mesh of
     straps, so it is the cheapest shape the tool can build */
  const lines = JSON.parse(JSON.stringify(doc));
  lines.params.cut = 'lines';
  lines.params.lineAngle = 90;
  lines.params.padD = 9.5;
  lines.params.bridgeW = 6.5;
  const linesBoth = time(7, () => { G.buildSheet(lines, 'top'); G.buildSheet(lines, 'bottom'); });

  /* the guide slits are a cut per weld spot, but they cost no tracing: the
     plate is the one that was already built, and the slots are a polygon each */
  const guides = JSON.parse(JSON.stringify(doc));
  guides.params.guides = true;
  guides.params.guideL = 8;
  const guidesBoth = time(7, () => { G.buildSheet(guides, 'top'); G.buildSheet(guides, 'bottom'); });

  report(label, {
    'cells': doc.cells.length,
    'islands per face': doc.islands.top.length + '/' + doc.islands.bottom.length,
    'sheet mm': frame.W.toFixed(0) + ' x ' + frame.H.toFixed(0),
    'one sheet ms': one,
    'both sheets ms': both,
    'both sheets as lines': linesBoth,
    'both with guide slits': guidesBoth,
    'one island ms': oneIsland,
    'delete one cell ms': editMs,
    'diagnose ms': diag,
    'frameOf ms': fr
  });
}

if (json) console.log(JSON.stringify(out, null, 1));
