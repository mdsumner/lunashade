// lunashade - hobart.js: the Hobart vignette (docs/hobart.html). Three things to check
// over the coming weeks: the evening the sun passes behind the summit of kunanyi from a
// given spot (pure geometry, js/align.js), a map of when direct sun leaves the ground on
// a chosen evening, and last direct sun at a few spots over the next eight weeks (both
// from the Tasmania 2 m DEM, js/dem.js and js/worker.js).
// ---------------------------------------------------------------------------
(function () {
  var Q = new URLSearchParams(location.search);
  var DEM_URL = Q.get("dem") || "https://data.source.coop/alexgleith/tasmania-dem-2m/Tasmania_Statewide_2m_DEM_14-08-2021.tif";
  var LIST = "https://services.thelist.tas.gov.au/arcgis/rest/services/Basemaps/";
  var LIST_ATTR = "&copy; State of Tasmania, <a href=\"https://www.thelist.tas.gov.au\">theLIST</a>";
  var MGA94 = "+proj=utm +zone=55 +south +ellps=GRS80 " +
    "+towgs84=-0.06155,0.01087,0.04019,0.0394924,0.0327221,0.0328979,0.009994 +units=m +no_defs";
  var S = window.LunaSun, A = window.LunaAlign, Eng = window.LunaEngine;
  var $ = function (id) { return document.getElementById(id); };
  var SUMMIT_LL = [-42.896000, 147.237306], SUMMIT_Z = 1271;
  var sm = proj4("EPSG:4326", MGA94, [SUMMIT_LL[1], SUMMIT_LL[0]]), SUMMIT = { E: sm[0], N: sm[1], z: SUMMIT_Z };
  var EYE = 1.6, WEEKS = 8;

  // ---- dates ------------------------------------------------------------------------
  var TODAY = Q.get("today") || S.hobartDateString(Date.now());
  function addDays(d, n) { var p = d.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
  var DAYNAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function nice(d, withDay) {
    var p = d.split("-").map(Number), dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return (withDay ? DAYNAME[dt.getUTCDay()] + " " : "") + p[2] + " " + MON[p[1] - 1];
  }
  // a calendar from a week ago to well past the next late-summer return
  var CAL0 = addDays(TODAY, -7), cal = A.calendar(S, CAL0, 170, -42.88, 147.3);
  var iToday = 7, iSol = iToday;
  for (var ci = iToday; ci < cal.length; ci++) if (cal[ci].decl < cal[iSol].decl) iSol = ci;
  var iEnd = Math.min(iSol, iToday + WEEKS * 7);
  var solsticeDecl = cal[iSol].decl;

  function toMGA(ll) { return proj4("EPSG:4326", MGA94, [ll.lng, ll.lat]); }
  function toLL(E, N) { var q = proj4(MGA94, "EPSG:4326", [E, N]); return L.latLng(q[1], q[0]); }
  function convergence(lon, lat) {
    var a = proj4("EPSG:4326", MGA94, [lon, lat]), b = proj4("EPSG:4326", MGA94, [lon, lat + 0.01]);
    return Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI;
  }
  function baseMap(id, center, zoom) {
    var m = L.map(id, { zoomSnap: 0.25, scrollWheelZoom: false }).setView(center, zoom);
    L.tileLayer(LIST + "TopographicGrayScale/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 18, maxZoom: 19, attribution: LIST_ATTR }).addTo(m);
    L.control.scale({ imperial: false }).addTo(m);
    L.circleMarker(SUMMIT_LL, { radius: 5, color: "#333", weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip("kunanyi summit, " + SUMMIT_Z + " m").addTo(m);
    return m;
  }

  // ---- a canvas overlay for a north-up MGA grid (cells), drawn in Web Mercator ----------
  var CanvasOverlay = L.SVGOverlay.extend({});
  function gridOverlay(map, g, maxPx) {
    var corners = [];
    [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]].forEach(function (p) {
      corners.push(proj4(MGA94, "EPSG:4326", [g.x0 + p[0] * g.w * g.cell, g.ytop - p[1] * g.h * g.cell]));
    });
    var w = Math.min.apply(null, corners.map(function (p) { return p[0]; })), e = Math.max.apply(null, corners.map(function (p) { return p[0]; }));
    var s = Math.min.apply(null, corners.map(function (p) { return p[1]; })), n = Math.max.apply(null, corners.map(function (p) { return p[1]; }));
    var my = function (lat) { return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); };
    var iy = function (y) { return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI; };
    var cw = Math.min(maxPx || 1400, Math.round(g.w * 1.05)), ch = Math.round(cw * (my(n) - my(s)) / ((e - w) * Math.PI / 180));
    var G = 32, mesh = new Float64Array((G + 1) * (G + 1) * 2);
    for (var j = 0; j <= G; j++) for (var i = 0; i <= G; i++) {
      var q = proj4("EPSG:4326", MGA94, [w + (e - w) * i / G, iy(my(n) - (my(n) - my(s)) * j / G)]);
      mesh[(j * (G + 1) + i) * 2] = q[0]; mesh[(j * (G + 1) + i) * 2 + 1] = q[1];
    }
    var idx = new Int32Array(cw * ch);
    for (var y = 0; y < ch; y++) {
      var v = (y + 0.5) / ch * G, j0 = Math.min(G - 1, Math.floor(v)), fy = v - j0;
      for (var x = 0; x < cw; x++) {
        var u = (x + 0.5) / cw * G, i0 = Math.min(G - 1, Math.floor(u)), fx = u - i0;
        var a = (j0 * (G + 1) + i0) * 2, b = a + 2, c = a + (G + 1) * 2, d = c + 2;
        var E = (mesh[a] * (1 - fx) + mesh[b] * fx) * (1 - fy) + (mesh[c] * (1 - fx) + mesh[d] * fx) * fy;
        var N = (mesh[a + 1] * (1 - fx) + mesh[b + 1] * fx) * (1 - fy) + (mesh[c + 1] * (1 - fx) + mesh[d + 1] * fx) * fy;
        var col = Math.floor((E - g.x0) / g.cell), row = Math.floor((g.ytop - N) / g.cell);
        idx[y * cw + x] = (col < 0 || row < 0 || col >= g.w || row >= g.h) ? -1 : row * g.w + col;
      }
    }
    var canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch; canvas.className = "lunashade-overlay";
    var ctx = canvas.getContext("2d"), img = ctx.createImageData(cw, ch);
    var layer = new CanvasOverlay(canvas, [[s, w], [n, e]], { interactive: false, opacity: 0.75 }).addTo(map);
    return {
      layer: layer,
      paint: function (rgba) {      // rgba(k) -> [r, g, b, a] or null, for grid cell k
        var D = img.data;
        for (var p = 0; p < idx.length; p++) {
          var k = idx[p], c = k >= 0 ? rgba(k) : null;
          if (!c) { D[4 * p + 3] = 0; continue; }
          D[4 * p] = c[0]; D[4 * p + 1] = c[1]; D[4 * p + 2] = c[2]; D[4 * p + 3] = c[3];
        }
        ctx.putImageData(img, 0, 0);
      }
    };
  }
  var RAMP = ["#2c115f", "#5c167f", "#8c2981", "#bc3754", "#e55c30", "#f98e09", "#f9c932", "#fcffa4"];
  function ramp(t) {
    t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    var i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i, a = RAMP[i], b = RAMP[i + 1];
    var p = function (s, k) { return parseInt(s.substr(1 + 2 * k, 2), 16); };
    return [0, 1, 2].map(function (k) { return Math.round(p(a, k) + f * (p(b, k) - p(a, k))); });
  }

  // marching squares: segments where a node grid (w x h, row 0 north) crosses `level`,
  // in fractional node coordinates [i0, j0, i1, j1]
  function contour(v, w, h, level) {
    var segs = [];
    for (var j = 0; j < h - 1; j++) for (var i = 0; i < w - 1; i++) {
      var a = v[j * w + i], b = v[j * w + i + 1], c = v[(j + 1) * w + i + 1], d = v[(j + 1) * w + i];
      if (a !== a || b !== b || c !== c || d !== d) continue;
      var code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      var T = [i + (level - a) / (b - a), j], R = [i + 1, j + (level - b) / (c - b)],
          B = [i + (level - d) / (c - d), j + 1], Lf = [i, j + (level - a) / (d - a)];
      var pairs = { 1: [[Lf, B]], 2: [[B, R]], 3: [[Lf, R]], 4: [[T, R]], 5: [[T, R], [Lf, B]], 6: [[T, B]], 7: [[T, Lf]],
                    8: [[T, Lf]], 9: [[T, B]], 10: [[T, Lf], [B, R]], 11: [[T, R]], 12: [[Lf, R]], 13: [[B, R]], 14: [[Lf, B]] }[code];
      pairs.forEach(function (pq) { segs.push([pq[0][0], pq[0][1], pq[1][0], pq[1][1]]); });
    }
    return segs;
  }

  // =====================================================================================
  // 1. The sun behind the summit
  // =====================================================================================
  var map1 = baseMap("map1", [-42.872, 147.315], 12.25);
  // the date the alignment happens (fractional calendar index, before the solstice), on a
  // 100 m node grid over the eastern side of the mountain, for someone standing at sea level
  var NODE = 100, nE0 = SUMMIT.E + 500, nN0 = SUMMIT.N + 12000, nw = 196, nh = 181;   // 19.5 km x 18 km
  var field = new Float32Array(nw * nh).fill(NaN), never = new Uint8Array(nw * nh);
  (function () {
    var th = convergence(147.32, -42.87);
    for (var j = 0; j < nh; j++) for (var i = 0; i < nw; i++) {
      var E = nE0 + i * NODE, N = nN0 - j * NODE, k = j * nw + i;
      var ll = proj4(MGA94, "EPSG:4326", [E, N]);
      var sl = A.sightline({ E: E, N: N, z: 0, eye: EYE }, SUMMIT, th);
      if (sl.az < 180 || sl.d < 1500) continue;
      var dec = A.declinationFor(ll[1], sl.az, sl.h);
      if (dec < solsticeDecl) { never[k] = 1; continue; }
      var xs = A.crossings(cal, dec).filter(function (x) { return x <= iSol + 0.5; });
      if (xs.length) field[k] = xs[0];
    }
  })();
  var nodeGrid = { w: nw, h: nh, cell: NODE, x0: nE0 - NODE / 2, ytop: nN0 + NODE / 2 };
  var ov1 = gridOverlay(map1, nodeGrid, 900);
  ov1.layer.setOpacity(0.45);
  ov1.paint(function (k) {
    if (never[k]) return [120, 120, 120, 55];
    var x = field[k];
    if (x !== x || x < iToday - 0.5 || x > iEnd + 0.5) return null;
    var c = ramp((x - iToday) / (iEnd - iToday)); c.push(255); return c;
  });
  // daily contour lines, weekly ones bold and labelled
  function nodeLL(i, j) { return toLL(nE0 + i * NODE, nN0 - j * NODE); }
  for (var lev = iToday; lev <= iEnd; lev++) {
    var weekly = (lev - iToday) % 7 === 0, segs = contour(field, nw, nh, lev);
    if (!segs.length) continue;
    var lines = segs.map(function (s) { return [nodeLL(s[0], s[1]), nodeLL(s[2], s[3])]; });
    L.polyline(lines, { color: weekly ? "#222" : "#555", weight: weekly ? 2 : 0.6, opacity: weekly ? 0.9 : 0.5, interactive: false }).addTo(map1);
    if (weekly) {
      // label where the line is 8 or 14 km from the summit, alternating, so labels near the
      // solstice (where the lines bunch up) do not sit on top of each other
      var best = null, bd = Infinity, at = ((lev - iToday) / 7) % 2 ? 14000 : 8000;
      segs.forEach(function (s) {
        var E = nE0 + (s[0] + s[2]) / 2 * NODE, N = nN0 - (s[1] + s[3]) / 2 * NODE, dd = Math.abs(Math.hypot(E - SUMMIT.E, N - SUMMIT.N) - at);
        if (dd < bd) { bd = dd; best = [E, N]; }
      });
      if (best) L.marker(toLL(best[0], best[1]), { interactive: false,
        icon: L.divIcon({ className: "datelabel", html: nice(cal[lev].date), iconSize: null }) }).addTo(map1);
    }
  }
  // the legend
  (function () {
    var stops = [];
    for (var t = 0; t <= 1.0001; t += 0.25) { var c = ramp(t); stops.push("rgb(" + c.join(",") + ")"); }
    $("legend1").innerHTML = "<div class='bar' style='background:linear-gradient(to right," + stops.join(",") + ")'></div>" +
      "<div class='ticks'><span>" + nice(cal[iToday].date, true) + "</span><span>evening the sun passes behind the summit (standing at sea level)</span><span>" +
      nice(cal[iEnd].date, true) + "</span></div>" +
      "<div><span class='sw' style='background:#bcbcbc'></span> the summit is further south than the sun ever sets: never from here</div>";
  })();

  // the card for one spot
  var spot1 = null;
  function groundAt(E, N) {
    return D().readMGA([E - 3, N - 3, E + 3, N + 3], 2).then(function (g) {
      var z = Eng.sampleGrid(g, E, N); return z === null ? g.z[0] : z;
    });
  }
  // is the summit in sight from (E, N, eye height above ground z)? bare earth, curvature included
  function summitVisible(E, N, z) {
    var pad = 60, bb = [Math.min(E, SUMMIT.E) - pad, Math.min(N, SUMMIT.N) - pad, Math.max(E, SUMMIT.E) + pad, Math.max(N, SUMMIT.N) + pad];
    return D().readMGA(bb, 8).then(function (g) {
      var d = Math.hypot(SUMMIT.E - E, SUMMIT.N - N), zEye = z + EYE, R = A.apparentElevation;
      var target = R(SUMMIT.z - zEye, d), worst = { a: -90, s: 0 };
      for (var s = 30; s < d - 60; s += 8) {
        var zz = Eng.sampleGrid(g, E + (SUMMIT.E - E) * s / d, N + (SUMMIT.N - N) * s / d);
        if (zz === null) continue;
        var a = R(zz - zEye, s);
        if (a > worst.a) worst = { a: a, s: s };
      }
      return { visible: worst.a < target - 0.02, block: worst, target: target };
    });
  }
  function card(ll) {
    var q = toMGA(ll), th = convergence(ll.lng, ll.lat);
    if (spot1) spot1.setLatLng(ll); else spot1 = L.circleMarker(ll, { radius: 7, color: "#e65100", weight: 2, fillOpacity: 0.3 }).addTo(map1);
    $("card1").hidden = false;
    $("card1").innerHTML = "Working it out for " + ll.lat.toFixed(5) + ", " + ll.lng.toFixed(5) + " ...";
    function describe(z, zNote, vis) {
      var obs = { E: q[0], N: q[1], lat: ll.lat, lon: ll.lng, z: z, eye: EYE };
      var r = A.alignment(S, cal, obs, SUMMIT, { theta: th }), sl = r.sight;
      var html = "<b>From " + ll.lat.toFixed(5) + ", " + ll.lng.toFixed(5) + "</b> (ground " + zNote + ", eye " + EYE + " m above it)<br>" +
        "The summit is " + (sl.d / 1000).toFixed(2) + " km away, at " + sl.az.toFixed(1) + " deg (true) and " + sl.h.toFixed(2) + " deg above the horizon.";
      if (vis) html += "<br>" + (vis.visible ? "It is in sight from here (bare ground; trees and buildings can still hide it)." :
        "<b>It is hidden</b> by ground " + (vis.block.s / 1000).toFixed(2) + " km away, " + (vis.block.a - vis.target).toFixed(2) + " deg above the summit's line of sight.");
      var ev = r.events.filter(function (e) { return e.date >= TODAY; });
      if (sl.az < 180) html += "<p>The summit is in the eastern sky from here, so the sun never sets behind it.</p>";
      else if (!ev.length && r.decl < solsticeDecl) html += "<p>The sun never sets behind the summit from here: it would have to go down " +
        "further south than it ever does (declination " + r.decl.toFixed(1) + " deg; the sun reaches " + solsticeDecl.toFixed(1) + " deg at the solstice).</p>";
      else if (!ev.length) html += "<p>No alignment between " + nice(cal[0].date) + " and " + nice(cal[cal.length - 1].date) + ".</p>";
      else {
        html += "<ul>" + ev.map(function (e) {
          return "<li><b>" + nice(e.date, true) + " " + e.date.slice(0, 4) + " at " + S.fmtClock(e.minute) + "</b>: the sun's centre passes " +
            Math.abs(e.miss).toFixed(2) + " deg " + (e.miss >= 0 ? "above" : "below") + " the summit" +
            (e.first !== e.last ? "; part of the disk crosses it from " + nice(e.first) + " to " + nice(e.last) : "") + ".</li>";
        }).join("") + "</ul>";
        // how sensitive is that to where you stand?
        var shift = function (dE, dN, dz) {
          var r2 = A.alignment(S, cal, { E: q[0] + dE, N: q[1] + dN, lat: ll.lat + dN / 111000, lon: ll.lng, z: z + dz, eye: EYE }, SUMMIT, { theta: th });
          var x0 = A.crossings(cal, r.decl)[0], x1 = A.crossings(cal, r2.decl)[0];
          return x0 === undefined || x1 === undefined ? null : Math.abs(x1 - x0);
        };
        var sN = shift(0, 100, 0), sZ = shift(0, 0, 10);
        if (sN !== null && sZ !== null) html += "<div class='small'>Standing 100 m further north or south moves the date by about " + sN.toFixed(1) +
          " days; standing 10 m higher, by about " + sZ.toFixed(1) + " days.</div>";
      }
      $("card1").innerHTML = html + "<div class='small'><a href='#' id='share1'>Link to this spot</a></div>";
      $("share1").onclick = function (e) {
        e.preventDefault();
        var u = location.pathname + "?spot=" + ll.lat.toFixed(6) + "," + ll.lng.toFixed(6) + "#check";
        history.replaceState(null, "", u); $("share1").textContent = "Link in the address bar";
      };
    }
    describe(0, "assumed at sea level", null);
    groundAt(q[0], q[1]).then(function (z) {
      describe(z, Math.round(z) + " m from the DEM", null);
      return summitVisible(q[0], q[1], z).then(function (vis) { describe(z, Math.round(z) + " m from the DEM", vis); });
    }).catch(function (e) { console.warn(e); });
  }
  map1.on("click", function (e) { card(e.latlng); });
  $("locate").onclick = function () {
    if (!navigator.geolocation) { $("card1").hidden = false; $("card1").textContent = "This browser cannot give a location."; return; }
    $("locate").disabled = true;
    navigator.geolocation.getCurrentPosition(function (p) {
      $("locate").disabled = false; var ll = L.latLng(p.coords.latitude, p.coords.longitude); map1.setView(ll, 14); card(ll);
    }, function (err) { $("locate").disabled = false; $("card1").hidden = false; $("card1").textContent = "No location: " + err.message; },
    { enableHighAccuracy: true, timeout: 20000 });
  };
  (function () { var s = (Q.get("spot") || "").split(",").map(Number); if (s.length === 2 && s.every(isFinite)) card(L.latLng(s[0], s[1])); })();

  // =====================================================================================
  // 2 and 3. Terrain: when the sun leaves the ground, and last sun over the coming weeks
  // =====================================================================================
  var dem = null;
  function D() { if (!dem) dem = window.LunaDEM(DEM_URL); return dem; }
  var worker = null, nextId = 1, pending = {};
  function ask(msg, transfer, progress) {
    if (!worker) {
      worker = new Worker("../js/worker.js");
      worker.onmessage = function (ev) {
        var m = ev.data, cb = pending[m.id]; if (!cb) return;
        if (m.type === "progress") { if (cb.progress) cb.progress(m.done); return; }
        delete pending[m.id]; cb.done(m);
      };
    }
    return new Promise(function (resolve) { msg.id = nextId++; pending[msg.id] = { done: resolve, progress: progress }; worker.postMessage(msg, transfer || []); });
  }
  var map2 = baseMap("map2", [-42.872, 147.305], 12);
  var CELL = 16, MARGIN = 3000, FAR = 40000, FAR_CELL = 64;
  var tb = [SUMMIT.E - 5000, SUMMIT.N - 10000, SUMMIT.E + 17000, SUMMIT.N + 12000];      // 22 km square
  L.polygon([[tb[0], tb[1]], [tb[2], tb[1]], [tb[2], tb[3]], [tb[0], tb[3]]].map(function (p) { return toLL(p[0], p[1]); }),
    { color: "#4a3a8c", weight: 1.5, dashArray: "4 4", fill: false, interactive: false }).addTo(map2);
  var terr = null, ov2 = null, win = null;
  var sat = (function () { var d = TODAY; for (var i = 0; i < 7; i++) { var dd = addDays(TODAY, i), p = dd.split("-").map(Number); if (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() === 6) return dd; } return d; })();
  $("date2").value = Q.get("evening") || sat;
  $("date2").min = TODAY;

  function loadTerrain() {
    if (terr) return Promise.resolve(terr);
    var nb = [tb[0] - MARGIN, tb[1] - MARGIN, tb[2] + MARGIN, tb[3] + MARGIN];
    var cE = (tb[0] + tb[2]) / 2, cN = (tb[1] + tb[3]) / 2, fb = [cE - FAR, cN - FAR, cE + FAR, cN + FAR];
    var m0 = D().netMark(), diag = {};
    $("status2").textContent = "Reading the DEM: the city at " + CELL + " m ...";
    return D().readMGA(nb, CELL).then(function (near) {
      diag.near = D().netSince(m0); var m1 = D().netMark();
      $("status2").textContent = "Reading the DEM: 80 km of surround at " + FAR_CELL + " m ...";
      return D().readMGA(fb, FAR_CELL).then(function (far) {
        diag.far = D().netSince(m1);
        var T = { c0: Math.round((tb[0] - near.x0) / near.cell), r0: Math.round((near.ytop - tb[3]) / near.cell) };
        T.c1 = Math.min(near.w, T.c0 + Math.round((tb[2] - tb[0]) / near.cell)); T.r1 = Math.min(near.h, T.r0 + Math.round((tb[3] - tb[1]) / near.cell));
        var tg = { w: T.c1 - T.c0, h: T.r1 - T.r0, cell: near.cell, x0: near.x0 + T.c0 * near.cell, ytop: near.ytop - T.r0 * near.cell };
        var cll = toLL(cE, cN);
        terr = { tg: tg, lat: cll.lat, lon: cll.lng, theta: convergence(cll.lng, cll.lat), diag: diag };
        return ask({ type: "load", near: near, far: far, target: T, lat: terr.lat, lon: terr.lon, theta: terr.theta }, [near.z.buffer, far.z.buffer])
          .then(function () {
            $("status2").textContent = "Terrain loaded (city " + diag.near + "; surround " + diag.far + ").";
            ov2 = gridOverlay(map2, tg, 1400);
            return terr;
          });
      });
    });
  }
  // last direct sun on the chosen evening, everywhere in the square
  function evening() {
    $("go2").disabled = true;
    var d = $("date2").value;
    loadTerrain().then(function () {
      var t0 = performance.now();
      return ask({ type: "sunwindow", date: d, fromMin: 780, toMin: 1320, stepMin: 5 }, null, function (f) {
        $("status2").textContent = "Following the sun across the city on " + nice(d, true) + ": " + Math.round(100 * f) + "%";
      }).then(function (m) {
        win = { date: d, last: m.last };
        var flat = flatSunset(d, terr.lat, terr.lon), lo = Infinity;
        for (var k = 0; k < m.last.length; k++) if (m.last[k] < lo) lo = m.last[k];
        lo = Math.max(lo, flat - 240);
        var span = Math.max(30, flat - lo);
        ov2.paint(function (k) {
          var v = m.last[k];
          if (v !== v || v < lo) return [25, 25, 40, 230];
          var c = ramp(Math.floor((v - lo) / 15) * 15 / span); c.push(230); return c;
        });
        var stops = []; for (var t = 0; t <= 1.0001; t += 0.25) { var c = ramp(t); stops.push("rgb(" + c.join(",") + ")"); }
        $("legend2").innerHTML = "<div class='bar' style='background:linear-gradient(to right," + stops.join(",") + ")'></div>" +
          "<div class='ticks'><span>" + S.fmtClock(lo) + " or earlier</span><span>last direct sun, " + nice(d, true) + " (15 min steps)</span><span>" +
          S.fmtClock(flat) + " (sunset on a flat horizon)</span></div>";
        $("status2").textContent = "Done in " + ((performance.now() - t0) / 1000).toFixed(1) + " s. Tap the map for the time at a spot, and to add it to the chart below.";
        $("go2").disabled = false;
      });
    }).catch(function (e) {
      console.error(e); $("go2").disabled = false;
      $("status2").textContent = "Could not read the DEM: " + (e && e.message ? e.message : e);
    });
  }
  $("go2").onclick = evening;
  $("date2").onchange = function () { if (terr) evening(); };
  function flatSunset(d, lat, lon) {
    var prev = true;
    for (var m = 900; m <= 1380; m++) {
      var up = S.sunPosition(S.hobartToUTC(d, m), lat, lon).elev > -0.27;
      if (prev && !up) return m;
      prev = up;
    }
    return 1380;
  }

  // ---- 3. last sun at spots over the coming weeks ----------------------------------------
  var COLORS = ["#1b6ca8", "#d1495b", "#2e933c", "#8c2981", "#e58e00", "#3a3a3a"];
  var spots = [], markers2 = [];
  var EXAMPLES = [   // rough positions, for a first look; tap the map for exact ones
    ["Fern Tree (approx.)", -42.9205, 147.2615], ["South Hobart (approx.)", -42.8960, 147.3000],
    ["Hobart waterfront (approx.)", -42.8840, 147.3320], ["Bellerive (approx.)", -42.8740, 147.3760]];
  function lastSunSeries(hz, lat, lon) {
    var out = [];
    for (var i = iToday; i < iToday + WEEKS * 7; i++) {
      var d = cal[i].date, last = null;
      for (var m = 720; m < 1380; m++) {
        var p = S.sunPosition(S.hobartToUTC(d, m + 0.5), lat, lon);
        var a = p.az, i0 = Math.floor(a) % 360, f = a - Math.floor(a), h = hz[i0] * (1 - f) + hz[(i0 + 1) % 360] * f;
        if (p.elev > Math.max(-0.27, h)) last = m + 1;
      }
      out.push({ date: d, last: last, flat: flatSunset(d, lat, lon) });
    }
    return out;
  }
  function addSpot(name, ll) {
    if (spots.length >= COLORS.length) spots.shift();
    var q = toMGA(ll), spot = { name: name, ll: ll, series: null };
    spots.push(spot); drawChart();
    return ask({ type: "horizon", E: q[0], N: q[1], maxDist: FAR }).then(function (m) {
      if (m.none) { spots.splice(spots.indexOf(spot), 1); drawChart(); return; }
      spot.series = lastSunSeries(m.angles, ll.lat, ll.lng); spot.z = m.z0; drawChart();
    });
  }
  map2.on("click", function (e) {
    if (!terr) return;
    var ll = e.latlng, q = toMGA(ll), tg = terr.tg, col = Math.floor((q[0] - tg.x0) / tg.cell), row = Math.floor((tg.ytop - q[1]) / tg.cell);
    var inside = col >= 0 && row >= 0 && col < tg.w && row < tg.h;
    var txt = inside && win ? (win.last[row * tg.w + col] === win.last[row * tg.w + col] ?
      "Last direct sun here on " + nice(win.date, true) + ": about " + S.fmtClock(win.last[row * tg.w + col]) + " (to within the 5-minute step)" :
      "No direct sun here after 13:00 on " + nice(win.date, true)) : "";
    L.popup().setLatLng(ll).setContent((txt ? txt + "<br>" : "") + "Added to the chart below.").openOn(map2);
    addSpot(ll.lat.toFixed(4) + ", " + ll.lng.toFixed(4), ll);
  });
  function drawChart() {
    var W = 680, H = 300, L0 = 46, R0 = 10, T0 = 10, B0 = 34, n = WEEKS * 7;
    var vals = [];
    spots.forEach(function (s) { if (s.series) s.series.forEach(function (p) { if (p.last !== null) vals.push(p.last); vals.push(p.flat); }); });
    if (!spots.length) { $("chart3").innerHTML = "<p class='small'>Load the terrain (above) to start the chart.</p>"; return; }
    var lo = vals.length ? Math.floor((Math.min.apply(null, vals) - 10) / 30) * 30 : 960, hi = vals.length ? Math.ceil((Math.max.apply(null, vals) + 10) / 30) * 30 : 1260;
    var X = function (i) { return L0 + (W - L0 - R0) * i / (n - 1); }, Y = function (m) { return T0 + (H - T0 - B0) * (hi - m) / (hi - lo); };
    var g = "";
    for (var m = lo; m <= hi; m += 30) g += "<line x1='" + L0 + "' x2='" + (W - R0) + "' y1='" + Y(m) + "' y2='" + Y(m) + "' stroke='#eee'/>" +
      "<text x='" + (L0 - 4) + "' y='" + (Y(m) + 4) + "' text-anchor='end'>" + S.fmtClock(m) + "</text>";
    for (var i = 0; i < n; i += 7) g += "<line x1='" + X(i) + "' x2='" + X(i) + "' y1='" + T0 + "' y2='" + (H - B0) + "' stroke='#eee'/>" +
      "<text x='" + X(i) + "' y='" + (H - B0 + 14) + "' text-anchor='middle'>" + nice(cal[iToday + i].date) + "</text>";
    var paths = "", legend = "";
    spots.forEach(function (s, k) {
      var col = COLORS[k % COLORS.length];
      legend += "<span class='lg'><span class='sw' style='background:" + col + "'></span>" + s.name +
        (s.series ? "" : " (tracing ...)") + " <a href='#' data-k='" + k + "' class='rm'>remove</a></span> ";
      if (!s.series) return;
      var p = "", pf = "";
      s.series.forEach(function (q, i) {
        if (q.last !== null) p += (p ? "L" : "M") + X(i).toFixed(1) + "," + Y(q.last).toFixed(1);
        pf += (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(q.flat).toFixed(1);
      });
      paths += "<path d='" + p + "' fill='none' stroke='" + col + "' stroke-width='2'/>";
      if (k === 0) paths += "<path d='" + pf + "' fill='none' stroke='#999' stroke-width='1.5' stroke-dasharray='5 4'/>";
    });
    $("chart3").innerHTML = "<svg viewBox='0 0 " + W + " " + H + "'><g font-size='11' fill='#555' font-family='system-ui,sans-serif'>" + g + "</g>" + paths +
      "<text x='" + (W - R0) + "' y='" + (T0 + 12) + "' text-anchor='end' font-size='11' fill='#777'>dashed: sunset on a flat horizon</text></svg>" +
      "<div class='legendrow'>" + legend + "</div>";
    Array.prototype.forEach.call(document.querySelectorAll("#chart3 .rm"), function (a) {
      a.onclick = function (e) { e.preventDefault(); spots.splice(+a.dataset.k, 1); drawChart(); };
    });
  }
  $("go3").onclick = function () {
    $("go3").disabled = true;
    loadTerrain().then(function () {
      return EXAMPLES.reduce(function (p, ex) { return p.then(function () { return addSpot(ex[0], L.latLng(ex[1], ex[2])); }); }, Promise.resolve());
    }).then(function () { $("go3").disabled = false; }).catch(function (e) {
      console.error(e); $("go3").disabled = false; $("status2").textContent = "Could not read the DEM: " + (e && e.message ? e.message : e);
    });
  };
  drawChart();
  window.lunashadeHobart = { cal: cal, field: field, iToday: iToday, iEnd: iEnd, card: card, addSpot: addSpot, evening: evening };
})();
