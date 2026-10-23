// lunashade - engine.js: cast shadows on a DEM for a sun position, by a single
// directional sweep (O(N) per sun position), with a far-field shadow surface
// carried in from a coarse DEM, and a horizon-angle probe for one point.
// Shared by the worker and the node tests (classic script; also exports for node).
//
// Grids are north-up in a projected CRS (here MGA zone 55): z is a Float32Array
// of w x h cells, row 0 at the top (north), square cells of size `cell` metres,
// x0 / ytop the outer corner of the top-left cell.
//
// The sweep. Light travels away from the sun. Visit the grid line by line along
// the light's direction (columns or rows, whichever the light crosses faster);
// each cell's upstream neighbour lies one line back, at a fractional offset. Keep
// H, the height of the "shadow surface": the lowest height a ray from the sun can
// pass at that cell without having touched terrain upstream. Moving one line
// downstream the surface drops by step * tan(elevation) (plus earth curvature);
// a cell is in shadow if the surface arriving at it is above the ground, and the
// surface leaving it is max(ground, arriving surface).
// ---------------------------------------------------------------------------
(function (root) {
  var RAD = Math.PI / 180, NEG = -1e9;
  var R_EFF = 6371000 / (1 - 0.13);   // earth radius with standard refraction (k = 0.13)

  // sweep(z, w, h, cell, azGrid, elev, opts) -> { shade: Uint8Array (1 = shadow), surf: Float32Array }
  // azGrid: sun azimuth clockwise from grid north (degrees); elev: degrees.
  // opts.hfar: Float32Array (w*h) of an incoming far-field shadow surface, or null.
  // opts.curvature: carry distance-from-caster and add the earth-curvature drop.
  // opts.arrive: if true, surf holds the arriving surface (upstream casters only),
  //              rather than the leaving one.
  function sweep(z, w, h, cell, azGrid, elev, opts) {
    opts = opts || {};
    var n = w * h, shade = opts.shade || new Uint8Array(n), H = new Float32Array(n);
    var arrive = opts.arrive ? new Float32Array(n) : null;
    var hfar = opts.hfar || null, curv = !!opts.curvature;
    var D = curv ? new Float32Array(n) : null;
    if (elev <= 0) { shade.fill(1); if (arrive) arrive.fill(1e9); return { shade: shade, surf: arrive || H }; }
    var A = azGrid * RAD;
    var px = -Math.sin(A), py = Math.cos(A);      // light direction in (col, row); rows run south
    var colMajor = Math.abs(px) >= Math.abs(py);
    var n1, n2, s1, d2, st1, st2;
    if (colMajor) { n1 = w; n2 = h; s1 = px > 0 ? 1 : -1; d2 = py / Math.abs(px); st1 = 1; st2 = w; }
    else          { n1 = h; n2 = w; s1 = py > 0 ? 1 : -1; d2 = px / Math.abs(py); st1 = w; st2 = 1; }
    var step = cell * Math.sqrt(1 + d2 * d2), drop = step * Math.tan(elev * RAD);
    var i1 = s1 > 0 ? 0 : n1 - 1, i2, k, idx, cand, zi;
    // first line: nothing upstream but the far field
    for (i2 = 0; i2 < n2; i2++) {
      idx = i1 * st1 + i2 * st2; zi = z[idx];
      cand = hfar ? hfar[idx] : NEG;
      if (arrive) arrive[idx] = cand;
      shade[idx] = cand > zi ? 1 : 0;
      H[idx] = cand > zi ? cand : zi;
      if (curv) D[idx] = 0;
    }
    // the fractional upstream offset is the same for every line: precompute
    var j0 = Math.floor(-d2), f = -d2 - j0;
    for (k = 1; k < n1; k++) {
      var prev = i1 * st1; i1 += s1; var cur = i1 * st1;
      for (i2 = 0; i2 < n2; i2++) {
        idx = cur + i2 * st2; zi = z[idx];
        var ja = i2 + j0, jb = ja + 1, hp, dp = 0;
        if (ja >= 0 && jb < n2) {
          var a = prev + ja * st2, b = prev + jb * st2;
          // take the higher of the two upstream surfaces where one is far lower (avoids
          // smearing a real surface into "no surface"); otherwise interpolate
          var ha = H[a], hb = H[b];
          if (ha < -1e8 || hb < -1e8) { hp = ha > hb ? ha : hb; if (curv) dp = ha > hb ? D[a] : D[b]; }
          else { hp = ha + f * (hb - ha); if (curv) dp = D[a] + f * (D[b] - D[a]); }
        } else if (ja === n2 - 1 && f < 1e-9) { hp = H[prev + ja * st2]; if (curv) dp = D[prev + ja * st2]; }
        else if (ja === -1 && jb === 0) { hp = H[prev]; if (curv) dp = D[prev]; }       // edge: clamp
        else if (ja === n2 - 1) { hp = H[prev + ja * st2]; if (curv) dp = D[prev + ja * st2]; }
        else hp = NEG;
        cand = hp - drop;
        var dn = 0;
        if (curv) { dn = dp + step; cand -= (dn * dn - dp * dp) / (2 * R_EFF); }
        if (hfar && hfar[idx] > cand) { cand = hfar[idx]; dn = 0; }
        if (arrive) arrive[idx] = cand;
        if (cand > zi) { shade[idx] = 1; H[idx] = cand; if (curv) D[idx] = dn; }
        else { shade[idx] = 0; H[idx] = zi; if (curv) D[idx] = 0; }
      }
    }
    return { shade: shade, surf: arrive || H };
  }

  // A two-level domain: near (fine, covers the area of interest plus a margin) and
  // far (coarse, wide). The far grid's cells inside the near domain do not cast
  // (the near grid casts there, at full detail); the far sweep's arriving surface
  // is interpolated onto the near grid as its incoming shadow surface.
  function Domain(near, far) {
    this.near = near; this.far = far;
    if (far) {
      var zc = new Float32Array(far.z), nx1 = near.x0 + near.w * near.cell, ny1 = near.ytop - near.h * near.cell;
      for (var r = 0; r < far.h; r++) {
        var N = far.ytop - (r + 0.5) * far.cell;
        if (N > near.ytop || N < ny1) continue;
        for (var c = 0; c < far.w; c++) {
          var E = far.x0 + (c + 0.5) * far.cell;
          if (E > near.x0 && E < nx1) zc[r * far.w + c] = NEG;
        }
      }
      this.zcast = zc;
      // separable bilinear tables: near columns -> far columns, near rows -> far rows
      this.cx = new Int32Array(near.w); this.cf = new Float32Array(near.w);
      this.rx = new Int32Array(near.h); this.rf = new Float32Array(near.h);
      for (var i = 0; i < near.w; i++) {
        var u = (near.x0 + (i + 0.5) * near.cell - far.x0) / far.cell - 0.5;
        u = Math.max(0, Math.min(far.w - 1.000001, u)); this.cx[i] = Math.floor(u); this.cf[i] = u - Math.floor(u);
      }
      for (var j = 0; j < near.h; j++) {
        var v = (far.ytop - (near.ytop - (j + 0.5) * near.cell)) / far.cell - 0.5;
        v = Math.max(0, Math.min(far.h - 1.000001, v)); this.rx[j] = Math.floor(v); this.rf[j] = v - Math.floor(v);
      }
      this.hfar = new Float32Array(near.w * near.h);
    }
    this.shade = new Uint8Array(near.w * near.h);
  }
  // shadow mask on the near grid for a sun position; theta = grid azimuth of true north
  Domain.prototype.shadeAt = function (az, elev, theta) {
    var near = this.near, far = this.far, azg = az + (theta || 0), hfar = null;
    if (far) {
      var fs = sweep(this.zcast, far.w, far.h, far.cell, azg, elev, { curvature: true, arrive: true }).surf;
      hfar = this.hfar;
      var W = far.w;
      for (var j = 0; j < near.h; j++) {
        var r0 = this.rx[j], fy = this.rf[j], o = j * near.w;
        for (var i = 0; i < near.w; i++) {
          var c0 = this.cx[i], fx = this.cf[i], p = r0 * W + c0;
          var a = fs[p], b = fs[p + 1], cc = fs[p + W], d = fs[p + W + 1];
          // any "no surface" corner: take the max (an edge of a far shadow is soft at this scale anyway)
          if (a < -1e8 || b < -1e8 || cc < -1e8 || d < -1e8) hfar[o + i] = Math.max(a, b, cc, d);
          else hfar[o + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
        }
      }
    }
    return sweep(near.z, near.w, near.h, near.cell, azg, elev, { hfar: hfar, shade: this.shade }).shade;
  };

  // Horizon elevation angle (degrees, curvature and refraction included) in nAz
  // directions from a point (E, N), searching the near grid then the far grid out
  // to maxDist metres. Azimuths are clockwise from grid north, starting at 0.
  function sampleGrid(g, E, N) {
    var u = (E - g.x0) / g.cell - 0.5, v = (g.ytop - N) / g.cell - 0.5;
    if (u < 0 || v < 0 || u > g.w - 1 || v > g.h - 1) return null;
    var c = Math.floor(u), r = Math.floor(v), fx = u - c, fy = v - r, w = g.w;
    var c1 = Math.min(c + 1, g.w - 1), r1 = Math.min(r + 1, g.h - 1);
    var z = g.z;
    return (z[r * w + c] * (1 - fx) + z[r * w + c1] * fx) * (1 - fy) + (z[r1 * w + c] * (1 - fx) + z[r1 * w + c1] * fx) * fy;
  }
  function horizon(near, far, E, N, nAz, maxDist, eyeHeight) {
    nAz = nAz || 360; maxDist = maxDist || 40000;
    var z0 = sampleGrid(near, E, N); if (z0 === null) return null;
    z0 += (eyeHeight || 1.5);
    var out = new Float32Array(nAz);
    for (var k = 0; k < nAz; k++) {
      var a = k * 2 * Math.PI / nAz, dx = Math.sin(a), dy = Math.cos(a), best = -90, t = 0;   // tangent of best
      var bestTan = -1e9;
      var d = near.cell;
      while (d < maxDist) {
        var E1 = E + dx * d, N1 = N + dy * d;
        var zz = sampleGrid(near, E1, N1), stepBase = near.cell;
        if (zz === null) { if (!far) break; zz = sampleGrid(far, E1, N1); stepBase = far.cell; if (zz === null) break; }
        var tn = (zz - z0 - d * d / (2 * R_EFF)) / d;
        if (tn > bestTan) bestTan = tn;
        d += Math.max(stepBase * 0.5, d * 0.004);
      }
      out[k] = Math.atan(bestTan) / RAD;
    }
    return { angles: out, z0: z0 - (eyeHeight || 1.5) };
  }

  var api = { sweep: sweep, Domain: Domain, horizon: horizon, sampleGrid: sampleGrid, NEG: NEG, R_EFF: R_EFF };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LunaEngine = api;
})(typeof self !== "undefined" ? self : this);
