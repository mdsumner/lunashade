// node test/make-parity.js : write rust/osvm/tests/fixtures/parity.txt, the JS answers
// (js/osvm.js) for a few viewsheds, for the Rust crate's parity test. Plain whitespace-
// separated numbers, so the crate needs no parser dependency.
var O = require("../js/osvm.js"), fs = require("fs"), path = require("path");

function terrain(w, h, cell, x0, ytop, seed) {
  var z = new Float32Array(w * h);
  for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
    var u = c / w, v = r / h, s = 50 + 30 * Math.sin(u * 40 + seed) * Math.cos(v * 33) + 8 * Math.sin(u * 170) * Math.sin(v * 150 + seed);
    s += 900 * Math.exp(-((u - 0.3) * (u - 0.3) + (v - 0.35) * (v - 0.35)) / 0.02) + 600 * Math.exp(-((u - 0.7) * (u - 0.7) + (v - 0.6) * (v - 0.6)) / 0.0072);
    z[r * w + c] = s;
  }
  return { z: z, w: w, h: h, cell: cell, x0: x0, ytop: ytop };
}
function coarsen(g, f) {
  var w = Math.floor(g.w / f), h = Math.floor(g.h / f), z = new Float32Array(w * h);
  for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
    var s = 0; for (var a = 0; a < f; a++) for (var b = 0; b < f; b++) s += g.z[(r * f + a) * g.w + c * f + b];
    z[r * w + c] = s / (f * f);
  }
  return { z: z, w: w, h: h, cell: g.cell * f, x0: g.x0, ytop: g.ytop };
}
function sub(g, c0, r0, w, h) {
  var z = new Float32Array(w * h);
  for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) z[r * w + c] = g.z[(r0 + r) * g.w + c0 + c];
  return { z: z, w: w, h: h, cell: g.cell, x0: g.x0 + c0 * g.cell, ytop: g.ytop - r0 * g.cell };
}
function gridMesh(g, flip) {
  var nv = g.w * g.h, x = new Float64Array(nv), y = new Float64Array(nv), z = new Float64Array(nv), tri = [];
  for (var r = 0; r < g.h; r++) for (var c = 0; c < g.w; c++) { var i = r * g.w + c; x[i] = g.x0 + (c + 0.5) * g.cell; y[i] = g.ytop - (r + 0.5) * g.cell; z[i] = g.z[i]; }
  for (r = 0; r < g.h - 1; r++) for (c = 0; c < g.w - 1; c++) {
    var tl = r * g.w + c, tr = tl + 1, bl = tl + g.w, br = bl + 1;
    if (flip[r * (g.w - 1) + c]) tri.push(tl, tr, bl, tr, br, bl); else tri.push(tl, tr, br, tl, br, bl);
  }
  return { x: x, y: y, z: z, tri: Uint32Array.from(tri) };
}

var fine = terrain(480, 480, 10, 500000, 5254800, 0.7);
var near = sub(fine, 180, 200, 140, 120), far = coarsen(fine, 8);
var grids = [near, far];
var lines = [String(grids.length)];
grids.forEach(function (g) { lines.push([g.w, g.h, g.cell, g.x0, g.ytop].join(" ")); lines.push(Array.from(g.z).map(String).join(" ")); });
var rs = 99; function rnd() { rs = (rs * 1103515245 + 12345) % 2147483648; return rs / 2147483648; }
var flip = new Uint8Array((near.w - 1) * (near.h - 1)); for (var i = 0; i < flip.length; i++) flip[i] = rnd() < 0.5 ? 1 : 0;
var cases = [
  // kind, rings, eye, curvature, maxDist, fractional position in near
  [0, 1, 1.5, 0, -1, 0.5, 0.5], [0, 1, 10, 1, -1, 0.23, 0.71], [0, 2, 1.5, 1, -1, 0.61, 0.38],
  [0, 2, 30, 1, 2500, 0.4, 0.55], [1, 1, 2, 1, -1, 0.52, 0.47]
];
lines.push(String(cases.length));
cases.forEach(function (cs) {
  var E = near.x0 + cs[5] * near.w * near.cell + 0.37, N = near.ytop - cs[6] * near.h * near.cell - 0.21, res, cyc = -1;
  var o = { eye: cs[2], curvature: !!cs[3], maxDist: cs[4] < 0 ? undefined : cs[4] };
  if (cs[0] === 0) res = O.viewshed(grids.slice(0, cs[1]), E, N, o);
  else { res = O.viewshedMesh(gridMesh(near, flip), E, N, o); cyc = res.cycles; }
  lines.push([cs[0], cs[1], cs[2], cs[3], cs[4], E, N].join(" "));
  if (cs[0] === 1) lines.push(Array.from(flip).join(" "));
  lines.push([res.area, res.nTri, res.nVisTri, res.nQuickHidden, res.pieces.n, res.envelopePoints, cyc].join(" "));
  lines.push(Array.from(res.skyline).map(String).join(" "));
  console.log("case " + cs.join(",") + ": area " + res.area.toFixed(1) + " m2, " + res.nTri + " tri, " + res.pieces.n + " pieces");
});
// shade: the sweep on the near grid alone, and the near + far domain
var E_ = require("../js/engine.js"), shadeCases = [[30, 12, 0], [200, 4, 0], [95, 25, 0], [310, 16, 1], [140, 3, 1]];
lines.push(String(shadeCases.length));
shadeCases.forEach(function (sc) {
  var m = sc[2] ? new E_.Domain(near, far).shadeAt(sc[0], sc[1], 0.2) : E_.sweep(near.z, near.w, near.h, near.cell, sc[0], sc[1]).shade;
  lines.push(sc.join(" "));
  lines.push(Array.from(m).join(""));
  var s = 0; for (var i = 0; i < m.length; i++) s += m[i];
  console.log("shade " + sc.join(",") + ": " + (100 * s / m.length).toFixed(1) + "% in shadow");
});
var out = path.join(__dirname, "..", "rust", "osvm", "tests", "fixtures", "parity.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log("wrote " + out);
