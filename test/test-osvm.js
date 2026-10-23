// node test/test-osvm.js : check the object-space viewshed (js/osvm.js) against
// brute-force line of sight on the same TIN, its skyline against engine.horizon(),
// and time it.
var O = require("../js/osvm.js"), E = require("../js/engine.js");

function terrain(w, h, cell, x0, ytop, seed) {
  var z = new Float32Array(w * h), s0 = seed || 0;
  var hills = [[0.3, 0.35, 900, 0.10], [0.7, 0.6, 600, 0.06], [0.5, 0.8, 300, 0.03], [0.15, 0.8, 400, 0.02]];
  for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
    var u = c / w, v = r / h, s = 50 + 30 * Math.sin(u * 40 + s0) * Math.cos(v * 33) + 8 * Math.sin(u * 170) * Math.sin(v * 150 + s0);
    hills.forEach(function (k) { var d2 = (u - k[0]) * (u - k[0]) + (v - k[1]) * (v - k[1]); s += k[2] * Math.exp(-d2 / (2 * k[3] * k[3])); });
    z[r * w + c] = s;
  }
  return { z: z, w: w, h: h, cell: cell, x0: x0 || 0, ytop: ytop || h * cell };
}

// line of sight from (E0, N0, zEye) to the TIN point at (E1, N1); returns the largest
// amount the terrain rises above the sight line (negative: clear)
function losMargin(g, E0, N0, zEye, E1, N1) {
  var z1 = O.sampleTIN(g, E1, N1), dx = E1 - E0, dy = N1 - N0, d = Math.sqrt(dx * dx + dy * dy);
  var n = Math.ceil(d / (g.cell / 16)), worst = -1e9;
  for (var i = 1; i < n; i++) {
    var t = i / n;
    if (d * (1 - t) < g.cell * 0.05) break;
    var zz = O.sampleTIN(g, E0 + t * dx, N0 + t * dy);
    if (zz === null) continue;
    var m = zz - (zEye + t * (z1 - zEye));
    if (m > worst) worst = m;
  }
  return worst;
}

function pointInPieces(res, list, x, y) {
  var P = res.pieces, xy = P.xy;
  for (var q = 0; q < list.length; q++) {
    var p = list[q], a = P.off[p], b = P.off[p + 1], s = 0, i;
    for (i = a; i < b; i++) { var j = i + 1 === b ? a : i + 1; s += xy[2 * i] * xy[2 * j + 1] - xy[2 * j] * xy[2 * i + 1]; }
    var sg = s >= 0 ? 1 : -1, inside = true;
    for (i = a; i < b && inside; i++) {
      var j2 = i + 1 === b ? a : i + 1;
      var cr = (xy[2 * j2] - xy[2 * i]) * (y - xy[2 * i + 1]) - (xy[2 * j2 + 1] - xy[2 * i + 1]) * (x - xy[2 * i]);
      if (cr * sg < -1e-7) inside = false;
    }
    if (inside) return true;
  }
  return false;
}
function triOf(g, x, y) {
  var u = (x - g.x0) / g.cell - 0.5, v = (g.ytop - y) / g.cell - 0.5, c = Math.floor(u), r = Math.floor(v);
  return (r * (g.w - 1) + c) * 2 + ((u - c) >= (v - r) ? 0 : 1);
}

