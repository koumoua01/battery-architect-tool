/* Battery Architect - connection layer geometry core.
 *
 * Loads as a plain <script> (window.BAGeo) and as a CommonJS module.
 * No dependencies. Units are millimetres throughout.
 *
 * An "island" is one connected piece of sheet metal on one face of the pack.
 * Its shape is the union of:
 *   - a weld pad (disc) over every cell terminal it connects, and
 *   - a strap (capsule) along every edge of the minimum spanning tree of
 *     those cells, so the piece is always one connected body.
 * The union is contoured numerically (signed distance field + marching
 * squares) and then simplified, which gives clean polylines for DXF/SVG.
 * Kerf compensation is applied by inflating every primitive by kerf/2 before
 * contouring, which is exactly a Minkowski offset of the union outward.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BAGeo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* basics                                                              */
  /* ------------------------------------------------------------------ */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function r4(v) { return Math.round(v * 1e4) / 1e4; }

  function polyArea(p) {
    var a = 0;
    for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
      a += (p[j].x * p[i].y - p[i].x * p[j].y);
    }
    return a / 2;
  }

  function pointInPoly(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if ((yi > pt.y) !== (yj > pt.y) && pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-12) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function bounds(polys) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (var i = 0; i < polys.length; i++) {
      for (var k = 0; k < polys[i].length; k++) {
        var p = polys[i][k];
        if (p.x < b.x0) b.x0 = p.x;
        if (p.y < b.y0) b.y0 = p.y;
        if (p.x > b.x1) b.x1 = p.x;
        if (p.y > b.y1) b.y1 = p.y;
      }
    }
    return b;
  }

  /* ------------------------------------------------------------------ */
  /* minimum spanning tree - keeps every island one connected body       */
  /* ------------------------------------------------------------------ */

  function mst(pts) {
    var n = pts.length, out = [];
    if (n < 2) return out;
    var edges = [];
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
        edges.push([i, j, dx * dx + dy * dy]);
      }
    }
    edges.sort(function (a, b) { return a[2] - b[2]; });
    var par = new Int32Array(n);
    for (var k = 0; k < n; k++) par[k] = k;
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    for (var e = 0; e < edges.length; e++) {
      var ra = find(edges[e][0]), rb = find(edges[e][1]);
      if (ra !== rb) {
        par[ra] = rb;
        out.push([edges[e][0], edges[e][1]]);
        if (out.length === n - 1) break;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* connection graph                                                    */
  /*
   * A minimum spanning tree is the wrong connector for a sheet: it is
   * minimal but produces long single-strand necks, and on a hex lattice the
   * in-row and diagonal distances are identical, so the tie-break decides
   * the shape. Instead connect every pair of cells that are near neighbours
   * of each other, which fills the gaps between cell rows and gives a shape
   * with no weak points. Each cell is also always tied to its own nearest
   * neighbour, so nothing can be left dangling.
   */
  /* ------------------------------------------------------------------ */

  function neighbourPairs(pts) {
    var n = pts.length, out = [];
    if (n < 2) return out;
    var i, j, dx, dy, d2;
    var d2m = [];
    for (i = 0; i < n; i++) {
      var best = Infinity;
      for (j = 0; j < n; j++) {
        if (i === j) continue;
        dx = pts[i].x - pts[j].x; dy = pts[i].y - pts[j].y;
        d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      d2m.push(best);
    }
    var sorted = d2m.slice().sort(function (a, b) { return a - b; });
    var median = Math.sqrt(sorted[Math.floor(sorted.length / 2)]);
    var thr = median * 1.08;
    var thr2 = thr * thr;

    var linked = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        dx = pts[i].x - pts[j].x; dy = pts[i].y - pts[j].y;
        d2 = dx * dx + dy * dy;
        if (d2 <= thr2) {
          out.push([i, j]);
          linked[i] = 1; linked[j] = 1;
        }
      }
    }
    /* guarantee no island fragment is left unconnected */
    for (i = 0; i < n; i++) {
      if (linked[i]) continue;
      var bi = -1, bd = Infinity;
      for (j = 0; j < n; j++) {
        if (i === j) continue;
        dx = pts[i].x - pts[j].x; dy = pts[i].y - pts[j].y;
        d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; bi = j; }
      }
      if (bi >= 0) out.push([Math.min(i, bi), Math.max(i, bi)]);
    }
    return out;
  }

  /*
   * Every primitive caches what the distance function needs: the segment
   * vector, its inverse length squared and its bounding box. The contourer
   * evaluates tens of millions of distances per sheet, and recomputing those
   * per sample was most of the old build time.
   */
  function prim(x1, y1, x2, y2, r) {
    var dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    return {
      x1: x1, y1: y1, x2: x2, y2: y2, r: r,
      dx: dx, dy: dy, inv: l2 > 1e-12 ? 1 / l2 : 0,
      bx0: Math.min(x1, x2) - r, by0: Math.min(y1, y2) - r,
      bx1: Math.max(x1, x2) + r, by1: Math.max(y1, y2) + r
    };
  }

  /* ------------------------------------------------------------------ */
  /* weld-line routing                                                   */
  /*
   * "Cut to the weld lines" keeps the metal only where it has to be: a pad on
   * every terminal and one band from pad to pad, so the island is a routed
   * strip instead of a plate. The free metal between two neighbouring bands
   * then falls out as a slot, which is what turns the strip into a lattice and
   * lets it sit flat on cells that are not all exactly the same height.
   *
   * The route is a boustrophedon in a frame turned by the angle: the cells are
   * split into bands across the direction the metal runs - the same "cells at
   * the same height are a row" rule the rest of the app uses - each band is
   * walked end to end, and the next one is picked up at that same end, so the
   * path never doubles back over itself and every cell is visited once.
   *
   * A path rather than a mesh of thin links, because a narrow mesh is what you
   * already get by lowering Strap W: it looks like a plate with small holes.
   * This is the shape of the reference strip - continuous metal, one clear
   * current path, slots wide enough to flex.
   */
  /* ------------------------------------------------------------------ */

  function weldOrder(pts, angleDeg, pitch) {
    var n = pts.length;
    var i;
    if (n < 2) return n ? [0] : [];
    var a = (angleDeg || 0) * Math.PI / 180;
    var ca = Math.cos(a), sa = Math.sin(a);
    var u = new Array(n), v = new Array(n);
    for (i = 0; i < n; i++) {
      u[i] = pts[i].x * ca + pts[i].y * sa;
      v[i] = -pts[i].x * sa + pts[i].y * ca;
    }
    var byV = [];
    for (i = 0; i < n; i++) byV.push(i);
    byV.sort(function (p, q) { return v[p] - v[q] || u[p] - u[q]; });

    /* 0.45 of the pitch: the tolerance the app already uses to call cells a
       row, so a band here means the same thing as a row there */
    var tol = Math.max(1.5, (pitch || 20) * 0.45);
    var out = [];
    var band = [];
    var prev = v[byV[0]];
    var tail = -1;

    function dist2(p, q) {
      var dx = pts[p].x - pts[q].x, dy = pts[p].y - pts[q].y;
      return dx * dx + dy * dy;
    }

    function flush() {
      if (!band.length) return;
      band.sort(function (p, q) { return u[p] - u[q]; });
      /* walk each band from the end nearest the free end of the strip, which
         is what makes the route a boustrophedon on a lattice and keeps the
         step into a short band short when the bands are not the same length */
      if (tail >= 0 && dist2(tail, band[0]) > dist2(tail, band[band.length - 1])) band.reverse();
      for (var b = 0; b < band.length; b++) out.push(band[b]);
      tail = band[band.length - 1];
      band = [];
    }

    for (i = 0; i < n; i++) {
      var j = byV[i];
      if (i && v[j] - prev > tol) flush();
      band.push(j);
      prev = v[j];
    }
    flush();
    return out;
  }

  function islandPrimitives(pts, params) {
    var kerf = params.kerf || 0;
    var rPad = params.padD / 2 + kerf / 2;
    var rStrap = Math.max(params.bridgeW, 0.4) / 2 + kerf / 2;
    var prims = [];
    var i;
    for (i = 0; i < pts.length; i++) {
      prims.push(prim(pts[i].x, pts[i].y, pts[i].x, pts[i].y, rPad));
    }
    var seg;
    if (params.cut === 'lines') {
      /* one band from weld spot to weld spot; the pads stay, so the strip is
         still wide where the welder actually lands */
      var order = weldOrder(pts, params.lineAngle || 0, params.pitch);
      seg = [];
      for (i = 1; i < order.length; i++) seg.push([order[i - 1], order[i]]);
    } else {
      seg = neighbourPairs(pts);
    }
    for (var k = 0; k < seg.length; k++) {
      var a = pts[seg[k][0]], b = pts[seg[k][1]];
      prims.push(prim(a.x, a.y, b.x, b.y, rStrap));
    }
    return prims;
  }

  /* distance from (x,y) to one capsule, negative inside */
  function primDist(q, x, y) {
    var t = 0;
    if (q.inv) {
      t = ((x - q.x1) * q.dx + (y - q.y1) * q.dy) * q.inv;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    var ex = q.x1 + t * q.dx - x, ey = q.y1 + t * q.dy - y;
    return Math.sqrt(ex * ex + ey * ey) - q.r;
  }

  function primsBounds(prims) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (var i = 0; i < prims.length; i++) {
      var p = prims[i];
      if (p.bx0 < b.x0) b.x0 = p.bx0;
      if (p.by0 < b.y0) b.y0 = p.by0;
      if (p.bx1 > b.x1) b.x1 = p.bx1;
      if (p.by1 > b.y1) b.y1 = p.by1;
    }
    return b;
  }

  /* Signed distance to the union of primitives: negative = inside.
     This is the exact reference implementation - every primitive is tested.
     Users of it pay for that; contour() uses the bucketed version below. */
  function sdf(prims, x, y) {
    var best = Infinity;
    for (var i = 0; i < prims.length; i++) {
      var q = prims[i];
      var limit = best + q.r;
      if (limit <= 0) continue;
      var d = primDist(q, x, y);
      if (d < best) best = d;
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* spatial index                                                       */
  /*
   * A bucketed distance field. Each primitive is filed under every bucket
   * that its bounding box, grown by one grid step, touches; a sample looks
   * at its own bucket only.
   *
   * One grid step is the right amount to grow by, and it is worth spelling
   * out why. The distance function is 1-Lipschitz, so of the two samples
   * that straddle a contour crossing, one is inside the metal and the other
   * is within one step of the boundary. A primitive within one step of a
   * sample always has that sample in its filing box, so both values that
   * the crossing interpolation uses are exact. Samples further than a step
   * away never touch an interpolation - only their sign is used, and the
   * sign is exact because anything that covers a point has its box over it.
   *
   * Buckets keep the pads and the straps apart. Every pad has the same
   * radius and so does every strap, so the minimum can be taken over
   * squared distances and square-rooted once per group instead of once
   * per primitive.
   */
  /* ------------------------------------------------------------------ */

  function sdfIndex(prims, grow) {
    grow = grow || 0;
    var maxR = 1, i;
    for (i = 0; i < prims.length; i++) if (prims[i].r > maxR) maxR = prims[i].r;
    var bs = Math.max(2, maxR);
    var b = primsBounds(prims);
    var ox = b.x0 - grow - 1, oy = b.y0 - grow - 1;
    var nx = Math.max(1, Math.ceil((b.x1 - b.x0 + 2 * grow + 2) / bs));
    var ny = Math.max(1, Math.ceil((b.y1 - b.y0 + 2 * grow + 2) / bs));
    var cells = new Array(nx * ny);
    var rPad = 0, rStrap = 0;
    for (i = 0; i < prims.length; i++) {
      var q = prims[i];
      if (q.inv) rStrap = q.r; else rPad = q.r;
      var i0 = Math.floor((q.bx0 - grow - ox) / bs), i1 = Math.floor((q.bx1 + grow - ox) / bs);
      var j0 = Math.floor((q.by0 - grow - oy) / bs), j1 = Math.floor((q.by1 + grow - oy) / bs);
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (i1 >= nx) i1 = nx - 1;
      if (j1 >= ny) j1 = ny - 1;
      for (var j = j0; j <= j1; j++) {
        for (var k = i0; k <= i1; k++) {
          var at = j * nx + k;
          var bucket = cells[at] || (cells[at] = { p: [], s: [] });
          (q.inv ? bucket.s : bucket.p).push(q);
        }
      }
    }
    return {
      prims: prims, bs: bs, ox: ox, oy: oy, nx: nx, ny: ny, cells: cells,
      rPad: rPad, rStrap: rStrap, far: Math.max(1, grow + 0.5)
    };
  }

  function sdfFast(idx, x, y) {
    var ix = Math.floor((x - idx.ox) / idx.bs);
    var iy = Math.floor((y - idx.oy) / idx.bs);
    if (ix < 0) ix = 0; else if (ix >= idx.nx) ix = idx.nx - 1;
    if (iy < 0) iy = 0; else if (iy >= idx.ny) iy = idx.ny - 1;
    var bucket = idx.cells[iy * idx.nx + ix];
    if (!bucket) return idx.far;

    var list = bucket.p, i, q, ex, ey, d2, m = Infinity, best = Infinity;
    for (i = 0; i < list.length; i++) {
      q = list[i];
      ex = q.x1 - x; ey = q.y1 - y;
      d2 = ex * ex + ey * ey;
      if (d2 < m) m = d2;
    }
    if (m !== Infinity) best = Math.sqrt(m) - idx.rPad;

    list = bucket.s;
    m = Infinity;
    for (i = 0; i < list.length; i++) {
      q = list[i];
      var t = ((x - q.x1) * q.dx + (y - q.y1) * q.dy) * q.inv;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      ex = q.x1 + t * q.dx - x; ey = q.y1 + t * q.dy - y;
      d2 = ex * ex + ey * ey;
      if (d2 < m) m = d2;
    }
    if (m !== Infinity) {
      var d = Math.sqrt(m) - idx.rStrap;
      if (d < best) best = d;
    }
    return best === Infinity ? idx.far : best;
  }

  /* ------------------------------------------------------------------ */
  /* marching squares                                                    */
  /* ------------------------------------------------------------------ */

  /* The grid does not need to be as fine as the drawing tolerance. The
     boundary is a smooth arc of constant curvature, so linear interpolation
     across a grid edge lands within step^2/(8R) of the true arc - a quarter
     of a thousandth of a millimetre at 0.24 mm. What is left is the chord
     error of the output polyline, which is the simplification tolerance and
     therefore what the user's detail setting controls. Decoupling the two is
     worth an order of magnitude: the grid is the expensive part and it no
     longer has to follow the slider. */
  function gridStep(wanted, prims) {
    var g = Math.max(wanted || 0.1, 0.34);
    /* never step over a strap that is thinner than the grid */
    var minR = Infinity;
    for (var i = 0; i < prims.length; i++) if (prims[i].r < minR) minR = prims[i].r;
    if (isFinite(minR) && minR * 2 < g) g = Math.max(0.08, minR * 1.5);
    return clamp(g, 0.05, 1.0);
  }

  function contour(prims, stepWanted, budget, stats, opts) {
    opts = opts || {};
    budget = budget || 1600000;
    var clk = (typeof performance !== 'undefined' && performance.now)
      ? function () { return performance.now(); } : Date.now;
    var t0 = clk();
    var tol = Math.max(0.02, (stepWanted || 0.1) * 0.34);
    var b = primsBounds(prims);
    var step = opts.grid || gridStep(stepWanted, prims);
    var pad = 3 * step;
    var x0 = b.x0 - pad, y0 = b.y0 - pad;
    var x1 = b.x1 + pad, y1 = b.y1 + pad;
    var nx = Math.ceil((x1 - x0) / step);
    var ny = Math.ceil((y1 - y0) / step);
    var guard = 0;
    while ((nx + 1) * (ny + 1) > budget && guard++ < 40) {
      step *= 1.25;
      nx = Math.ceil((x1 - x0) / step);
      ny = Math.ceil((y1 - y0) / step);
    }
    if (nx < 2 || ny < 2) return [];
    if (nx > 4000) { step *= nx / 4000; nx = 4000; ny = Math.ceil((y1 - y0) / step); }

    var W = nx + 1;
    var f = new Float32Array(W * (ny + 1));
    var idx = opts.brute ? null : sdfIndex(prims, step);
    for (var j = 0; j <= ny; j++) {
      var yy = y0 + j * step;
      var row = j * W;
      for (var i = 0; i <= nx; i++) {
        var xx = x0 + i * step;
        f[row + i] = idx ? sdfFast(idx, xx, yy) : sdf(prims, xx, yy);
      }
    }

    var t1 = clk();
    var segs = [];
    var xAt = function (i) { return x0 + i * step; };
    var yAt = function (j) { return y0 + j * step; };

    function hPt(i, j) {
      var a = f[j * W + i], c = f[j * W + i + 1];
      var t = (a === c) ? 0.5 : a / (a - c);
      return { key: 'h' + i + ',' + j, x: xAt(i) + t * step, y: yAt(j) };
    }
    function vPt(i, j) {
      var a = f[j * W + i], c = f[(j + 1) * W + i];
      var t = (a === c) ? 0.5 : a / (a - c);
      return { key: 'v' + i + ',' + j, x: xAt(i), y: yAt(j) + t * step };
    }
    function push(a, c) {
      segs.push({ ka: a.key, kb: c.key, ax: a.x, ay: a.y, bx: c.x, by: c.y });
    }

    for (var jj = 0; jj < ny; jj++) {
      var row0 = jj * W, row1 = (jj + 1) * W;
      for (var ii = 0; ii < nx; ii++) {
        var c = 0;
        if (f[row0 + ii] < 0) c |= 1;
        if (f[row0 + ii + 1] < 0) c |= 2;
        if (f[row1 + ii + 1] < 0) c |= 4;
        if (f[row1 + ii] < 0) c |= 8;
        if (c === 0 || c === 15) continue;

        switch (c) {
          case 1: push(vPt(ii, jj), hPt(ii, jj)); break;
          case 2: push(hPt(ii, jj), vPt(ii + 1, jj)); break;
          case 3: push(vPt(ii, jj), vPt(ii + 1, jj)); break;
          case 4: push(vPt(ii + 1, jj), hPt(ii, jj + 1)); break;
          case 5: {
            var mid = (f[row0 + ii] + f[row0 + ii + 1] + f[row1 + ii + 1] + f[row1 + ii]) / 4;
            if (mid < 0) { push(hPt(ii, jj), vPt(ii + 1, jj)); push(hPt(ii, jj + 1), vPt(ii, jj)); }
            else { push(vPt(ii, jj), hPt(ii, jj)); push(vPt(ii + 1, jj), hPt(ii, jj + 1)); }
            break;
          }
          case 6: push(hPt(ii, jj), hPt(ii, jj + 1)); break;
          case 7: push(vPt(ii, jj), hPt(ii, jj + 1)); break;
          case 8: push(hPt(ii, jj + 1), vPt(ii, jj)); break;
          case 9: push(hPt(ii, jj), hPt(ii, jj + 1)); break;
          case 10: {
            var mid2 = (f[row0 + ii] + f[row0 + ii + 1] + f[row1 + ii + 1] + f[row1 + ii]) / 4;
            if (mid2 < 0) { push(vPt(ii, jj), hPt(ii, jj)); push(vPt(ii + 1, jj), hPt(ii, jj + 1)); }
            else { push(hPt(ii, jj), vPt(ii + 1, jj)); push(hPt(ii, jj + 1), vPt(ii, jj)); }
            break;
          }
          case 11: push(vPt(ii + 1, jj), hPt(ii, jj + 1)); break;
          case 12: push(vPt(ii + 1, jj), vPt(ii, jj)); break;
          case 13: push(hPt(ii, jj), vPt(ii + 1, jj)); break;
          case 14: push(vPt(ii, jj), hPt(ii, jj)); break;
        }
      }
    }

    var t2 = clk();
    if (!segs.length) return [];

    var byKey = Object.create(null);
    for (var s = 0; s < segs.length; s++) {
      var sg = segs[s];
      (byKey[sg.ka] || (byKey[sg.ka] = [])).push(s);
      (byKey[sg.kb] || (byKey[sg.kb] = [])).push(s);
    }

    var used = new Uint8Array(segs.length);
    var loops = [];
    for (var start = 0; start < segs.length; start++) {
      if (used[start]) continue;
      var loop = [];
      var cur = start;
      var key = segs[start].ka;
      var n = 0;
      while (n++ < segs.length + 4) {
        used[cur] = 1;
        var sc = segs[cur];
        var fromA = (sc.ka === key);
        loop.push({ x: fromA ? sc.ax : sc.bx, y: fromA ? sc.ay : sc.by });
        var outKey = fromA ? sc.kb : sc.ka;
        var cands = byKey[outKey] || [];
        var nxt = -1;
        for (var q = 0; q < cands.length; q++) {
          if (!used[cands[q]]) { nxt = cands[q]; break; }
        }
        if (nxt === -1) break;
        cur = nxt;
        key = outKey;
        if (cur === start) break;
      }
      if (loop.length >= 3) loops.push(loop);
    }

    var t3 = clk();
    var out = [];
    var rawLengths = [];
    for (var L = 0; L < loops.length; L++) {
      rawLengths.push(loops[L].length);
      var simp = simplify(loops[L], tol);
      if (simp.length >= 3 && Math.abs(polyArea(simp)) > 0.01) out.push(simp);
    }
    if (stats) {
      stats.segs = segs.length;
      stats.keys = Object.keys(byKey).length;
      stats.rawLoops = rawLengths;
      stats.kept = out.length;
      stats.step = step;
      stats.tol = tol;
      stats.msSdf = t1 - t0;
      stats.msGrid = t2 - t1;
      stats.msStitch = t3 - t2;
    }
    return orientLoops(out);
  }

  /* ------------------------------------------------------------------ */
  /* polyline simplification (Douglas-Peucker)                           */
  /* ------------------------------------------------------------------ */

  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    var keep = new Uint8Array(pts.length);
    keep[0] = 1;
    keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    var tol2 = tol * tol;
    while (stack.length) {
      var seg = stack.pop();
      var a = seg[0], b = seg[1];
      var ax = pts[a].x, ay = pts[a].y;
      var bx = pts[b].x, by = pts[b].y;
      var dx = bx - ax, dy = by - ay;
      var l2 = dx * dx + dy * dy;
      var bestD = -1, bestI = -1;
      for (var i = a + 1; i < b; i++) {
        var px = pts[i].x - ax, py = pts[i].y - ay;
        var t = l2 > 1e-12 ? (px * dx + py * dy) / l2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var ex = px - t * dx, ey = py - t * dy;
        var d2 = ex * ex + ey * ey;
        if (d2 > bestD) { bestD = d2; bestI = i; }
      }
      if (bestD > tol2 && bestI > 0) {
        keep[bestI] = 1;
        stack.push([a, bestI]);
        stack.push([bestI, b]);
      }
    }
    var out = [];
    for (var k = 0; k < pts.length; k++) {
      if (!keep[k]) continue;
      if (out.length) {
        var last = out[out.length - 1];
        if (Math.abs(last.x - pts[k].x) < 1e-6 && Math.abs(last.y - pts[k].y) < 1e-6) continue;
      }
      out.push(pts[k]);
    }
    return out;
  }

  /* outer loops positive area, holes negative (by nesting depth) */
  function orientLoops(loops) {
    var info = [];
    for (var i = 0; i < loops.length; i++) {
      var probe = loops[i][0];
      var depth = 0;
      for (var j = 0; j < loops.length; j++) {
        if (i === j) continue;
        if (pointInPoly(probe, loops[j])) depth++;
      }
      info.push({ depth: depth, area: polyArea(loops[i]) });
    }
    var order = [];
    for (var k = 0; k < loops.length; k++) order.push(k);
    order.sort(function (a, b) { return info[a].depth - info[b].depth; });
    var out = [];
    for (var o = 0; o < order.length; o++) {
      var idx = order[o];
      var loop = loops[idx];
      var wantPositive = (info[idx].depth % 2 === 0);
      var a = info[idx].area;
      if ((a > 0) !== wantPositive) loop = loop.slice().reverse();
      out.push(loop);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* cell guide slits                                                    */
  /*
   * A plate is blind: the cells are underneath it, and a spot welder has to
   * guess where each terminal sits. The strips on the market answer this with
   * a short slit through every weld spot - a line you can see, feel and line
   * the electrode up on, and one that lets the strip give a little over a
   * terminal that stands proud of the rest.
   *
   * The slit is a cut, not a mark. It is a narrow stadium with a real width,
   * so it reaches the cutter as its own closed contour and comes back as a
   * slot in the plate. It is kept shorter than the pad, and that is the whole
   * safety argument: the rim beyond each end of the slit is what still joins
   * the two halves of the weld spot, so the island cannot be cut in two by
   * something that is only there to show where to weld.
   */
  /* ------------------------------------------------------------------ */

  /* 1.2 mm: wide enough to see and to cut, narrow enough that even a 9.5 mm
     strip pad keeps a solid rim on both sides of it */
  var GUIDE_W = 1.2;

  /* The longest slit worth cutting. Two limits, and the tighter one wins. It
     has to stay inside the pad, or the pad would be cut free of the sheet; and
     it has to leave a rim at both ends wide enough to carry what the pad
     carries. The second is the one that matters on a routed strip, where the
     band is narrow and the pad is the only place the current can spread. */
  function guideMaxLen(params) {
    var pad = params.padD || 18;
    return Math.max(0, Math.min(pad * 0.6, pad - GUIDE_W - 0.6));
  }

  /* One slit, as a closed loop wound against the metal so that it reads as a
     hole: two half-circles joined by their straight sides. The points are the
     same ones the cut file gets, so the drawing cannot drift from the export. */
  function guideLoop(cx, cy, len, wid, a) {
    var r = wid / 2;
    var half = Math.max(0, len / 2 - r);
    var ca = Math.cos(a), sa = Math.sin(a);
    var n = 9, i, t, u, v, out = [];
    for (i = 0; i < n; i++) {
      t = -Math.PI / 2 + (i / (n - 1)) * Math.PI;
      u = half + Math.cos(t) * r; v = Math.sin(t) * r;
      out.push({ x: r4(cx + u * ca - v * sa), y: r4(cy + u * sa + v * ca) });
    }
    for (i = 0; i < n; i++) {
      t = Math.PI / 2 + (i / (n - 1)) * Math.PI;
      u = -half + Math.cos(t) * r; v = Math.sin(t) * r;
      out.push({ x: r4(cx + u * ca - v * sa), y: r4(cy + u * sa + v * ca) });
    }
    if (polyArea(out) > 0) out.reverse();
    return out;
  }

  /* one slit per weld spot on this face, already in sheet coordinates */
  function guideSlots(pts, params) {
    if (!params.guides) return [];
    var want = params.guideL > 0 ? params.guideL : (params.padD || 18) * 0.45;
    var len = Math.min(want, guideMaxLen(params));
    if (!(len > GUIDE_W)) return [];
    var a = (params.lineAngle || 0) * Math.PI / 180;
    var out = [];
    for (var i = 0; i < pts.length; i++) out.push(guideLoop(pts[i].x, pts[i].y, len, GUIDE_W, a));
    return out;
  }

  /* The plate's contours plus the slits cut out of it, in the order a cutter
     wants them: a hole before the outline that frees the piece, so the sheet
     cannot shift between the two. */
  function islandPolys(isl) {
    return isl.slots && isl.slots.length ? isl.slots.concat(isl.polys) : isl.polys;
  }

  /* ------------------------------------------------------------------ */
  /* sheet frame                                                         */
  /* ------------------------------------------------------------------ */

  function frameOf(doc) {
    var m = doc.params.margin || 0;
    var r = (doc.params.padD || 18) / 2;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < doc.cells.length; i++) {
      var c = doc.cells[i];
      x0 = Math.min(x0, c.x - r); y0 = Math.min(y0, c.y - r);
      x1 = Math.max(x1, c.x + r); y1 = Math.max(y1, c.y + r);
    }
    if (!isFinite(x0)) return { ox: 0, oy: 0, W: 200, H: 200, minX: 0, minY: 0 };
    var W = (x1 - x0) + 2 * m;
    var H = (y1 - y0) + 2 * m;
    return { ox: -x0 + m, oy: -y0 + m, W: W, H: H, minX: x0, minY: y0 };
  }

  /* ------------------------------------------------------------------ */
  /* rotation                                                            */
  /*
   * A 90 degree turn is applied to the cell positions themselves, so island
   * membership, cell ids, polarity, numbering and both sheets follow without
   * any special case. The reflection rule is unchanged and still correct: the
   * bottom sheet is cut flat and then flipped over, so its cut file is the
   * mirror of the pack position whatever orientation the pack is in.
   *
   * Screen y points down, so (x, y) -> (-y, x) turns clockwise as seen by the
   * user. The layout is re-anchored at the origin afterwards so the saved
   * document stays tidy.
   */
  /* ------------------------------------------------------------------ */

  function rotateCells(cells, clockwise) {
    if (clockwise === undefined) clockwise = true;
    var i, c, x, y;
    var minx = Infinity, miny = Infinity;
    for (i = 0; i < cells.length; i++) {
      c = cells[i];
      x = c.x; y = c.y;
      c.x = clockwise ? -y : y;
      c.y = clockwise ? x : -x;
      if (c.x < minx) minx = c.x;
      if (c.y < miny) miny = c.y;
    }
    if (!cells.length) return cells;
    for (i = 0; i < cells.length; i++) {
      cells[i].x = r4(cells[i].x - minx);
      cells[i].y = r4(cells[i].y - miny);
    }
    return cells;
  }

  /* rotate the whole pack and remember the quarter turn, so pressing "fill
     grid" later reproduces the layout the user is looking at */
  function rotateDoc(doc, clockwise) {
    if (clockwise === undefined) clockwise = true;
    rotateCells(doc.cells, clockwise);
    doc.rot = (((doc.rot || 0) + (clockwise ? 90 : 270)) % 360);
    return doc;
  }

  /* sheet coordinates of a cell on a given face.
     the bottom sheet is the exact reflection of the top sheet about x = W/2,
     because the piece is cut flat and then flipped over to fit. */
  function cellOnFace(doc, frame, face, cell) {
    var x = cell.x + frame.ox;
    var y = cell.y + frame.oy;
    return { x: face === 'bottom' ? frame.W - x : x, y: y };
  }

  function polarityOnFace(cell, face) {
    var plusOnTop = !cell.flip;
    var plusHere = (face === 'top') ? plusOnTop : !plusOnTop;
    return plusHere ? '+' : '-';
  }

  /* ------------------------------------------------------------------ */
  /* build one sheet                                                     */
  /*
   * opt.cache is a Map owned by the caller. Painting one cell changes one
   * island, but a rebuild used to re-contour every island on both faces.
   * The cache key is the island's geometry written out in full - the cell
   * ids and their exact positions on this face - so any edit that moves or
   * replaces cells misses the cache without anyone having to remember to
   * invalidate it. Nothing here can go stale.
   */
  /* ------------------------------------------------------------------ */

  function islandSig(isl, face, pts, ids, params) {
    var s = face + '|' + isl.id + '|' + params.padD + ',' + params.bridgeW + ',' + params.kerf +
            ',' + params.step + ',' + (params.cut || 'plate') + ',' + (params.lineAngle || 0);
    for (var i = 0; i < pts.length; i++) {
      s += '|' + ids[i] + '@' + pts[i].x.toFixed(3) + ',' + pts[i].y.toFixed(3);
    }
    return s;
  }

  function buildSheet(doc, face, opt) {
    opt = opt || {};
    var frame = opt.frame || frameOf(doc);
    var cache = opt.cache;
    var byId = Object.create(null);
    for (var i = 0; i < doc.cells.length; i++) {
      var c = doc.cells[i];
      byId[c.id] = { cell: c, pos: cellOnFace(doc, frame, face, c) };
    }
    var source = doc.islands[face] || [];
    var islands = [];
    for (var k = 0; k < source.length; k++) {
      var isl = source[k];
      var pts = [], pols = [], ids = [];
      var seen = Object.create(null);
      for (var q = 0; q < isl.cells.length; q++) {
        var rec = byId[isl.cells[q]];
        if (!rec || seen[isl.cells[q]]) continue;
        seen[isl.cells[q]] = 1;
        pts.push(rec.pos);
        pols.push(polarityOnFace(rec.cell, face));
        ids.push(isl.cells[q]);
      }
      if (!pts.length) continue;
      var uniq = {};
      for (var u = 0; u < pols.length; u++) uniq[pols[u]] = 1;
      var keys = Object.keys(uniq);

      var geom = null;
      var sig = null;
      if (cache) {
        sig = islandSig(isl, face, pts, ids, doc.params);
        var hit = cache.get(isl.id);
        if (hit && hit.sig === sig) geom = hit.geom;
      }
      if (!geom) {
        var polys = [];
        var area = 0, parts = 0;
        if (!opt.skipGeometry) {
          var prims = islandPrimitives(pts, doc.params);
          polys = contour(prims, doc.params.step, opt.budget);
          for (var p = 0; p < polys.length; p++) {
            var pa = polyArea(polys[p]);
            area += pa;
            if (pa > 0) parts++;   /* outer loops come out positive, holes negative */
          }
        }
        /* the slits are not part of the distance field - they change nothing
           about the outline - so they stay out of the cache key and toggling
           them does not re-trace a single sheet */
        geom = { polys: polys, parts: parts, area: Math.abs(area), cells: pts.length };
        if (cache && sig) cache.set(isl.id, { sig: sig, geom: geom });
      }
      /* the slits are cut out of the plate, so they reduce the metal and are
         carried beside the outline loops rather than inside them */
      var slots = guideSlots(pts, doc.params);
      var slotArea = 0;
      for (var sk = 0; sk < slots.length; sk++) slotArea += Math.abs(polyArea(slots[sk]));
      islands.push({
        id: isl.id,
        name: isl.name || isl.id,
        color: isl.color || '#888',
        cells: pts.length,
        polys: geom.polys,
        slots: slots,
        parts: geom.parts,
        area: Math.max(0, geom.area - slotArea),
        polarity: keys.length === 1 ? keys[0] : 'mixed'
      });
    }
    return { face: face, W: frame.W, H: frame.H, islands: islands };
  }

  /* ------------------------------------------------------------------ */
  /* diagnostics                                                         */
  /* ------------------------------------------------------------------ */

  function polyDistance(pa, pb) {
    var best = Infinity;
    for (var i = 0; i < pa.length; i++) {
      var a = pa[i];
      for (var j = 0; j < pb.length; j++) {
        var b = pb[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }

  function diagnose(doc) {
    var out = [];
    var faces = ['top', 'bottom'];
    for (var f = 0; f < 2; f++) {
      var face = faces[f];
      var owner = Object.create(null);
      var list = doc.islands[face] || [];
      for (var i = 0; i < list.length; i++) {
        for (var j = 0; j < list[i].cells.length; j++) {
          var id = list[i].cells[j];
          if (owner[id] !== undefined) {
            out.push({ level: 'error', face: face, text: 'Cell ' + id + ' is in two islands on the ' + face + '.' });
          }
          owner[id] = list[i].id;
        }
      }
      for (var c = 0; c < doc.cells.length; c++) {
        if (owner[doc.cells[c].id] === undefined) {
          out.push({ level: 'warn', face: face, text: 'Terminal ' + doc.cells[c].id + ' is not connected on the ' + face + '.' });
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* SVG                                                                 */
  /* ------------------------------------------------------------------ */

  function pathData(polys, digits) {
    var d = [];
    for (var i = 0; i < polys.length; i++) {
      var p = polys[i];
      if (p.length < 3) continue;
      var s = 'M' + p[0].x.toFixed(digits) + ' ' + p[0].y.toFixed(digits);
      for (var k = 1; k < p.length; k++) s += 'L' + p[k].x.toFixed(digits) + ' ' + p[k].y.toFixed(digits);
      d.push(s + 'Z');
    }
    return d.join(' ');
  }

  function toSVG(sheets, opt) {
    opt = opt || {};
    var digits = 3;
    var pad = opt.pad === undefined ? 6 : opt.pad;
    var W = 0, H = 0;
    for (var i = 0; i < sheets.length; i++) {
      W = Math.max(W, sheets[i].W);
      H = Math.max(H, sheets[i].H);
    }
    var tw = W + pad * 2, th = H + pad * 2;
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="' + tw.toFixed(3) + 'mm" height="' + th.toFixed(3) + 'mm" viewBox="0 0 ' + tw.toFixed(3) + ' ' + th.toFixed(3) + '">');
    out.push('<g transform="translate(' + pad + ',' + pad + ')">');
    for (var s = 0; s < sheets.length; s++) {
      var sh = sheets[s];
      var name = sh.face === 'bottom' ? 'BOTTOM' : 'TOP';
      var polys = [];
      for (var k = 0; k < sh.islands.length; k++) polys = polys.concat(islandPolys(sh.islands[k]));
      out.push('<g id="' + name + '_CUT" fill="none" stroke="#000000" stroke-width="' + (opt.strokeWidth || 0.1) + '" stroke-linejoin="round">');
      out.push('<path d="' + pathData(polys, digits) + '"/>');
      out.push('</g>');
    }
    out.push('</g>');
    out.push('</svg>');
    return out.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* DXF (R12, one closed POLYLINE per contour, mm units)                */
  /* ------------------------------------------------------------------ */

  function dxfNum(v) { return (Math.round(v * 10000) / 10000).toFixed(4); }

  function toDXF(sheets, opt) {
    opt = opt || {};
    var W = 0, H = 0;
    for (var i = 0; i < sheets.length; i++) { W = Math.max(W, sheets[i].W); H = Math.max(H, sheets[i].H); }

    var layers = [];
    for (var s = 0; s < sheets.length; s++) {
      layers.push({ name: (sheets[s].face === 'bottom' ? 'BOTTOM_CUT' : 'TOP_CUT'), color: sheets[s].face === 'bottom' ? 5 : 7 });
    }

    var L = [];
    function g(code, value) { L.push(String(code)); L.push(String(value)); }

    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$INSUNITS'); g(70, 4);
    g(9, '$EXTMIN'); g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
    g(9, '$EXTMAX'); g(10, dxfNum(W)); g(20, dxfNum(H)); g(30, '0.0');
    g(0, 'ENDSEC');

    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length + 1);
    g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
    for (var li = 0; li < layers.length; li++) {
      g(0, 'LAYER'); g(2, layers[li].name); g(70, 0); g(62, layers[li].color); g(6, 'CONTINUOUS');
    }
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');

    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (var sh = 0; sh < sheets.length; sh++) {
      var sheet = sheets[sh];
      var lname = sheet.face === 'bottom' ? 'BOTTOM_CUT' : 'TOP_CUT';
      for (var k = 0; k < sheet.islands.length; k++) {
        var part = islandPolys(sheet.islands[k]);
        for (var p = 0; p < part.length; p++) {
          var poly = part[p];
          if (poly.length < 3) continue;
          g(0, 'POLYLINE'); g(8, lname); g(66, 1); g(70, 1);
          g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
          for (var v = 0; v < poly.length; v++) {
            g(0, 'VERTEX'); g(8, lname);
            g(10, dxfNum(poly[v].x));
            g(20, dxfNum(H - poly[v].y));
            g(30, '0.0');
          }
          g(0, 'SEQEND'); g(8, lname);
        }
      }
    }
    g(0, 'ENDSEC');
    g(0, 'EOF');
    return L.join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ */
  /* printable assembly map                                              */
  /* ------------------------------------------------------------------ */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toPrint(doc, top, bottom) {
    var frame = frameOf(doc);
    var gap = 24, legend = 90, pad = 18;
    var titleH = 26;
    var W = frame.W, H = frame.H;
    var totalW = pad * 2 + W * 2 + gap + legend;
    var totalH = pad * 2 + titleH + H + 30;
    var o = [];
    o.push('<?xml version="1.0" encoding="UTF-8"?>');
    o.push('<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="' + totalW.toFixed(2) + 'mm" height="' + totalH.toFixed(2) + 'mm" viewBox="0 0 ' + totalW.toFixed(2) + ' ' + totalH.toFixed(2) + '">');
    o.push('<rect x="0" y="0" width="' + totalW + '" height="' + totalH + '" fill="#ffffff"/>');
    o.push('<g font-family="Helvetica, Arial, sans-serif" fill="#111">');
    o.push('<text x="' + pad + '" y="' + (pad + 8) + '" font-size="7" font-weight="bold">' + esc(doc.name || 'Battery pack') + ' - connection layers, 1:1 at 100%</text>');
    o.push('<text x="' + pad + '" y="' + (pad + 16) + '" font-size="3.6" fill="#555">cell ' + esc(doc.cellType || 'custom') + ' D' + doc.params.cellD + ' mm, pitch ' + doc.params.pitch.toFixed(2) + ' mm, pad D' + doc.params.padD + ' mm, strap ' + doc.params.bridgeW + ' mm, kerf ' + doc.params.kerf + ' mm, ' + (doc.params.cut === 'lines' ? 'weld-line cut at ' + (doc.params.lineAngle || 0) + '&#176;, ' : 'plate, ') + (doc.params.guides ? 'guide slits ' + (doc.params.guideL || 8) + ' mm at ' + (doc.params.lineAngle || 0) + '&#176;, ' : '') + doc.cells.length + ' cells</text>');

    var panels = [
      { sheet: top, title: 'TOP sheet (cut as shown, lay on pack as shown)', x: pad },
      { sheet: bottom, title: 'BOTTOM sheet (cut as shown, flip over to fit)', x: pad + W + gap }
    ];

    for (var pi = 0; pi < panels.length; pi++) {
      var pn = panels[pi], sh = pn.sheet;
      var ox = pn.x, oy = pad + titleH;
      o.push('<text x="' + ox + '" y="' + (oy - 4) + '" font-size="4" font-weight="bold">' + esc(pn.title) + '</text>');
      o.push('<rect x="' + ox + '" y="' + oy + '" width="' + W + '" height="' + H + '" fill="none" stroke="#d8d8d8" stroke-width="0.2"/>');

      /* islands */
      for (var i = 0; i < sh.islands.length; i++) {
        var isl = sh.islands[i];
        o.push('<g transform="translate(' + ox + ',' + oy + ')">');
        o.push('<path d="' + pathData(islandPolys(isl), 3) + '" fill="' + esc(isl.color) + '" fill-opacity="0.35" stroke="' + esc(isl.color) + '" stroke-width="0.35" stroke-linejoin="round"/>');
        o.push('</g>');
      }

      /* cells */
      var seen = Object.create(null);
      for (var c = 0; c < doc.cells.length; c++) {
        var cell = doc.cells[c];
        var pos = cellOnFace(doc, frame, sh.face, cell);
        var pol = polarityOnFace(cell, sh.face);
        var r = doc.params.cellD / 2;
        o.push('<circle cx="' + (ox + pos.x).toFixed(2) + '" cy="' + (oy + pos.y).toFixed(2) + '" r="' + r.toFixed(2) + '" fill="none" stroke="#222" stroke-width="0.25" stroke-dasharray="2 1.2"/>');
        o.push('<text x="' + (ox + pos.x).toFixed(2) + '" y="' + (oy + pos.y + 2.4).toFixed(2) + '" font-size="5" text-anchor="middle">' + pol + '</text>');
        o.push('<text x="' + (ox + pos.x).toFixed(2) + '" y="' + (oy + pos.y + 8.5).toFixed(2) + '" font-size="2.6" text-anchor="middle" fill="#777">' + (c + 1) + '</text>');
        seen[c] = 1;
      }
    }

    /* legend */
    var lx = pad + W * 2 + gap + 4;
    var ly = pad + titleH;
    o.push('<text x="' + lx + '" y="' + (ly - 4) + '" font-size="4" font-weight="bold">Islands</text>');
    var rows = [];
    for (var f = 0; f < 2; f++) {
      var sh2 = f === 0 ? top : bottom;
      for (var k = 0; k < sh2.islands.length; k++) rows.push({ face: sh2.face, isl: sh2.islands[k] });
    }
    for (var r2 = 0; r2 < rows.length && r2 < 34; r2++) {
      var y = ly + 4 + r2 * 5;
      o.push('<rect x="' + lx + '" y="' + (y - 2.6) + '" width="4" height="4" fill="' + esc(rows[r2].isl.color) + '"/>');
      o.push('<text x="' + (lx + 6) + '" y="' + y + '" font-size="3.2">' + esc(rows[r2].face.toUpperCase().slice(0, 3)) + ' ' + esc(rows[r2].isl.name) + '  (' + rows[r2].isl.cells + ' cells, ' + rows[r2].isl.polarity + ')</text>');
    }

    o.push('</g>');
    o.push('</svg>');
    return o.join('\n');
  }

  return {
    version: '1.4.0',
    mst: mst,
    neighbourPairs: neighbourPairs,
    weldOrder: weldOrder,
    islandPrimitives: islandPrimitives,
    guideSlots: guideSlots,
    guideMaxLen: guideMaxLen,
    islandPolys: islandPolys,
    GUIDE_W: GUIDE_W,
    primDist: primDist,
    sdf: sdf,
    sdfIndex: sdfIndex,
    sdfFast: sdfFast,
    gridStep: gridStep,
    contour: contour,
    simplify: simplify,
    polyArea: polyArea,
    frameOf: frameOf,
    rotateCells: rotateCells,
    rotateDoc: rotateDoc,
    cellOnFace: cellOnFace,
    polarityOnFace: polarityOnFace,
    buildSheet: buildSheet,
    diagnose: diagnose,
    toSVG: toSVG,
    toDXF: toDXF,
    toPrint: toPrint,
    pathData: pathData
  };
});
