// lunashade - worker.js: holds the loaded terrain and runs the shading off the
// main thread. Messages in: load, shade, sunhours, horizon. Messages out carry
// the same `id` back.
// ---------------------------------------------------------------------------
importScripts("sun.js", "engine.js");
var S = self.LunaSun, E = self.LunaEngine;
var dom = null, info = null, cancelled = {};

function cropTarget(src, T) {   // the area-of-interest window out of a near-grid array
  var w = T.c1 - T.c0, h = T.r1 - T.r0, out = new src.constructor(w * h), W = info.near.w;
  for (var r = 0; r < h; r++) out.set(src.subarray((T.r0 + r) * W + T.c0, (T.r0 + r) * W + T.c1), r * w);
  return out;
}

self.onmessage = function (ev) {
  var m = ev.data;
  if (m.type === "load") {
    info = m; dom = new E.Domain(m.near, m.far);
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
