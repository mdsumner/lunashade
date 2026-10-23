// node test/test-polygonize.js : polygons from js/polygonize.js against the mask they
// came from (area, orientation, and point-in-polygon at every cell centre).
var P = require("../js/polygonize.js");
var fails = 0, rnd = (function () { var s = 777; return function () { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();

function ringArea(xy) { var a = 0, n = xy.length / 2 - 1; for (var i = 0; i < n; i++) a += xy[2 * i] * xy[2 * i + 3] - xy[2 * i + 2] * xy[2 * i + 1]; return a / 2; }
function check(name, mask, g) {
  var t0 = Date.now(), res = P.polygonize(mask, g), ms = Date.now() - t0;
  var A = 0, nIn = 0, bad = 0, orient = 0, verts = 0;
  for (var i = 0; i < mask.length; i++) if (mask[i]) nIn++;
  res.polygons.forEach(function (poly) {
    poly.forEach(function (ring, k) {
      var a = ringArea(ring); A += a; verts += ring.length / 2;
      if ((k === 0) !== (a > 0)) orient++;
      if (ring[0] !== ring[ring.length - 2] || ring[1] !== ring[ring.length - 1]) bad++;
    });
  });
  // every cell centre: inside exactly one polygon (outer and not in its holes) iff the cell is in
  var wrong = 0;
  for (var r = 0; r < g.h; r++) for (var c = 0; c < g.w; c++) {
    var x = g.x0 + (c + 0.5) * g.cell, y = g.ytop - (r + 0.5) * g.cell, hits = 0;
    res.polygons.forEach(function (poly) {
      if (!P.inRing(poly[0], x, y)) return;
      for (var k = 1; k < poly.length; k++) if (P.inRing(poly[k], x, y)) return;
      hits++;
    });
    if (hits !== (mask[r * g.w + c] ? 1 : 0)) wrong++;
  }
  var ok = Math.abs(A - nIn * g.cell * g.cell) < 1e-6 * g.cell * g.cell && !bad && !orient && !wrong;
  console.log(name + ": " + res.polygons.length + " polygons, " + res.rings + " rings, " + verts + " vertices, " + ms + " ms; area " +
    (ok ? "ok" : "MISMATCH " + A + " vs " + nIn * g.cell * g.cell) + ", orientation errors " + orient + ", unclosed " + bad + ", wrong cells " + wrong);
  if (!ok) fails++;
}
var g = { w: 60, h: 50, cell: 4, x0: 520000, ytop: 5250000 };
// 1. a ring with an island in its hole, plus diagonal-touching cells
var m = new Uint8Array(g.w * g.h);
for (var r = 5; r < 40; r++) for (var c = 5; c < 45; c++) m[r * g.w + c] = 1;
for (r = 12; r < 33; r++) for (c = 12; c < 38; c++) m[r * g.w + c] = 0;
for (r = 18; r < 26; r++) for (c = 18; c < 30; c++) m[r * g.w + c] = 1;
m[45 * g.w + 50] = 1; m[46 * g.w + 51] = 1; m[45 * g.w + 52] = 1; m[47 * g.w + 50] = 1;   // corner touches
check("ring + island + corner touches", m, g);
// 2. random noise at several densities
[0.2, 0.5, 0.8].forEach(function (p) {
  var mm = new Uint8Array(g.w * g.h); for (var i = 0; i < mm.length; i++) mm[i] = rnd() < p ? 1 : 0;
  check("random " + p, mm, g);
});
// 3. full and empty
check("full", new Uint8Array(g.w * g.h).fill(1), g);
check("empty", new Uint8Array(g.w * g.h), g);
// 4. timing at app size: a smooth blobby mask 1000 x 1000
var gb = { w: 1000, h: 1000, cell: 4, x0: 0, ytop: 4000 }, mb = new Uint8Array(1e6);
for (r = 0; r < 1000; r++) for (c = 0; c < 1000; c++) mb[r * 1000 + c] = Math.sin(c / 37) * Math.cos(r / 53) + 0.3 * Math.sin((c + r) / 7) > 0.1 ? 1 : 0;
var t0 = Date.now(), rb = P.polygonize(mb, gb);
console.log("1000 x 1000 blobs: " + rb.polygons.length + " polygons in " + (Date.now() - t0) + " ms");
if (fails) { console.log(fails + " FAIL"); process.exit(1); } else console.log("all ok");
