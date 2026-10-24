// lunashade - worker.js: holds the loaded terrain and runs the shading off the
// main thread. Messages in: load, shade, sunhours, horizon, viewshed. Messages out
// carry the same `id` back.
// ---------------------------------------------------------------------------
importScripts("sun.js", "engine.js", "osvm.js");
var S = self.LunaSun, E = self.LunaEngine, V = self.LunaOSVM;
var dom = null, info = null, cancelled = {}, lastViewRes = null;

function cropTarget(src, T) {   // the area-of-interest window out of a near-grid array
  var w = T.c1 - T.c0, h = T.r1 - T.r0, out = new src.constructor(w * h), W = info.near.w;
  for (var r = 0; r < h; r++) out.set(src.subarray((T.r0 + r) * W + T.c0, (T.r0 + r) * W + T.c1), r * w);
  return out;
}

self.onmessage = function (ev) {
  var m = ev.data;
  if (m.type === "load") {
    info = m; dom = new E.Domain(m.near, m.far); lastViewRes = null;
    self.postMessage({ id: m.id, type: "loaded" });
  } else if (m.type === "cancel") {
    cancelled[m.which] = true;
  } else if (m.type === "shade") {
    var p = S.sunPosition(m.t, info.lat, info.lon);
    var sh = dom.shadeAt(p.az, p.elev, info.theta);
    var out = cropTarget(sh, info.target);
    self.postMessage({ id: m.id, type: "shade", sun: p, shade: out }, [out.buffer]);
  } else if (m.type === "sunhours") {
    // minutes of direct sun on each cell over one day (Hobart local date)
    var T = info.target, w = T.c1 - T.c0, h = T.r1 - T.r0, acc = new Float32Array(w * h);
    var t0 = S.hobartToUTC(m.date, 0), step = m.stepMin, nSteps = Math.round(1440 / step), daylight = 0, k = 0;
    cancelled[m.id] = false;
    (function next() {
      if (cancelled[m.id]) { self.postMessage({ id: m.id, type: "cancelled" }); return; }
      var tEnd = Date.now() + 150;
      while (k < nSteps && Date.now() < tEnd) {
        var t = t0 + (k + 0.5) * step * 60000, p = S.sunPosition(t, info.lat, info.lon);
        k++;
        if (p.elev <= 0) continue;
        daylight += step;
        var sh = dom.shadeAt(p.az, p.elev, info.theta), W = info.near.w;
        for (var r = 0; r < h; r++) {
          var o = (T.r0 + r) * W + T.c0, q = r * w;
          for (var c = 0; c < w; c++) if (!sh[o + c]) acc[q + c] += step;
        }
      }
      if (k < nSteps) { self.postMessage({ id: m.id, type: "progress", done: k / nSteps }); setTimeout(next, 0); }
      else {
        for (var i = 0; i < acc.length; i++) acc[i] /= 60;
        self.postMessage({ id: m.id, type: "sunhours", hours: acc, daylight: daylight / 60 }, [acc.buffer]);
      }
    })();
  } else if (m.type === "viewshed") {
    // object-space viewshed from (E, N): near grid then far grid, visible fraction per cell
    var res = V.viewshed([info.near, info.far], m.E, m.N, { eye: m.eye, maxDist: m.maxDist });
    lastViewRes = res;
    if (!res) { self.postMessage({ id: m.id, type: "viewshed", none: true }); return; }
    var cov = cropTarget(V.coverage(res, info.near, 2, 0), info.target);
    var sky = new Float32Array(360);
    for (var a2 = 0; a2 < 360; a2++) {
      var g2 = ((a2 + info.theta) % 360 + 360) % 360, j0 = Math.floor(g2), f2 = g2 - j0;
      sky[a2] = res.skyline[j0 % 360] * (1 - f2) + res.skyline[(j0 + 1) % 360] * f2;
    }
    self.postMessage({ id: m.id, type: "viewshed", cov: cov, skyline: sky, area: res.area, nTri: res.nTri,
      nVisTri: res.nVisTri, pieces: res.pieces.n, ms: res.ms, zEye: res.zEye }, [cov.buffer, sky.buffer]);
  } else if (m.type === "sunwindow") {
    // first and last minute (Hobart local) of direct sun on each target cell between
    // fromMin and toMin, sampled every stepMin at the middle of each step (NaN: no sun)
    var Tw = info.target, ww = Tw.c1 - Tw.c0, hw = Tw.r1 - Tw.r0, first = new Float32Array(ww * hw).fill(NaN), last = new Float32Array(ww * hw).fill(NaN);
    var stepW = m.stepMin, kW = 0, nW = Math.ceil((m.toMin - m.fromMin) / stepW);
    cancelled[m.id] = false;
    (function nextW() {
      if (cancelled[m.id]) { self.postMessage({ id: m.id, type: "cancelled" }); return; }
      var tEnd = Date.now() + 150;
      while (kW < nW && Date.now() < tEnd) {
        var mid = m.fromMin + (kW + 0.5) * stepW, t = S.hobartToUTC(m.date, mid), p = S.sunPosition(t, info.lat, info.lon);
        kW++;
        if (p.elev <= 0) continue;
        var sh = dom.shadeAt(p.az, p.elev, info.theta), W = info.near.w;
        for (var r = 0; r < hw; r++) {
          var o = (Tw.r0 + r) * W + Tw.c0, q = r * ww;
          for (var c = 0; c < ww; c++) if (!sh[o + c]) { if (first[q + c] !== first[q + c]) first[q + c] = mid; last[q + c] = mid; }
        }
      }
      if (kW < nW) { self.postMessage({ id: m.id, type: "progress", done: kW / nW }); setTimeout(nextW, 0); }
      else self.postMessage({ id: m.id, type: "sunwindow", first: first, last: last }, [first.buffer, last.buffer]);
    })();
  } else if (m.type === "viewexport") {
    // visible fraction (0..4) of every near cell and every far cell, for the GeoJSON export
    if (!lastViewRes) { self.postMessage({ id: m.id, type: "viewexport", none: true }); return; }
    var cn = V.coverage(lastViewRes, info.near, 2, 0), cf = V.coverage(lastViewRes, info.far, 2, 1);
    self.postMessage({ id: m.id, type: "viewexport", near: cn, far: cf }, [cn.buffer, cf.buffer]);
  } else if (m.type === "horizon") {
    var hz = E.horizon(info.near, info.far, m.E, m.N, 360, m.maxDist || 40000, 1.5);
    if (!hz) { self.postMessage({ id: m.id, type: "horizon", none: true }); return; }
    // rotate from grid azimuths to true azimuths (true az = grid az - theta)
    var tr = new Float32Array(360);
    for (var a = 0; a < 360; a++) {
      var g = ((a + info.theta) % 360 + 360) % 360, i0 = Math.floor(g), f = g - i0;
      tr[a] = hz.angles[i0 % 360] * (1 - f) + hz.angles[(i0 + 1) % 360] * f;
    }
    self.postMessage({ id: m.id, type: "horizon", angles: tr, z0: hz.z0 });
  }
};
