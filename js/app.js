// lunashade - app.js: the page. Reads a square of the Tasmania 2 m DEM (and a wide
// coarse surround) straight from the cloud-optimised GeoTIFF with geotiff.js, hands
// it to a worker that casts shadows (js/engine.js), and draws the result over a
// theLIST basemap. No server, no build step.
// ---------------------------------------------------------------------------
(function () {
  var Q = new URLSearchParams(location.search);
  var DEM_URL = Q.get("dem") || "https://data.source.coop/alexgleith/tasmania-dem-2m/Tasmania_Statewide_2m_DEM_14-08-2021.tif";
  var LIST = "https://services.thelist.tas.gov.au/arcgis/rest/services/Basemaps/";
  var LIST_ATTR = "&copy; State of Tasmania, <a href=\"https://www.thelist.tas.gov.au\">theLIST</a>";
  var FAR_RADIUS = 40000;            // metres of coarse surround each way
  var MGA94 = "+proj=utm +zone=55 +south +ellps=GRS80 " +
    "+towgs84=-0.06155,0.01087,0.04019,0.0394924,0.0327221,0.0328979,0.009994 +units=m +no_defs";
  var S = window.LunaSun;
  var $ = function (id) { return document.getElementById(id); };

  // ---- map ------------------------------------------------------------------
  var map = L.map("map", { zoomSnap: 0.25, maxZoom: 19 });
  function listLayer(svc, max) {
    return L.tileLayer(LIST + svc + "/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: max, maxZoom: 19, attribution: LIST_ATTR });
  }
  var base = {
    "Topographic (grey)": listLayer("TopographicGrayScale", 18),
    "Topographic": listLayer("Topographic", 18),
    "Hillshade": listLayer("Hillshade", 18),
    "Aerial photo": listLayer("Orthophoto", 19),
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors" })
  };
  base["Topographic (grey)"].addTo(map);
  L.control.layers(base, null, { position: "topleft" }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  // URL state. Query: at (centre of the loaded square), detail, date, time, mode, probe (tapped
  // spot), dem; any of at / probe / load=1 loads straight away. Hash: the map view.
  function llParam(v) { var a = (v || "").split(",").map(Number); return a.length === 2 && a.every(isFinite) ? L.latLng(a[0], a[1]) : null; }
  var startAt = llParam(Q.get("at")), startProbe = llParam(Q.get("probe"));
  var h = location.hash.replace("#", "").split("/").map(Number);
  if (h.length >= 3 && h.every(isFinite)) map.setView([h[0], h[1]], h[2]);
  else if (startAt || startProbe) centreVisible(startAt || startProbe, 14);
  else map.setView([-42.912, 147.262], 13);    // kunanyi / Fern Tree
  map.on("moveend", function () { updateURL(); });

  // The panel covers part of the map (the right side on a wide screen, the bottom on a phone).
  // "The middle of the map" means the middle of the part you can see.
  function visibleCentrePoint() {
    var mr = map.getContainer().getBoundingClientRect(), pr = $("panel").getBoundingClientRect();
    var x0 = 0, x1 = mr.width, y0 = 0, y1 = mr.height;
    if (pr.width > 0 && pr.height > 0) {
      if (pr.width > mr.width * 0.8) y1 = Math.max(80, pr.top - mr.top);   // bottom sheet
      else x1 = Math.max(80, pr.left - mr.left);                             // side panel
    }
    return L.point((x0 + x1) / 2, (y0 + y1) / 2);
  }
  function viewCentre() { return map.containerPointToLatLng(visibleCentrePoint()); }
  function centreVisible(latlng, zoom) {
    map.setView(latlng, zoom, { animate: false });
    var off = visibleCentrePoint().subtract(map.getSize().divideBy(2));
    map.panBy(off.multiplyBy(-1), { animate: false });
  }
  // dashed preview of the square "Load terrain here" will read
  var preview = L.polygon([], { color: "#555", weight: 1.5, dashArray: "2 5", fill: false, interactive: false }).addTo(map);
  function squareLatLngs(c, size) {
    var cen = proj4("EPSG:4326", MGA94, [c.lng, c.lat]), h2 = size / 2;
    return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(function (k) {
      var ll = proj4(MGA94, "EPSG:4326", [cen[0] + k[0] * h2, cen[1] + k[1] * h2]); return [ll[1], ll[0]];
    });
  }
  function updatePreview() { preview.setLatLngs(squareLatLngs(viewCentre(), +$("detail").value * 1000)); }
  map.on("move resize", updatePreview);
  window.addEventListener("resize", updatePreview);

  // a Leaflet overlay that shows a <canvas> (SVGOverlay just places the element it is given)
  var CanvasOverlay = L.SVGOverlay.extend({});

  // ---- DEM access (js/dem.js) ----------------------------------------------------------
  var D = window.LunaDEM(DEM_URL), openDEM = D.openDEM, readMGA = D.readMGA, netMark = D.netMark, netSince = D.netSince;

  // ---- worker -------------------------------------------------------------------
  var worker = new Worker("js/worker.js"), nextId = 1, pending = {};
  worker.onmessage = function (ev) {
    var m = ev.data, cb = pending[m.id];
    if (!cb) return;
    if (m.type === "progress") { if (cb.progress) cb.progress(m.done); return; }
    delete pending[m.id];
    cb.done(m);
  };
  function ask(msg, transfer, progress) {
    return new Promise(function (resolve) {
      msg.id = nextId++; pending[msg.id] = { done: resolve, progress: progress }; worker.postMessage(msg, transfer || []);
    });
  }

  // ---- state ----------------------------------------------------------------------
  var st = null;          // loaded area: { target grid geometry, overlay mapping, lat, lon, theta, E, N }
  var overlay = null, outline = null, probeMarker = null, hours = null, lastShade = null, lastSun = null, lastView = null;
  var status = function (s) { $("status").innerHTML = s; };
  function mode() { return document.querySelector("input[name=mode]:checked").value; }
  function dateStr() { return $("date").value; }
  function minutes() { return +$("time").value; }

  $("date").value = Q.get("date") || S.hobartDateString(Date.now());
  (function () { var now = new Date(), off = S.hobartOffset(now.getTime()); var m = Math.round(((now.getTime() / 60000 + off) % 1440 + 1440) % 1440 / 5) * 5;
    $("time").value = Q.get("time") ? +Q.get("time") : (m < 420 || m > 1200 ? 720 : m); })();   // at night, start at noon

  // grid azimuth of true north at a point (meridian convergence), degrees
  function convergence(lon, lat) {
    var a = proj4("EPSG:4326", MGA94, [lon, lat]), b = proj4("EPSG:4326", MGA94, [lon, lat + 0.01]);
    return Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI;
  }

  function load() {
    var km = +$("detail").value, cell = km, size = km * 1000, margin = Math.max(1000, size / 4);
    var c = loadAt || viewCentre(), cen = proj4("EPSG:4326", MGA94, [c.lng, c.lat]);
    loadAt = null;
    var tb = [cen[0] - size / 2, cen[1] - size / 2, cen[0] + size / 2, cen[1] + size / 2];
    var nb = [tb[0] - margin, tb[1] - margin, tb[2] + margin, tb[3] + margin];
    var fb = [cen[0] - FAR_RADIUS, cen[1] - FAR_RADIUS, cen[0] + FAR_RADIUS, cen[1] + FAR_RADIUS];
    var farCell = Math.max(64, cell * 8);
    $("load").disabled = true; hours = null; lastShade = null; lastView = null;
    status("Reading the DEM (" + km + " km at " + cell + " m, plus " + (margin / 1000) + " km margin and " +
      (FAR_RADIUS / 1000) + " km of surround at " + farCell + " m) ...");
    var t0 = performance.now(), m0 = netMark(), diag = {};
    // one after the other (not in parallel) so each step's cost can be reported
    openDEM().then(function () {
      diag.open = netSince(m0); var m1 = netMark();
      status("Reading the square (" + km + " km at " + cell + " m) ...");
      return readMGA(nb, cell).then(function (near) {
        diag.square = netSince(m1); var m2 = netMark();
        status("Reading the surround (" + (FAR_RADIUS / 500) + " km square at " + farCell + " m) ...");
        return readMGA(fb, farCell).then(function (far) { diag.surround = netSince(m2); return [near, far]; });
      });
    }).then(function (r) {
      var near = r[0], far = r[1];
      var T = { c0: Math.round((tb[0] - near.x0) / near.cell), r0: Math.round((near.ytop - tb[3]) / near.cell) };
      T.c1 = Math.min(near.w, T.c0 + Math.round(size / near.cell)); T.r1 = Math.min(near.h, T.r0 + Math.round(size / near.cell));
      var zmax = 0; for (var i = 0; i < near.z.length; i++) if (near.z[i] > zmax) zmax = near.z[i];
      var tg = { w: T.c1 - T.c0, h: T.r1 - T.r0, cell: near.cell, x0: near.x0 + T.c0 * near.cell, ytop: near.ytop - T.r0 * near.cell };
      // keep a copy of the target heights for the probe readout
      var tz = new Float32Array(tg.w * tg.h);
      for (var y = 0; y < tg.h; y++) tz.set(near.z.subarray((T.r0 + y) * near.w + T.c0, (T.r0 + y) * near.w + T.c1), y * tg.w);
      var ll = proj4(MGA94, "EPSG:4326", cen);
      st = { diag: diag, near: { w: near.w, h: near.h, cell: near.cell, x0: near.x0, ytop: near.ytop },
             far: { w: far.w, h: far.h, cell: far.cell, x0: far.x0, ytop: far.ytop }, tg: tg, tz: tz, lat: ll[1], lon: ll[0], detail: $("detail").value, theta: convergence(ll[0], ll[1]), nearCell: near.cell, farCell: far.cell,
             nearLevel: near.level, farLevel: far.level, farBlock: far.block, zmax: zmax };
      buildOverlay();
      var secs = ((performance.now() - t0) / 1000).toFixed(1);
      return ask({ type: "load", near: near, far: far, target: T, lat: st.lat, lon: st.lon, theta: st.theta },
                 [near.z.buffer, far.z.buffer]).then(function () {
        status("Loaded " + tg.w + " x " + tg.h + " cells at " + st.nearCell.toFixed(1) + " m, surround at " +
          st.farCell.toFixed(0) + " m, in " + secs + " s. Highest ground in view: " + Math.round(zmax) + " m." +
          " <span style='color:#888'>(COG overview " + st.nearLevel + " / " + st.farLevel + (st.farBlock > 1 ? ", averaged x" + st.farBlock : "") + ")</span>" +
          "<div style='color:#888'>DEM reads: open " + diag.open + "; square " + diag.square + "; surround " + diag.surround + "</div>");
        $("load").disabled = false;
        refresh(); updateURL();
        if (probeNext) { var pn = probeNext; probeNext = null; probe(pn); }
      });
    }).catch(function (e) {
      console.error(e); $("load").disabled = false;
      status("Could not read the DEM: " + (e && e.message ? e.message : e) + ". (It is read live from Source Cooperative.)");
    });
  }

  // map each overlay canvas pixel (Web Mercator, north-up) to a target cell (MGA, north-up)
  function buildOverlay() {
    var tg = st.tg, corners = [];
    [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]].forEach(function (p) {
      corners.push(proj4(MGA94, "EPSG:4326", [tg.x0 + p[0] * tg.w * tg.cell, tg.ytop - p[1] * tg.h * tg.cell]));
    });
    var w = Math.min.apply(null, corners.map(function (p) { return p[0]; })), e = Math.max.apply(null, corners.map(function (p) { return p[0]; }));
    var s = Math.min.apply(null, corners.map(function (p) { return p[1]; })), n = Math.max.apply(null, corners.map(function (p) { return p[1]; }));
    var my = function (lat) { return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); };
    var iy = function (y) { return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI; };
    var cw = Math.min(1600, Math.round(tg.w * 1.05)), ch = Math.round(cw * (my(n) - my(s)) / ((e - w) * Math.PI / 180));
    var G = 32, mesh = new Float64Array((G + 1) * (G + 1) * 2);
    for (var j = 0; j <= G; j++) for (var i = 0; i <= G; i++) {
      var lon = w + (e - w) * i / G, lat = iy(my(n) - (my(n) - my(s)) * j / G), q = proj4("EPSG:4326", MGA94, [lon, lat]);
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
        var col = Math.floor((E - tg.x0) / tg.cell), row = Math.floor((tg.ytop - N) / tg.cell);
        idx[y * cw + x] = (col < 0 || row < 0 || col >= tg.w || row >= tg.h) ? -1 : row * tg.w + col;
      }
    }
    var canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch;
    canvas.className = "lunashade-overlay";
    st.canvas = canvas; st.idx = idx; st.ctx = canvas.getContext("2d"); st.img = st.ctx.createImageData(cw, ch);
    if (overlay) map.removeLayer(overlay);
    if (outline) map.removeLayer(outline);
    overlay = new CanvasOverlay(canvas, [[s, w], [n, e]], { opacity: +$("opacity").value, interactive: false }).addTo(map);
    outline = L.polygon(corners.slice(0, 4).map(function (p) { return [p[1], p[0]]; }),
      { color: "#4a3a8c", weight: 1.5, fill: false, dashArray: "4 4", interactive: false }).addTo(map);
  }

  var RAMP = ["#0b0724", "#2c115f", "#5c167f", "#8c2981", "#bc3754", "#e55c30", "#f98e09", "#f9c932", "#fcffa4"];
  function rampRGB(t) {
    t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    var i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i, a = RAMP[i], b = RAMP[i + 1];
    var p = function (s, k) { return parseInt(s.substr(1 + 2 * k, 2), 16); };
    return [0, 1, 2].map(function (k) { return Math.round(p(a, k) + f * (p(b, k) - p(a, k))); });
  }
  function draw() {
    if (!st) return;
    var data = st.img.data, idx = st.idx, n = idx.length, i, k;
    if (mode() === "shade" && lastShade) {
      for (i = 0; i < n; i++) {
        k = idx[i];
        if (k >= 0 && lastShade[k]) { data[4 * i] = 22; data[4 * i + 1] = 26; data[4 * i + 2] = 70; data[4 * i + 3] = 255; }
        else data[4 * i + 3] = 0;
      }
      $("legend").innerHTML = "<span style='display:inline-block;width:14px;height:10px;background:#16184a;vertical-align:middle'></span> " +
        "in the shadow of terrain (or sun below the horizon)";
    } else if (mode() === "hours" && hours) {
      var lut = [], top = hours.daylight || 1;
      for (var q = 0; q <= 255; q++) lut.push(rampRGB(q / 255));
      for (i = 0; i < n; i++) {
        k = idx[i];
        if (k < 0) { data[4 * i + 3] = 0; continue; }
        var c = lut[Math.round(255 * hours.hours[k] / top)];
        data[4 * i] = c[0]; data[4 * i + 1] = c[1]; data[4 * i + 2] = c[2]; data[4 * i + 3] = 255;
      }
      $("legend").innerHTML = "<div class='bar' style='background:linear-gradient(to right," + RAMP.join(",") + ")'></div>" +
        "<div class='ticks'><span>0 h</span><span>hours of direct sun, " + dateStr() + "</span><span>" + top.toFixed(1) + " h</span></div>";
    } else if (mode() === "view" && lastView) {
      var cov = lastView.cov;
      for (i = 0; i < n; i++) {
        k = idx[i];
        if (k < 0) { data[4 * i + 3] = 0; continue; }
        var fr = cov[k] / 4;
        data[4 * i] = Math.round(22 + fr * (249 - 22)); data[4 * i + 1] = Math.round(26 + fr * (201 - 26)); data[4 * i + 2] = Math.round(70 + fr * (50 - 70));
        data[4 * i + 3] = Math.round(255 * (0.75 - 0.35 * fr));
      }
      $("legend").innerHTML = "<span style='display:inline-block;width:14px;height:10px;background:#f9c932;vertical-align:middle'></span> " +
        "ground visible from the spot &nbsp; <span style='display:inline-block;width:14px;height:10px;background:#16184a;vertical-align:middle'></span> hidden";
    } else {
      for (i = 0; i < n; i++) data[4 * i + 3] = 0;
      $("legend").innerHTML = mode() === "view" ? "<span class='status'>Tap a spot in the loaded square to see what is visible from it.</span>" : mode() === "hours" ? "<span class='status'>Not calculated yet for this date.</span>" : "";
    }
    st.ctx.putImageData(st.img, 0, 0);
    var md = mode();
    $("export").disabled = !((md === "shade" && lastShade) || (md === "hours" && hours) || (md === "view" && lastView));
  }

  // ---- shade at a time ---------------------------------------------------------------
  var busy = false, again = false;
  function utcNow() { return S.hobartToUTC(dateStr(), minutes()); }
  function showSun(p) {
    lastSun = p;
    $("clock").textContent = S.fmtClock(minutes());
    var lat = st ? st.lat : map.getCenter().lat, lon = st ? st.lon : map.getCenter().lng;
    p = p || S.sunPosition(utcNow(), lat, lon);
    var rs = riseSet(dateStr(), lat, lon);
    $("sun").innerHTML = "Sun " + p.az.toFixed(0) + " deg (true), " + p.elev.toFixed(1) + " deg up. " +
      "Flat-horizon sunrise " + rs[0] + ", sunset " + rs[1] + " (" + rs[2] + ").";
  }
  function riseSet(d, lat, lon) {
    var rise = null, set = null, prev = null, noon = { elev: -99 };
    for (var m = 0; m <= 1440; m += 2) {
      var p = S.sunPosition(S.hobartToUTC(d, m), lat, lon), up = p.elev > -0.833 + 0.6;   // ~upper limb, refraction already in elev
      if (prev !== null && up && !prev) rise = m;
      if (prev !== null && !up && prev) set = m;
      if (p.elev > noon.elev) { noon = p; noon.m = m; }
      prev = up;
    }
    var off = S.hobartOffset(S.hobartToUTC(d, 720));
    return [rise === null ? "-" : S.fmtClock(rise), set === null ? "-" : S.fmtClock(set),
            "noon " + S.fmtClock(noon.m) + " at " + noon.elev.toFixed(1) + " deg, UTC+" + (off / 60)];
  }
  function refresh() {
    showSun();
    if (!st) return;
    if (mode() !== "shade") { draw(); return; }
    if (busy) { again = true; return; }
    busy = true;
    ask({ type: "shade", t: utcNow() }).then(function (m) {
      busy = false; lastShade = m.shade; showSun(m.sun); draw();
      if (again) { again = false; refresh(); }
    });
    if (probeAt) drawProbe();
  }

  // ---- hours of sun for the day -----------------------------------------------------
  var hoursJob = null;
  function calcHours() {
    if (!st) return;
    if (hoursJob) { worker.postMessage({ type: "cancel", which: hoursJob }); hoursJob = null; $("calchours").textContent = "Calculate hours of sun for the day"; return; }
    var d = dateStr(), t0 = performance.now();
    $("calchours").textContent = "Cancel";
    var p = ask({ type: "sunhours", date: d, stepMin: +$("step").value }, null, function (f) {
      status("Calculating hours of sun for " + d + ": " + Math.round(100 * f) + "%");
    });
    hoursJob = nextId - 1;
    p.then(function (m) {
      hoursJob = null; $("calchours").textContent = "Calculate hours of sun for the day";
      if (m.type !== "sunhours") { status("Cancelled."); return; }
      hours = { hours: m.hours, daylight: m.daylight, date: d };
      var mn = Infinity, mx = 0, sum = 0;
      for (var i = 0; i < m.hours.length; i++) { var v = m.hours[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
      status("Hours of direct sun on " + d + ": " + mn.toFixed(1) + " to " + mx.toFixed(1) + " h (mean " +
        (sum / m.hours.length).toFixed(1) + " h) of " + m.daylight.toFixed(1) + " h of daylight; " +
        ((performance.now() - t0) / 1000).toFixed(1) + " s.");
      draw();
    });
  }

  // ---- probe: skyline and sun path at a point -----------------------------------------
  var probeAt = null, probeHz = null;
  map.on("click", function (e) { probe(e.latlng); });
  function probe(latlng) {
    if (!st) return;
    var q = proj4("EPSG:4326", MGA94, [latlng.lng, latlng.lat]), tg = st.tg;
    var col = Math.floor((q[0] - tg.x0) / tg.cell), row = Math.floor((tg.ytop - q[1]) / tg.cell);
    if (col < 0 || row < 0 || col >= tg.w || row >= tg.h) return;
    probeAt = { E: q[0], N: q[1], ll: latlng, z: st.tz[row * tg.w + col], k: row * tg.w + col };
    updateURL();
    if (probeMarker) probeMarker.setLatLng(latlng); else probeMarker = L.circleMarker(latlng, { radius: 6, color: "#e65100", weight: 2, fillOpacity: 0.3 }).addTo(map);
    $("probe").hidden = false; $("probe").innerHTML = "Tracing the skyline ...";
    if (mode() === "view") viewshed(q);
    ask({ type: "horizon", E: q[0], N: q[1], maxDist: FAR_RADIUS }).then(function (m) {
      if (m.none) { $("probe").innerHTML = "Outside the loaded terrain."; return; }
      probeHz = m.angles; drawProbe();
    });
  }
  // ---- viewshed from the tapped spot (js/osvm.js) ---------------------------------------
  var viewBusy = false, viewAgain = null;
  function viewshed(q) {
    if (viewBusy) { viewAgain = q; return; }
    viewBusy = true;
    var eye = +$("eye").value, range = +$("range").value;
    status("Working out what is visible from the spot (" + eye + " m eye, out to " + (range / 1000) + " km) ...");
    ask({ type: "viewshed", E: q[0], N: q[1], eye: eye, maxDist: range }).then(function (m) {
      viewBusy = false;
      if (m.none) status("Outside the loaded terrain.");
      else {
        lastView = m;
        var s = 0; for (var i = 0; i < m.cov.length; i++) s += m.cov[i];
        status("Viewshed: " + (100 * s / (4 * m.cov.length)).toFixed(1) + "% of the square is visible from " + eye + " m above the spot; " +
          (m.area / 1e6).toFixed(2) + " km2 visible out to " + (range / 1000) + " km. " + (m.nTri / 1e6).toFixed(2) + " M triangles, " +
          (m.nVisTri / 1e3).toFixed(0) + " k partly visible, in " + (m.ms / 1000).toFixed(1) + " s.");
        draw();
      }
      if (viewAgain) { var nq = viewAgain; viewAgain = null; viewshed(nq); }
    });
  }
  function sunDay(d, lat, lon, hz) {
    var pts = [], first = null, last = null, total = 0;
    for (var m = 0; m < 1440; m++) {
      var p = S.sunPosition(S.hobartToUTC(d, m + 0.5), lat, lon);
      if (p.elev > -1) pts.push([p.az, p.elev, m]);
      if (hz) {
        var a = p.az, i0 = Math.floor(a) % 360, f = a - Math.floor(a), hza = hz[i0] * (1 - f) + hz[(i0 + 1) % 360] * f;
        if (p.elev > Math.max(0, hza)) { if (first === null) first = m; last = m + 1; total++; }
      }
    }
    return { pts: pts, first: first, last: last, total: total };
  }
  function drawProbe() {
    if (!probeAt || !probeHz) return;
    var d = dateStr(), y = +d.slice(0, 4), lat = probeAt.ll.lat, lon = probeAt.ll.lng;
    var today = sunDay(d, lat, lon, probeHz), win = sunDay(y + "-06-21", lat, lon, probeHz), sum = sunDay(y + "-12-21", lat, lon, probeHz);
    var W = 340, H = 170, L0 = 26, R0 = 6, T0 = 6, B0 = 20, ymax = 80;
    var X = function (az) { var a = ((az + 180) % 360 + 360) % 360 - 180; return L0 + (W - L0 - R0) * (a + 180) / 360; };
    var Y = function (el) { return T0 + (H - T0 - B0) * (1 - Math.max(-2, el) / ymax); };
    var sky = "M" + X(-180) + "," + Y(0);
    for (var a = -180; a <= 180; a++) sky += "L" + X(a).toFixed(1) + "," + Y(probeHz[((a % 360) + 360) % 360]).toFixed(1);
    sky += "L" + X(180) + "," + Y(-2) + "L" + X(-180) + "," + Y(-2) + "Z";
    function path(sd) {
      var s = "", prevX = null;
      sd.pts.forEach(function (p) { var x = X(p[0]); s += (prevX === null || Math.abs(x - prevX) > 100 ? "M" : "L") + x.toFixed(1) + "," + Y(p[1]).toFixed(1); prevX = x; });
      return s;
    }
    var grid = "";
    [0, 20, 40, 60].forEach(function (e) { grid += "<line x1='" + L0 + "' x2='" + (W - R0) + "' y1='" + Y(e) + "' y2='" + Y(e) + "' stroke='#eee'/><text x='" + (L0 - 3) + "' y='" + (Y(e) + 4) + "' text-anchor='end'>" + e + "</text>"; });
    [["S", -180], ["W", -90], ["N", 0], ["E", 90], ["S", 180]].forEach(function (p) {
      grid += "<text x='" + X(p[1] === 180 ? 179.99 : p[1]) + "' y='" + (H - 6) + "' text-anchor='middle'>" + p[0] + "</text>"; });
    var cur = lastSun || S.sunPosition(utcNow(), lat, lon);
    var svg = "<svg viewBox='0 0 " + W + " " + H + "'><g font-size='10' fill='#666' font-family='system-ui,sans-serif'>" + grid + "</g>" +
      "<path d='" + path(sum) + "' fill='none' stroke='#f9a825' stroke-width='1' stroke-dasharray='3 3'/>" +
      "<path d='" + path(win) + "' fill='none' stroke='#1e88e5' stroke-width='1' stroke-dasharray='3 3'/>" +
      "<path d='" + path(today) + "' fill='none' stroke='#e65100' stroke-width='2'/>" +
      "<path d='" + sky + "' fill='#5d6b4f' fill-opacity='0.75' stroke='#3e4a33'/>" +
      (cur.elev > -2 ? "<circle cx='" + X(cur.az) + "' cy='" + Y(cur.elev) + "' r='5' fill='#ffd54f' stroke='#e65100'/>" : "") + "</svg>";
    var fmt = function (sd) { return sd.total ? S.fmtClock(sd.first) + " - " + S.fmtClock(sd.last) + ", " + Math.floor(sd.total / 60) + " h " + (sd.total % 60) + " min" : "no direct sun"; };
    $("probe").innerHTML = "<b>Skyline at " + probeAt.ll.lat.toFixed(5) + ", " + probeAt.ll.lng.toFixed(5) + "</b> (" + Math.round(probeAt.z) + " m)" + svg +
      "<div><span style='color:#e65100'>&#9644;</span> " + d + ": " + fmt(today) + "</div>" +
      "<div><span style='color:#1e88e5'>- -</span> Jun 21: " + fmt(win) + "</div>" +
      "<div><span style='color:#f9a825'>- -</span> Dec 21: " + fmt(sum) + "</div>" +
      "<div class='row'><button id='sharelink'>" + (navigator.share ? "Share" : "Copy") + " a link to this spot</button><span id='sharemsg' class='status'></span></div>" +
      "<div class='status'>Skyline traced " + (FAR_RADIUS / 1000) + " km out from 1.5 m above the ground, with earth curvature; terrain only.</div>";
  }

  // ---- GeoJSON snapshot of what is shown -------------------------------------------------
  // Grids are turned into dissolved polygons along cell edges (js/polygonize.js), in GDA94 /
  // MGA zone 55, then written as WGS84 lon/lat (RFC 7946). A feature for the area analysed is
  // included, so "no polygon" can be told apart from "not looked at".
  var DEM_CREDIT = "Tasmania 2 m DEM, Mineral Resources Tasmania / theLIST (CC BY 3.0 AU), via Source Cooperative";
  function lonlatRing(xy) {
    var out = [];
    for (var i = 0; i < xy.length; i += 2) {
      var ll = proj4(MGA94, "EPSG:4326", [xy[i], xy[i + 1]]);
      out.push([Math.round(ll[0] * 1e7) / 1e7, Math.round(ll[1] * 1e7) / 1e7]);
    }
    return out;
  }
  function multiPolygon(res) { return { type: "MultiPolygon", coordinates: res.polygons.map(function (p) { return p.map(lonlatRing); }) }; }
  function boxFeature(g, props) {
    var x1 = g.x0 + g.w * g.cell, y1 = g.ytop - g.h * g.cell;
    var ring = lonlatRing([g.x0, y1, x1, y1, x1, g.ytop, g.x0, g.ytop, g.x0, y1]);
    return { type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } };
  }
  function common(extra) {
    var o = { generator: "lunashade (https://github.com/mdsumner/lunashade)", created: new Date().toISOString(),
              elevation: DEM_CREDIT, terrain: "bare earth only: no trees or buildings",
              geometry_note: "cell edges of a GDA94 / MGA zone 55 grid, as WGS84 lon/lat" };
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  function saveJSON(fc, name) {
    var blob = new Blob([JSON.stringify(fc)], { type: "application/geo+json" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return blob.size;
  }
  function exportGeoJSON() {
    if (!st) return;
    var md = mode(), d = dateStr(), hhmm = S.fmtClock(minutes()), feats = [], P = window.LunaPoly, msg = $("exportmsg");
    var stamp = d + "-" + hhmm.replace(":", "");
    msg.textContent = " building ...";
    function finish(name) {
      var fc = { type: "FeatureCollection", features: feats }, size = saveJSON(fc, name);
      msg.textContent = " " + name + " (" + (size > 1048576 ? (size / 1048576).toFixed(1) + " MB" : Math.round(size / 1024) + " KB") + ")";
    }
    function fail(e) { console.error(e); msg.textContent = " could not export: " + (e && e.message ? e.message : e); }
    setTimeout(function () {
      try {
        if (md === "shade" && lastShade) {
          var sun = lastSun || S.sunPosition(utcNow(), st.lat, st.lon);
          feats.push(boxFeature(st.tg, common({ product: "area analysed", cell_m: st.tg.cell })));
          feats.push({ type: "Feature", geometry: multiPolygon(P.polygonize(lastShade, st.tg)),
            properties: common({ product: "terrain shadow", date: d, time_local: hhmm, timezone: "Australia/Hobart",
              sun_azimuth_deg: +sun.az.toFixed(2), sun_elevation_deg: +sun.elev.toFixed(2), cell_m: st.tg.cell }) });
          finish("lunashade-shade-" + stamp + ".geojson");
        } else if (md === "hours" && hours) {
          var hv = hours.hours, lab = new Uint8Array(hv.length), top = 0;
          for (var i = 0; i < hv.length; i++) { lab[i] = Math.min(23, Math.floor(hv[i] + 1e-6)); if (lab[i] > top) top = lab[i]; }
          feats.push(boxFeature(st.tg, common({ product: "area analysed", cell_m: st.tg.cell })));
          P.polygonizeClasses(lab, st.tg, top + 1).forEach(function (res, k) {
            if (!res.polygons.length) return;
            feats.push({ type: "Feature", geometry: multiPolygon(res), properties: common({ product: "hours of direct sun", date: hours.date,
              timezone: "Australia/Hobart", hours_from: k, hours_to: k + 1, daylight_hours: +hours.daylight.toFixed(2), cell_m: st.tg.cell }) });
          });
          finish("lunashade-sunhours-" + hours.date + ".geojson");
        } else if (md === "view" && lastView && probeAt) {
          ask({ type: "viewexport" }).then(function (m) {
            try {
              if (m.none) throw new Error("no viewshed to export");
              var eye = +$("eye").value, range = +$("range").value, mask, k;
              var base = { observer_lon: +probeAt.ll.lng.toFixed(6), observer_lat: +probeAt.ll.lat.toFixed(6),
                           eye_height_m: eye, max_distance_m: range, earth_curvature: "included (refraction k = 0.13)" };
              feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [base.observer_lon, base.observer_lat] },
                           properties: common(Object.assign({ product: "observer", ground_m: Math.round(probeAt.z * 10) / 10 }, base)) });
              mask = new Uint8Array(m.near.length); for (k = 0; k < mask.length; k++) mask[k] = m.near[k] >= 2 ? 1 : 0;
              feats.push({ type: "Feature", geometry: multiPolygon(P.polygonize(mask, st.near)),
                           properties: common(Object.assign({ product: "visible ground", part: "near", cell_m: st.near.cell }, base)) });
              mask = new Uint8Array(m.far.length); for (k = 0; k < mask.length; k++) mask[k] = m.far[k] >= 2 ? 1 : 0;
              feats.push({ type: "Feature", geometry: multiPolygon(P.polygonize(mask, st.far)),
                           properties: common(Object.assign({ product: "visible ground", part: "far", cell_m: st.far.cell }, base)) });
              feats.push(boxFeature(st.near, common({ product: "area analysed", part: "near", cell_m: st.near.cell })));
              finish("lunashade-viewshed-" + probeAt.ll.lat.toFixed(5) + "_" + probeAt.ll.lng.toFixed(5) + "-" + eye + "m.geojson");
            } catch (e) { fail(e); }
          });
        } else msg.textContent = " nothing to export in this mode yet";
      } catch (e) { fail(e); }
    }, 20);
  }
  $("export").onclick = exportGeoJSON;

  function shareSpot() {
    var url = location.href, msg = $("sharemsg");
    if (navigator.share) { navigator.share({ title: "lunashade: sun at this spot", url: url }).catch(function () {}); return; }
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () {
      msg.textContent = " copied";
    }).catch(function () { window.prompt("Copy this link:", url); });
  }
  document.addEventListener("click", function (e) { if (e.target && e.target.id === "sharelink") shareSpot(); });

  // ---- controls ------------------------------------------------------------------
  function updateURL() {
    var p = new URLSearchParams();
    if (Q.get("dem")) p.set("dem", Q.get("dem"));
    if (st) { p.set("at", st.lat.toFixed(5) + "," + st.lon.toFixed(5)); p.set("detail", st.detail); }
    p.set("date", dateStr()); p.set("time", String(minutes()));
    if (mode() !== "shade") p.set("mode", mode());
    if (mode() === "view") p.set("eye", $("eye").value);
    if (probeAt) p.set("probe", probeAt.ll.lat.toFixed(6) + "," + probeAt.ll.lng.toFixed(6));
    var c = map.getCenter();
    history.replaceState(null, "", location.pathname + "?" + p.toString().replace(/%2C/g, ",") +
      "#" + c.lat.toFixed(5) + "/" + c.lng.toFixed(5) + "/" + map.getZoom());
  }
  var loadAt = startAt, probeNext = startProbe;
  $("load").onclick = load;
  $("detail").onchange = updatePreview;
  $("time").oninput = function () { refresh(); updateURL(); };
  $("date").onchange = function () { hours = null; refresh(); drawProbe(); updateURL(); };
  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (b) {
    b.onclick = function () { $("date").value = dateStr().slice(0, 4) + "-" + b.dataset.d; hours = null; refresh(); drawProbe(); updateURL(); };
  });
  Array.prototype.forEach.call(document.querySelectorAll("input[name=mode]"), function (r) {
    r.onchange = function () {
      $("hoursrow").hidden = mode() !== "hours"; $("viewrow").hidden = mode() !== "view";
      if (mode() === "view" && probeAt && !lastView) viewshed([probeAt.E, probeAt.N]);
      refresh(); updateURL();
    };
  });
  $("calchours").onclick = calcHours;
  $("opacity").oninput = function () { if (overlay) overlay.setOpacity(+$("opacity").value); };
  $("collapse").onclick = function () { var p = $("panel"); p.classList.toggle("collapsed"); $("collapse").textContent = p.classList.contains("collapsed") ? "+" : "-"; updatePreview(); };
  var playTimer = null;
  $("play").onclick = function () {
    if (playTimer) { clearInterval(playTimer); playTimer = null; $("play").textContent = "Play"; return; }
    $("play").textContent = "Stop";
    playTimer = setInterval(function () {
      var t = minutes() + 10; if (t > 1320) t = 240; $("time").value = t; refresh(); updateURL();
    }, 250);
  };
  if (Q.get("detail")) $("detail").value = Q.get("detail");
  if (Q.get("mode") === "hours") { document.querySelector("input[name=mode][value=hours]").checked = true; $("hoursrow").hidden = false; }
  if (Q.get("mode") === "view") { document.querySelector("input[name=mode][value=view]").checked = true; $("viewrow").hidden = false; }
  if (Q.get("eye")) $("eye").value = Q.get("eye");
  function reView() { lastView = null; if (probeAt && mode() === "view") viewshed([probeAt.E, probeAt.N]); else draw(); updateURL(); }
  $("eye").onchange = reView; $("range").onchange = reView;
  showSun(); updatePreview();
  if (Q.get("load") || startAt || startProbe) load();
  window.lunashade = { map: map, state: function () { return st; }, load: load, calcHours: calcHours };
})();
