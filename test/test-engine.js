// node test/test-engine.js : check the sweep against brute-force ray marching on
// synthetic terrain, and the near/far split against one fine grid.
var E = require("../js/engine.js");
var RAD = Math.PI / 180;

function terrain(w, h, cell, x0, ytop) {
  var z = new Float32Array(w * h);
  var hills = [[0.3, 0.35, 900, 0.10], [0.7, 0.6, 600, 0.06], [0.5, 0.8, 300, 0.03], [0.15, 0.8, 400, 0.02]];
  for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
    var u = c / w, v = r / h, s = 50 + 30 * Math.sin(u * 40) * Math.cos(v * 33);
    hills.forEach(function (k) { var d2 = (u - k[0]) * (u - k[0]) + (v - k[1]) * (v - k[1]); s += k[2] * Math.exp(-d2 / (2 * k[3] * k[3])); });
    z[r * w + c] = s;
  }
  return { z: z, w: w, h: h, cell: cell, x0: x0 || 0, ytop: ytop || h * cell };
}

function brute(g, azGrid, elev) {
  var out = new Uint8Array(g.w * g.h), t = Math.tan(elev * RAD), A = azGrid * RAD;
  var sx = Math.sin(A), sy = Math.cos(A);
  for (var r = 0; r < g.h; r++) for (var c = 0; c < g.w; c++) {
    var E0 = g.x0 + (c + 0.5) * g.cell, N0 = g.ytop - (r + 0.5) * g.cell, z0 = g.z[r * g.w + c];
    for (var d = g.cell * 0.5; ; d += g.cell * 0.25) {
      var zz = E.sampleGrid(g, E0 + sx * d, N0 + sy * d);
      if (zz === null) break;
      if (zz > z0 + d * t + 1e-3) { out[r * g.w + c] = 1; break; }
    }
  }
  return out;
}

function agree(a, b, mask) {
  var n = 0, same = 0;
  for (var i = 0; i < a.length; i++) { if (mask && !mask[i]) continue; n++; if (a[i] === b[i]) same++; }
  return same / n;
}
function frac(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }

var g = terrain(300, 260, 10);
var fails = 0;
[[0, 10], [45, 15], [100, 8], [180, 25], [250, 5], [315, 30], [33, 3]].forEach(function (p) {
  var s = E.sweep(g.z, g.w, g.h, g.cell, p[0], p[1]).shade, b = brute(g, p[0], p[1]);
  var ag = agree(s, b);
  console.log("az " + p[0] + " elev " + p[1] + ": agreement " + (100 * ag).toFixed(2) + "%, shaded sweep " +
    (100 * frac(s)).toFixed(1) + "% brute " + (100 * frac(b)).toFixed(1) + "%");
  if (ag < 0.97) fails++;
});

// near/far split vs one fine grid: fine 10 m everywhere; far 80 m everywhere, near
// 10 m over a central window. Compare shade in the central target (inside the margin).
var fine = terrain(800, 800, 10);
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
var near = sub(fine, 300, 300, 200, 200), far = coarsen(fine, 8);
var dom = new E.Domain(near, far), domNear = new E.Domain(near, null);
[[0, 6], [60, 4], [300, 10], [200, 3]].forEach(function (p) {
  var ref = E.sweep(fine.z, fine.w, fine.h, fine.cell, p[0], p[1]).shade;
  var refSub = sub({ z: ref, w: fine.w, h: fine.h, cell: 10, x0: 0, ytop: fine.ytop }, 300, 300, 200, 200).z;
  var refU8 = Uint8Array.from(refSub);
  var two = dom.shadeAt(p[0], p[1], 0).slice(), one = domNear.shadeAt(p[0], p[1], 0).slice();
  // compare the inner 150 x 150 (25 cell margin)
  var mask = new Uint8Array(200 * 200);
  for (var r = 25; r < 175; r++) for (var c = 25; c < 175; c++) mask[r * 200 + c] = 1;
  var a2 = agree(two, refU8, mask), a1 = agree(one, refU8, mask);
  console.log("split az " + p[0] + " elev " + p[1] + ": near+far " + (100 * a2).toFixed(2) + "%, near only " + (100 * a1).toFixed(2) + "%");
  if (a2 < 0.95) fails++;
});

// horizon probe sanity: from the valley floor, horizon towards the big hill is high
var hz = E.horizon(near, far, near.x0 + 100 * 10, near.ytop - 100 * 10, 36, 20000, 1.5);
console.log("horizon (every 10 deg):", Array.from(hz.angles).map(function (a) { return a.toFixed(1); }).join(" "));

// timing at lunamap-ish sizes
var big = terrain(1500, 1500, 4), t0 = Date.now();
for (var i = 0; i < 5; i++) E.sweep(big.z, big.w, big.h, big.cell, 30 + i * 20, 12);
console.log("sweep 1500x1500: " + ((Date.now() - t0) / 5).toFixed(0) + " ms per sun position");

if (fails) { console.log(fails + " FAIL"); process.exit(1); } else console.log("all ok");