var fails = 0, rnd = (function () { var s = 12345; return function () { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();

// 1. against brute force, several observers, no curvature
var g = terrain(240, 220, 10, 500000, 5250000, 0);
[[0.5, 0.5, 1.5], [0.2, 0.7, 1.5], [0.8, 0.25, 10], [0.31, 0.36, 2]].forEach(function (o) {
  var E0 = g.x0 + o[0] * g.w * g.cell, N0 = g.ytop - o[1] * g.h * g.cell;
  var res = O.viewshed([g], E0, N0, { eye: o[2], curvature: false });
  var byTri = {};
  for (var p = 0; p < res.pieces.n; p++) (byTri[res.pieces.tri[p]] = byTri[res.pieces.tri[p]] || []).push(p);
  var n = 0, agree = 0, edge = 0, nvis = 0, visAgree = 0;
  for (var k = 0; k < 3000; k++) {
    var x = g.x0 + g.cell * (0.6 + rnd() * (g.w - 2.2)), y = g.ytop - g.cell * (0.6 + rnd() * (g.h - 2.2));
    var m = losMargin(g, E0, N0, res.zEye, x, y);
    if (Math.abs(m) < 0.05) { edge++; continue; }
    var bv = m < 0, ov = pointInPieces(res, byTri[triOf(g, x, y)] || [], x, y);
    n++; if (bv === ov) agree++; if (bv) { nvis++; if (ov) visAgree++; }
  }
  var pct = 100 * agree / n;
  console.log("observer " + o.join(",") + ": " + res.nTri + " triangles, " + res.pieces.n + " pieces, " + res.envelopePoints +
    " envelope points, " + res.ms + " ms; agreement with brute LOS " + pct.toFixed(2) + "% of " + n + " (visible " +
    (100 * nvis / n).toFixed(1) + "%, of which found " + (100 * visAgree / nvis).toFixed(1) + "%; " + edge + " grazing skipped)");
  if (pct < 99.5) fails++;
});

// 2. curvature: the same comparison with heights lowered by d^2 / 2R at the vertices
var gc = terrain(300, 300, 64, 480000, 5280000, 1);
(function () {
  var E0 = gc.x0 + 0.5 * gc.w * gc.cell, N0 = gc.ytop - 0.5 * gc.h * gc.cell;
  var res = O.viewshed([gc], E0, N0, { eye: 1.5 });
  // the brute check runs on a copy with the curvature drop baked into the vertices
  var z2 = new Float32Array(gc.z);
  for (var r = 0; r < gc.h; r++) for (var c = 0; c < gc.w; c++) {
    var dx = gc.x0 + (c + 0.5) * gc.cell - E0, dy = gc.ytop - (r + 0.5) * gc.cell - N0;
    z2[r * gc.w + c] -= (dx * dx + dy * dy) / (2 * O.R_EFF);
  }
  var g2 = { z: z2, w: gc.w, h: gc.h, cell: gc.cell, x0: gc.x0, ytop: gc.ytop };
  var byTri = {};
  for (var p = 0; p < res.pieces.n; p++) (byTri[res.pieces.tri[p]] = byTri[res.pieces.tri[p]] || []).push(p);
  var n = 0, agree = 0;
  for (var k = 0; k < 2000; k++) {
    var x = gc.x0 + gc.cell * (0.6 + rnd() * (gc.w - 2.2)), y = gc.ytop - gc.cell * (0.6 + rnd() * (gc.h - 2.2));
    var m = losMargin(g2, E0, N0, res.zEye, x, y);
    if (Math.abs(m) < 0.05) continue;
    n++; if ((m < 0) === pointInPieces(res, byTri[triOf(gc, x, y)] || [], x, y)) agree++;
  }
  console.log("curvature, 19 km square at 64 m: agreement " + (100 * agree / n).toFixed(2) + "% of " + n + ", " + res.ms + " ms");
  if (agree / n < 0.995) fails++;
})();

// 3. near + far rings, and the skyline against engine.horizon() (bilinear, ray-marched)
var fine = terrain(800, 800, 10, 0, 8000, 2);
function sub(g, c0, r0, w, h) {
  var z = new Float32Array(w * h);
  for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) z[r * w + c] = g.z[(r0 + r) * g.w + c0 + c];
  return { z: z, w: w, h: h, cell: g.cell, x0: g.x0 + c0 * g.cell, ytop: g.ytop - r0 * g.cell };
}
function coarsen(g, f) {
  var w = Math.floor(g.w / f), h = Math.floor(g.h / f), z = new Float32Array(w * h);
  for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
    var s = 0; for (var a = 0; a < f; a++) for (var b = 0; b < f; b++) s += g.z[(r * f + a) * g.w + c * f + b];
    z[r * w + c] = s / (f * f);
  }
  return { z: z, w: w, h: h, cell: g.cell * f, x0: g.x0, ytop: g.ytop };
}
(function () {
  var near = sub(fine, 300, 300, 200, 200), far = coarsen(fine, 8);
  var E0 = near.x0 + 100 * 10 + 3, N0 = near.ytop - 100 * 10 - 7;
  var two = O.viewshed([near, far], E0, N0, { eye: 1.5 });
  var hz = E.horizon(near, far, E0, N0, 360, 20000, 1.5);
  var dsum = 0, dmax = 0;
  for (var a = 0; a < 360; a++) { var d = Math.abs(two.skyline[a] - hz.angles[a]); dsum += d; if (d > dmax) dmax = d; }
  console.log("near+far: " + two.nTri + " triangles in " + two.ms + " ms, visible " + (two.area / 1e6).toFixed(2) +
    " km2; skyline vs engine.horizon: mean " + (dsum / 360).toFixed(3) + " deg, max " + dmax.toFixed(3) + " deg");
  if (dsum / 360 > 0.25) fails++;
  var cov = O.coverage(two, near, 2, 0), s = 0;
  for (var i = 0; i < cov.length; i++) s += cov[i];
  console.log("coverage on the near grid: " + (100 * s / (4 * cov.length)).toFixed(1) + "% of samples visible");
})();

// 4. the explicit-mesh path: the grid as a mesh, ordered by orderTopo (edge adjacency).
//    (a) same diagonals as gridSource: same answer; (b) diagonals flipped at random: check
//    against brute force on that mesh.
function gridMesh(g, flip) {
  var nv = g.w * g.h, x = new Float64Array(nv), y = new Float64Array(nv), z = new Float64Array(nv), tri = [];
  for (var r = 0; r < g.h; r++) for (var c = 0; c < g.w; c++) { var i = r * g.w + c; x[i] = g.x0 + (c + 0.5) * g.cell; y[i] = g.ytop - (r + 0.5) * g.cell; z[i] = g.z[i]; }
  for (r = 0; r < g.h - 1; r++) for (c = 0; c < g.w - 1; c++) {
    var tl = r * g.w + c, tr = tl + 1, bl = tl + g.w, br = bl + 1;
    if (flip && flip[r * (g.w - 1) + c]) tri.push(tl, tr, bl, tr, br, bl);    // TR-BL diagonal
    else tri.push(tl, tr, br, tl, br, bl);                                      // TL-BR, as gridSource
  }
  return { x: x, y: y, z: z, tri: Uint32Array.from(tri) };
}
(function () {
  var g4 = terrain(160, 150, 10, 500000, 5250000, 4), E0 = g4.x0 + 70.3 * 10, N0 = g4.ytop - 81.7 * 10;
  var rg = O.viewshed([g4], E0, N0, { eye: 2 });
  var rm = O.viewshedMesh(gridMesh(g4, null), E0, N0, { eye: 2 });
  var rel = Math.abs(rg.area - rm.area) / rg.area;
  console.log("mesh path, same diagonals: area " + (rm.area / 1e6).toFixed(4) + " km2 vs grid " + (rg.area / 1e6).toFixed(4) +
    " (rel diff " + rel.toExponential(1) + "), cycles " + rm.cycles + ", order " + rm.msOrder + " ms, total " + rm.ms + " ms");
  if (rel > 1e-6 || rm.cycles) fails++;
  // (b) random diagonals
  var flip = new Uint8Array((g4.w - 1) * (g4.h - 1)); for (var i = 0; i < flip.length; i++) flip[i] = rnd() < 0.5 ? 1 : 0;
  var mesh = gridMesh(g4, flip), rf = O.viewshedMesh(mesh, E0, N0, { eye: 2 });
  function sampleFlip(x, y) {
    var u = (x - g4.x0) / g4.cell - 0.5, v = (g4.ytop - y) / g4.cell - 0.5;
    if (u < 0 || v < 0 || u > g4.w - 1 || v > g4.h - 1) return null;
    var c = Math.min(g4.w - 2, Math.floor(u)), r = Math.min(g4.h - 2, Math.floor(v)), fx = u - c, fy = v - r, w = g4.w, z = g4.z;
    var tl = z[r * w + c], tr = z[r * w + c + 1], bl = z[(r + 1) * w + c], br = z[(r + 1) * w + c + 1];
    if (!flip[r * (w - 1) + c]) return fx >= fy ? tl + fx * (tr - tl) + fy * (br - tr) : tl + fy * (bl - tl) + fx * (br - bl);
    return fx + fy <= 1 ? tl + fx * (tr - tl) + fy * (bl - tl) : br + (1 - fx) * (bl - br) + (1 - fy) * (tr - br);
  }
  function triFlip(x, y) {
    var u = (x - g4.x0) / g4.cell - 0.5, v = (g4.ytop - y) / g4.cell - 0.5, c = Math.floor(u), r = Math.floor(v), q = r * (g4.w - 1) + c;
    return 2 * q + (flip[q] ? (u - c) + (v - r) <= 1 ? 0 : 1 : (u - c) >= (v - r) ? 0 : 1);
  }
  var byTri = {};
  for (var p = 0; p < rf.pieces.n; p++) (byTri[rf.pieces.tri[p]] = byTri[rf.pieces.tri[p]] || []).push(p);
  var n = 0, agree = 0;
  for (var k = 0; k < 3000; k++) {
    var x = g4.x0 + g4.cell * (0.6 + rnd() * (g4.w - 2.2)), y = g4.ytop - g4.cell * (0.6 + rnd() * (g4.h - 2.2));
    var z1 = sampleFlip(x, y), dx = x - E0, dy = y - N0, d = Math.sqrt(dx * dx + dy * dy), m = -1e9, ns = Math.ceil(d / (g4.cell / 16));
    for (var j = 1; j < ns; j++) { var t = j / ns; if (d * (1 - t) < g4.cell * 0.05) break;
      var curvd = (t * d) * (t * d) / (2 * O.R_EFF), zz = sampleFlip(E0 + t * dx, N0 + t * dy) - curvd;
      var mm = zz - (rf.zEye + t * (z1 - d * d / (2 * O.R_EFF) - rf.zEye)); if (mm > m) m = mm; }
    if (Math.abs(m) < 0.05) continue;
    n++; if ((m < 0) === pointInPieces(rf, byTri[triFlip(x, y)] || [], x, y)) agree++;
  }
  console.log("mesh path, random diagonals: agreement with brute LOS " + (100 * agree / n).toFixed(2) + "% of " + n + ", cycles " + rf.cycles);
  if (agree / n < 0.995 || rf.cycles) fails++;
})();

// 4b. an eye at the exact centre of a quad puts triangle corners exactly on sector
//     boundaries (45 degree diagonals, wedge centres): the skyline must have no gaps
(function () {
  var g5 = terrain(120, 100, 10, 0, 1000, 5), res = O.viewshed([g5], 60 * 10, 1000 - 50 * 10, { eye: 1.5 });
  var low = 0; for (var a = 0; a < 360; a++) if (res.skyline[a] < -89) low++;
  console.log("eye at a quad centre: " + low + " skyline directions with nothing seen");
  if (low) fails++;
})();

// 5. timing at app sizes: 1000 x 1000 near at 4 m, far 1250 x 1250 at 64 m
(function () {
  var near = terrain(1000, 1000, 4, 0, 4000, 3), far = terrain(1250, 1250, 64, -38000, 42000, 3);
  var res = O.viewshed([near, far], 2000, 2000, { eye: 1.5 });
  console.log("app size (1000^2 at 4 m + 1250^2 at 64 m): " + res.nTri + " triangles, " + res.pieces.n + " pieces, " +
    res.envelopePoints + " envelope points, " + res.nQuickHidden + " rejected early, " + res.ms + " ms");
  var r2 = O.viewshed([near, far], 2000, 2000, { eye: 1.5, maxDist: 20000 });
  console.log("  same, maxDist 20 km: " + r2.nTri + " triangles, " + r2.ms + " ms");
})();

if (fails) { console.log(fails + " FAIL"); process.exit(1); } else console.log("all ok");
