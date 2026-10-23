// lunashade - osvm.js: a viewshed from a point as an object-space visibility map
// (OSVM). Instead of marching rays over cells, the terrain is a triangulation (TIN)
// and the answer is the exact visible part of every triangle, as polygons.
// Classic script, no dependencies; shared by the worker and the node tests.
//
// The method, in four ideas (see docs/viewshed.md for the long version):
//
// 1. Gnomonic wedges. Around the observer, split the view into 4 wedges of 90
//    degrees of azimuth (N, E, S, W). In each wedge use the central (gnomonic)
//    projection onto a vertical plane one unit ahead: u = right / forward,
//    v = up / forward. Straight 3D edges stay straight, so a projected triangle is
//    still a triangle; u is a monotone function of azimuth and, at fixed u, v is a
//    monotone function of elevation angle. Each wedge is cut into S narrow sectors
//    (equal steps in u) so the bookkeeping per sector stays small. All cuts are
//    vertical planes through the observer, so clipping is done in plan.
//
// 2. Front-to-back order. For a height field seen from above the ground, anything
//    that can hide a triangle lies nearer to the observer along the same plan ray.
//    On a regular grid of quads, the quads a ray from the observer crosses on the
//    way to quad Q have row and column offsets (from the observer's quad) no larger
//    than Q's, on the same side, so visiting quads in increasing Manhattan offset
//    |dcol| + |drow| is a valid front-to-back order, with no sort. Inside a quad,
//    the triangle on the observer's side of the diagonal goes first. (For a
//    Delaunay TIN the general version is Edelsbrunner's acyclicity theorem: sort by
//    power distance to the circumcircles; for a square grid that is this order.)
//
// 3. The horizon is an upper envelope. Because of (2), everything drawn so far
//    covers the image from the bottom up to a horizon v = E(u), a piecewise-linear
//    function per sector. A new triangle is visible exactly where it rises above E;
//    afterwards E becomes max(E, top edge of the triangle).
//
// 4. Back to the ground. The central projection from a triangle's plane to the
//    image plane is projective, so straight lines map to straight lines: each
//    visible piece in (u, v) maps back to a convex polygon on the triangle in plan.
//
// The code is in three layers: Horizon (the kernel: triangles in, in front-to-back order),
// sources that feed it (gridSource, meshSource) and orders (the Manhattan walk built into
// gridSource; orderTopo for any mesh). viewshed() and viewshedMesh() put them together.
//
// Grids are as in engine.js: north-up, z Float32Array w x h, row 0 at the top,
// square cells of `cell` metres, x0 / ytop the outer corner. TIN vertices are the
// cell centres; each quad of 4 neighbouring centres is split on the diagonal from
// top-left to bottom-right (see sampleTIN). Earth curvature (with refraction) is
// applied by lowering each vertex by d^2 / 2R before projection.
// ---------------------------------------------------------------------------
(function (root) {
  var RAD = Math.PI / 180, NEGV = -1e30;
  var R_EFF = 6371000 / (1 - 0.13);
  var TINY = 1e-13, NBIN = 16;

  // height on the TIN at (E, N), or null outside the vertex hull
  function sampleTIN(g, E, N) {
    var u = (E - g.x0) / g.cell - 0.5, v = (g.ytop - N) / g.cell - 0.5;
    if (u < 0 || v < 0 || u > g.w - 1 || v > g.h - 1) return null;
    var c = Math.min(g.w - 2, Math.floor(u)), r = Math.min(g.h - 2, Math.floor(v)), fx = u - c, fy = v - r, w = g.w, z = g.z;
    var tl = z[r * w + c], tr = z[r * w + c + 1], bl = z[(r + 1) * w + c], br = z[(r + 1) * w + c + 1];
    return fx >= fy ? tl + fx * (tr - tl) + fy * (br - tr) : tl + fy * (bl - tl) + fx * (br - bl);
  }

  // ---- sectors and their envelopes ---------------------------------------------------
  function makeSectors(S) {
    var sec = [];
    for (var wq = 0; wq < 4; wq++) {
      var a = wq * 90 * RAD, fx = Math.sin(a), fy = Math.cos(a), rx = Math.cos(a), ry = -Math.sin(a);
      for (var k = 0; k < S; k++) {
        var u0 = -1 + 2 * k / S, u1 = -1 + 2 * (k + 1) / S;
        sec.push({ fx: fx, fy: fy, rx: rx, ry: ry, u0: u0, u1: u1,
                   a0: wq * 90 + Math.atan(u0) / RAD, a1: wq * 90 + Math.atan(u1) / RAD,
                   eu: [u0, u1], ev: [NEGV, NEGV], bmin: new Float64Array(NBIN).fill(NEGV) });
      }
    }
    return sec;
  }
  function sectorOf(az, S) {          // az in [-45, 315)
    var wq = Math.min(3, Math.floor((az + 45) / 90)), u = Math.tan((az - wq * 90) * RAD);
    return wq * S + Math.max(0, Math.min(S - 1, Math.floor((u + 1) / 2 * S)));
  }
  function lowerBound(a, x) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  function upperBound(a, x) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
  function segVal(eu, ev, j, x) {     // value on envelope segment j (eu[j] < eu[j+1]) at x
    var a = ev[j], b = ev[j + 1];
    if (a <= NEGV || b <= NEGV) return NEGV;
    return a + (b - a) * (x - eu[j]) / (eu[j + 1] - eu[j]);
  }
  // envelope value just right of x (or at the right end, just left)
  function evalRight(sec, x) {
    var eu = sec.eu, j = upperBound(eu, x) - 1, n = eu.length;
    if (j >= n - 1) return sec.ev[n - 1];
    if (j < 0) j = 0;
    return segVal(eu, sec.ev, j, x);
  }

  // conservative lower bound of the envelope in NBIN equal bins of u per sector, for a
  // quick "entirely below the horizon" test before any clipping
  function updateBins(sec, umin, umax) {
    var w = (sec.u1 - sec.u0) / NBIN, b0 = Math.max(0, Math.floor((umin - sec.u0) / w)), b1 = Math.min(NBIN - 1, Math.floor((umax - sec.u0) / w));
    var eu = sec.eu, ev = sec.ev;
    for (var b = b0; b <= b1; b++) {
      var x0 = sec.u0 + b * w, x1 = x0 + w, j = Math.max(0, upperBound(eu, x0) - 1), mn = Infinity;
      if (j + 1 < eu.length) mn = segVal(eu, ev, j, x0);
      for (j = j + 1; j < eu.length && eu[j] <= x1; j++) if (ev[j] < mn) mn = ev[j];
      if (j < eu.length && j > 0) { var v1 = segVal(eu, ev, j - 1, x1); if (v1 < mn) mn = v1; }
      sec.bmin[b] = mn;
    }
  }
  function hiddenQuick(sec, umin, umax, vmax) {
    var w = (sec.u1 - sec.u0) / NBIN, b0 = Math.max(0, Math.floor((umin - sec.u0) / w)), b1 = Math.min(NBIN - 1, Math.floor((umax - sec.u0) / w));
    for (var b = b0; b <= b1; b++) if (!(vmax < sec.bmin[b])) return false;
    return true;
  }

  // ---- the per-polygon step: visible pieces, then raise the envelope ----------------------
  var bp = [], nu = [], nv = [], EDG = new Float64Array(64), CUT = new Float64Array(4);
  var PIE = { buf: new Float64Array(8 * 256), set8: function (k, a, b, c, d, e, f, g, h) {
    if (8 * k + 8 > this.buf.length) { var nb = new Float64Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    var o = 8 * k, B = this.buf; B[o] = a; B[o + 1] = b; B[o + 2] = c; B[o + 3] = d; B[o + 4] = e; B[o + 5] = f; B[o + 6] = g; B[o + 7] = h; } };
  function processPoly(sec, n, PU, PV, emit) {
    var i, umin = Infinity, umax = -Infinity, u0 = sec.u0, u1 = sec.u1;
    for (i = 0; i < n; i++) {
      if (PU[i] < u0) PU[i] = u0; else if (PU[i] > u1) PU[i] = u1;
      if (PU[i] < umin) umin = PU[i]; if (PU[i] > umax) umax = PU[i];
    }
    if (umax - umin < TINY) return;
    var eu = sec.eu, ev = sec.ev;
    // non-vertical edges, as (ua, va, ub, vb) with ua < ub
    var ne = 0;
    for (i = 0; i < n; i++) {
      var j = i + 1 === n ? 0 : i + 1, ua = PU[i], ub = PU[j];
      if (Math.abs(ub - ua) < TINY) continue;
      if (ua < ub) { EDG[4 * ne] = ua; EDG[4 * ne + 1] = PV[i]; EDG[4 * ne + 2] = ub; EDG[4 * ne + 3] = PV[j]; }
      else { EDG[4 * ne] = ub; EDG[4 * ne + 1] = PV[j]; EDG[4 * ne + 2] = ua; EDG[4 * ne + 3] = PV[i]; }
      ne++;
    }
    // breakpoints: polygon vertices and envelope vertices inside (umin, umax)
    bp.length = 0;
    for (i = 0; i < n; i++) bp.push(PU[i]);
    var lo = lowerBound(eu, umin), hi = upperBound(eu, umax);
    for (i = lo; i < hi; i++) if (eu[i] > umin && eu[i] < umax) bp.push(eu[i]);
    for (i = 1; i < bp.length; i++) { var x = bp[i], k0 = i - 1; while (k0 >= 0 && bp[k0] > x) { bp[k0 + 1] = bp[k0]; k0--; } bp[k0 + 1] = x; }
    nu.length = 0; nv.length = 0;
    var any = false, allFull = true, jE = Math.max(0, lo - 1), np = 0;
    var prev = bp[0];
    for (var q = 1; q < bp.length; q++) {
      var a = prev, b = bp[q];
      if (b - a < TINY) continue;
      prev = b;
      var m = 0.5 * (a + b);
      // the two polygon edges over (a, b)
      var La, Lb, Ua, Ub, got = 0, xa, xb, ya, yb;
      for (var e = 0; e < ne && got < 2; e++) {
        var e0 = EDG[4 * e], e2 = EDG[4 * e + 2];
        if (e0 <= m && e2 >= m) {
          var e1 = EDG[4 * e + 1], s = (EDG[4 * e + 3] - e1) / (e2 - e0);
          var va = e1 + s * (a - e0), vb = e1 + s * (b - e0);
          if (got === 0) { xa = va; xb = vb; } else { ya = va; yb = vb; }
          got++;
        }
      }
      if (got < 2) continue;
      if (xa + xb <= ya + yb) { La = xa; Lb = xb; Ua = ya; Ub = yb; } else { La = ya; Lb = yb; Ua = xa; Ub = xb; }
      // the envelope segment over (a, b)
      while (jE + 2 < eu.length && eu[jE + 1] <= m) jE++;
      while (jE + 1 < eu.length && eu[jE + 1] - eu[jE] < TINY && eu[jE + 1] <= m) jE++;
      var Ea, Eb;
      if (ev[jE] <= NEGV || ev[jE + 1] <= NEGV) { Ea = NEGV; Eb = NEGV; }
      else { Ea = segVal(eu, ev, jE, a); Eb = segVal(eu, ev, jE, b); }
      // split (a, b) where E crosses L or U: CUT holds 0, the crossings in order, 1
      var ncut = 1, xA = -1, xB = -1; CUT[0] = 0;
      if (Ea > NEGV) {
        var d0 = Ea - La, d1 = Eb - Lb; if (d0 * d1 < 0) xA = d0 / (d0 - d1);
        d0 = Ea - Ua; d1 = Eb - Ub; if (d0 * d1 < 0) xB = d0 / (d0 - d1);
        if (xA > 0 && xB > 0 && xB < xA) { var tx = xA; xA = xB; xB = tx; }
        if (xA > 0) CUT[ncut++] = xA;
        if (xB > 0) CUT[ncut++] = xB;
      }
      CUT[ncut++] = 1;
      for (var c = 0; c + 1 < ncut; c++) {
        var t0 = CUT[c], t1 = CUT[c + 1];
        if (t1 - t0 < 1e-12) continue;
        var s0 = a + (b - a) * t0, s1 = a + (b - a) * t1, tm = 0.5 * (t0 + t1);
        var L0 = La + (Lb - La) * t0, L1 = La + (Lb - La) * t1, U0 = Ua + (Ub - Ua) * t0, U1 = Ua + (Ub - Ua) * t1;
        var E0 = Ea <= NEGV ? NEGV : Ea + (Eb - Ea) * t0, E1 = Ea <= NEGV ? NEGV : Ea + (Eb - Ea) * t1;
        var Lm = La + (Lb - La) * tm, Um = Ua + (Ub - Ua) * tm, Em = Ea <= NEGV ? NEGV : Ea + (Eb - Ea) * tm;
        if (Em < Lm) { any = true; PIE.set8(np++, s0, L0, s1, L1, s1, U1, s0, U0); }
        else if (Em < Um) { any = true; allFull = false; PIE.set8(np++, s0, E0, s1, E1, s1, U1, s0, U0); }
        else allFull = false;
        if (Em < Um) { nu.push(s0, s1); nv.push(U0, U1); } else { nu.push(s0, s1); nv.push(E0, E1); }
      }
    }
    if (!any) return;
    if (allFull) emit(n, PU, PV);
    else for (i = 0; i < np; i++) emit(4, null, null, PIE.buf, 8 * i);
    // splice the new envelope over [umin, umax]
    var newU = [], newV = [];
    if (lo > 0) { newU.push(umin); newV.push(segVal(eu, ev, lo - 1, umin)); }
    for (i = 0; i < nu.length; i++) { newU.push(nu[i]); newV.push(nv[i]); }
    if (hi < eu.length) { newU.push(umax); newV.push(segVal(eu, ev, hi - 1, umax)); }
    // tidy: drop repeated points and interior collinear points
    var su = [], sv = [];
    for (i = 0; i < newU.length; i++) {
      var k = su.length;
      if (k && Math.abs(su[k - 1] - newU[i]) < TINY && Math.abs(sv[k - 1] - newV[i]) <= 1e-12 * (1 + Math.abs(newV[i]))) continue;
      if (k >= 2 && newU[i] - su[k - 1] > TINY && su[k - 1] - su[k - 2] > TINY && sv[k - 1] > NEGV && sv[k - 2] > NEGV && newV[i] > NEGV) {
        var pr = sv[k - 2] + (newV[i] - sv[k - 2]) * (su[k - 1] - su[k - 2]) / (newU[i] - su[k - 2]);
        if (Math.abs(pr - sv[k - 1]) <= 1e-12 * (1 + Math.abs(pr))) { su[k - 1] = newU[i]; sv[k - 1] = newV[i]; continue; }
      }
      su.push(newU[i]); sv.push(newV[i]);
    }
    if (su.length < 4096) {
      eu.splice.apply(eu, [lo, hi - lo].concat(su));
      ev.splice.apply(ev, [lo, hi - lo].concat(sv));
    } else {
      sec.eu = eu.slice(0, lo).concat(su, eu.slice(hi));
      sec.ev = ev.slice(0, lo).concat(sv, ev.slice(hi));
    }
    updateBins(sec, umin, umax);
  }

  // ---- clipping in plan ------------------------------------------------------------
  var CX = [new Float64Array(16), new Float64Array(16)], CY = [new Float64Array(16), new Float64Array(16)], CZ = [new Float64Array(16), new Float64Array(16)];
  function clip(src, n, A, B, Cc) {   // keep A x + B y + C >= 0; src buffer index -> other buffer
    var dst = 1 - src, ix = CX[src], iy = CY[src], iz = CZ[src], ox = CX[dst], oy = CY[dst], oz = CZ[dst], m = 0;
    for (var i = 0; i < n; i++) {
      var j = i + 1 === n ? 0 : i + 1;
      var di = A * ix[i] + B * iy[i] + Cc, dj = A * ix[j] + B * iy[j] + Cc;
      if (di >= 0) { ox[m] = ix[i]; oy[m] = iy[i]; oz[m] = iz[i]; m++; }
      if ((di >= 0) !== (dj >= 0)) {
        var t = di / (di - dj);
        ox[m] = ix[i] + t * (ix[j] - ix[i]); oy[m] = iy[i] + t * (iy[j] - iy[i]); oz[m] = iz[i] + t * (iz[j] - iz[i]); m++;
      }
    }
    return m;
  }

  // ---- the kernel: triangles in, front to back ---------------------------------------------
  // Horizon(zEye, opts): a viewshed under construction for an eye at plan (0, 0) and height
  // zEye. Feed triangles with tri() in a front-to-back order, plan coordinates relative to the
  // eye, heights absolute. The kernel does not care where the triangles come from: a grid
  // (gridSource), an explicit mesh (meshSource with orderTopo), or anything else that can
  // promise the order. opts: sectors (per 90 deg wedge, default 64), curvature (default true),
  // pieces (keep the visible polygons, default true), E, N (added back to piece coordinates).
  function Horizon(zEye, opts) {
    opts = opts || {};
    var S = opts.sectors || 64, curv = opts.curvature !== false, keep = opts.pieces !== false;
    var E0 = opts.E || 0, N0 = opts.N || 0, k2 = curv ? 1 / (2 * R_EFF) : 0;
    var sec = makeSectors(S), NS = 4 * S, eps = 1e-3;
    var xy = new Float64Array(1 << 17), nxy = 0, off = [0], tri = [], tagOf = [];
    var area = 0, nTri = 0, nVis = 0, nHid = 0, curTri = -1, curTag = 0, curSec = null, plA = 0, plB = 0, plC = 0, triVisible = false;
    var PU = new Float64Array(16), PV = new Float64Array(16), QX = new Float64Array(8), QY = new Float64Array(8);
    function back(u, v, k) {        // image point -> plan (relative), into QX/QY[k]
      var dx = curSec.fx + u * curSec.rx, dy = curSec.fy + u * curSec.ry, den = v - plA * dx - plB * dy;
      var t = Math.abs(den) < 1e-15 ? 0 : plC / den;
      if (!(t > 0) || t > 1e7) t = 0;
      QX[k] = t * dx; QY[k] = t * dy;
    }
    function emit(n, us, vs, quad, qo) {
      var k, a2 = 0;
      for (k = 0; k < n; k++) { if (quad) back(quad[qo + 2 * k], quad[qo + 2 * k + 1], k); else back(us[k], vs[k], k); }
      for (k = 0; k < n; k++) { var j = k + 1 === n ? 0 : k + 1; a2 += QX[k] * QY[j] - QX[j] * QY[k]; }
      var ar = Math.abs(a2) / 2;
      if (ar < 1e-6) return;
      area += ar; triVisible = true;
      if (!keep) return;
      if (nxy + 2 * n > xy.length) { var nb = new Float64Array(xy.length * 2); nb.set(xy); xy = nb; }
      for (k = 0; k < n; k++) { xy[nxy++] = QX[k] + E0; xy[nxy++] = QY[k] + N0; }
      off.push(nxy / 2); tri.push(curTri); tagOf.push(curTag);
    }
    // id: the caller's triangle id; tag: a small integer carried to the pieces (ring, source)
    function addTriangle(id, tag, ax, ay, za, bx, by, zb, cx, cy, zc) {
      nTri++; triVisible = false; curTri = id; curTag = tag;
      var az = za - zEye - (ax * ax + ay * ay) * k2, bz = zb - zEye - (bx * bx + by * by) * k2, cz = zc - zEye - (cx * cx + cy * cy) * k2;
      // plane z = A x + B y + C
      var ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (Math.abs(nz) < 1e-12) return;
      var A = -nx / nz, B = -ny / nz;
      plA = A; plB = B; plC = az - A * ax - B * ay;
      // which sectors: azimuth span of the vertices
      var s0, s1, all = false;
      var o1 = ax * by - ay * bx, o2 = bx * cy - by * cx, o3 = cx * ay - cy * ax;   // eye inside?
      if ((o1 >= 0 && o2 >= 0 && o3 >= 0) || (o1 <= 0 && o2 <= 0 && o3 <= 0)) all = true;
      else {
        var aa = Math.atan2(ax, ay) / RAD, ab = Math.atan2(bx, by) / RAD, ac = Math.atan2(cx, cy) / RAD;
        ab = aa + ((ab - aa + 540) % 360 - 180); ac = aa + ((ac - aa + 540) % 360 - 180);
        var amin = Math.min(aa, ab, ac), amax = Math.max(aa, ab, ac);
        while (amin < -45) { amin += 360; amax += 360; }
        while (amin >= 315) { amin -= 360; amax -= 360; }
        s0 = sectorOf(amin, S);
        s1 = amax >= 315 ? NS + sectorOf(amax - 360, S) : sectorOf(amax, S);
      }
      if (all) { s0 = 0; s1 = NS - 1; }
      if (!all && s0 === s1) {
        var sq = sec[s0 % NS], ta = sq.fx * ax + sq.fy * ay, tb = sq.fx * bx + sq.fy * by, tc = sq.fx * cx + sq.fy * cy;
        if (ta > eps && tb > eps && tc > eps) {
          var qa = (sq.rx * ax + sq.ry * ay) / ta, qb = (sq.rx * bx + sq.ry * by) / tb, qc = (sq.rx * cx + sq.ry * cy) / tc;
          if (hiddenQuick(sq, Math.min(qa, qb, qc), Math.max(qa, qb, qc), Math.max(az / ta, bz / tb, cz / tc))) { nHid++; return; }
        }
      }
      for (var si = s0; si <= s1; si++) {
        var sc = sec[si % NS]; curSec = sc;
        CX[0][0] = ax; CY[0][0] = ay; CZ[0][0] = az; CX[0][1] = bx; CY[0][1] = by; CZ[0][1] = bz; CX[0][2] = cx; CY[0][2] = cy; CZ[0][2] = cz;
        var n = clip(0, 3, sc.rx - sc.u0 * sc.fx, sc.ry - sc.u0 * sc.fy, 0);
        if (n < 3) continue;
        n = clip(1, n, sc.u1 * sc.fx - sc.rx, sc.u1 * sc.fy - sc.ry, 0);
        if (n < 3) continue;
        n = clip(0, n, sc.fx, sc.fy, -eps);
        if (n < 3) continue;
        var bx2 = CX[1], by2 = CY[1], bz2 = CZ[1];
        for (var k = 0; k < n; k++) {
          var t = sc.fx * bx2[k] + sc.fy * by2[k];
          PU[k] = (sc.rx * bx2[k] + sc.ry * by2[k]) / t; PV[k] = bz2[k] / t;
        }
        processPoly(sc, n, PU, PV, emit);
      }
      if (triVisible) nVis++;
    }
    // the horizon now, as elevation angle (deg) at whole azimuths clockwise from plan north
    function skyline() {
      var sky = new Float32Array(360);
      for (var az = 0; az < 360; az++) {
        var a2 = az >= 315 ? az - 360 : az, si2 = sectorOf(a2, S), sc2 = sec[si2], wq = Math.floor(si2 / S);
        var u = Math.tan((a2 - wq * 90) * RAD), v = evalRight(sc2, u);
        sky[az] = v <= NEGV ? -90 : Math.atan(v / Math.sqrt(1 + u * u)) / RAD;
      }
      return sky;
    }
    function result() {
      var nEnv = 0; for (var s2 = 0; s2 < NS; s2++) nEnv += sec[s2].eu.length;
      return { E: E0, N: N0, zEye: zEye, area: area, nTri: nTri, nVisTri: nVis, nQuickHidden: nHid, envelopePoints: nEnv,
               pieces: { xy: xy.subarray(0, nxy), off: Uint32Array.from(off), tri: Int32Array.from(tri), ring: Uint8Array.from(tagOf), n: tri.length },
               skyline: skyline() };
    }
    return { tri: addTriangle, skyline: skyline, result: result };
  }

  // ---- source: a grid, quads in increasing Manhattan offset ---------------------------------
  // Calls H.tri for every triangle of grid g (vertices at cell centres, quads split TL-BR) in
  // front-to-back order from the eye at (E0, N0). Triangle ids are quad * 2 + (0: TL,TR,BR;
  // 1: TL,BR,BL), quad = row * (w - 1) + col. opts: hole (a grid whose vertex hull is skipped:
  // the next-finer ring, already done), maxDist (m), tag.
  function gridSource(H, g, E0, N0, opts) {
    opts = opts || {};
    var w = g.w, h = g.h, z = g.z, cell = g.cell, inner = opts.hole || null, maxDist = opts.maxDist || Infinity, tag = opts.tag || 0;
    if (w < 2 || h < 2) return;
    var hx0, hx1, hy0, hy1;
    if (inner) { hx0 = inner.x0 + 0.5 * inner.cell; hx1 = inner.x0 + (inner.w - 0.5) * inner.cell;
                 hy1 = inner.ytop - 0.5 * inner.cell; hy0 = inner.ytop - (inner.h - 0.5) * inner.cell; }
    var pc = (E0 - g.x0) / cell - 0.5, pr = (g.ytop - N0) / cell - 0.5;
    var cp = Math.max(0, Math.min(w - 2, Math.floor(pc))), rp = Math.max(0, Math.min(h - 2, Math.floor(pr)));
    var K = Math.max(cp, w - 2 - cp) + Math.max(rp, h - 2 - rp), maxQ = maxDist / cell + 1;
    for (var kk = 0; kk <= K; kk++) {
      if (kk > maxQ * 1.4143 + 2) break;
      var dlo = Math.max(-kk, -cp), dhi = Math.min(kk, w - 2 - cp);
      for (var di = dlo; di <= dhi; di++) {
        var c = cp + di, rem = kk - Math.abs(di);
        for (var side = 0; side < (rem ? 2 : 1); side++) {
          var r = side ? rp + rem : rp - rem;
          if (r < 0 || r > h - 2) continue;
          var xl = g.x0 + (c + 0.5) * cell - E0, xr = xl + cell, yt = g.ytop - (r + 0.5) * cell - N0, yb = yt - cell;
          if (inner && xr + E0 >= hx0 && xl + E0 <= hx1 && yt + N0 >= hy0 && yb + N0 <= hy1) continue;
          if (maxDist < Infinity) {
            var mx = Math.max(0, Math.abs(xl + 0.5 * cell) - 0.5 * cell), my = Math.max(0, Math.abs(yt - 0.5 * cell) - 0.5 * cell);
            if (mx * mx + my * my > maxDist * maxDist) continue;
          }
          var i0 = r * w + c, ztl = z[i0], ztr = z[i0 + 1], zbl = z[i0 + w], zbr = z[i0 + w + 1];
          var qi = (r * (w - 1) + c) * 2;
          if ((pc - c) >= (pr - r)) {
            H.tri(qi, tag, xl, yt, ztl, xr, yt, ztr, xr, yb, zbr);
            H.tri(qi + 1, tag, xl, yt, ztl, xr, yb, zbr, xl, yb, zbl);
          } else {
            H.tri(qi + 1, tag, xl, yt, ztl, xr, yb, zbr, xl, yb, zbl);
            H.tri(qi, tag, xl, yt, ztl, xr, yt, ztr, xr, yb, zbr);
          }
        }
      }
    }
  }

  // ---- source: an explicit mesh -------------------------------------------------------------
  // mesh: { x, y, z (vertex arrays, absolute), tri (Uint32Array, 3 per triangle) }. Any
  // triangulation: grid, Delaunay, constrained Delaunay, adaptive.
  //
  // orderTopo(mesh, E0, N0): a front-to-back order from the eye. Along any plan ray from the
  // eye, the triangles crossed are neighbours across shared edges, each crossed from the side
  // facing the eye. So "the triangle on the eye's side of a shared edge goes first", over all
  // shared edges, is the whole in-front relation, and a topological sort of it is a valid
  // order. It works for any triangulation of a convex region (a plan ray must not leave the
  // mesh and come back). Delaunay meshes never have a cycle (Edelsbrunner); others can. Any
  // triangles caught in a cycle are appended nearest first and counted in `cycles`.
  function orderTopo(mesh, E0, N0) {
    var T = mesh.tri, nt = T.length / 3, nv = mesh.x.length, X = mesh.x, Y = mesh.y;
    var edge = new Map(), indeg = new Uint32Array(nt), adjStart, adj, i, k;
    var from = [], to = [];
    for (var t = 0; t < nt; t++) for (k = 0; k < 3; k++) {
      var a = T[3 * t + k], b = T[3 * t + (k + 1) % 3], key = a < b ? a * nv + b : b * nv + a, o = edge.get(key);
      if (o === undefined) { edge.set(key, t); continue; }
      edge.delete(key);
      // t and o share edge a-b: which one is on the eye's side?
      var opp = T[3 * t + (k + 2) % 3];
      var ex = X[b] - X[a], ey = Y[b] - Y[a];
      var se = ex * (N0 - Y[a]) - ey * (E0 - X[a]), st = ex * (Y[opp] - Y[a]) - ey * (X[opp] - X[a]);
      if (Math.abs(se) <= 1e-9 * (Math.abs(ex) + Math.abs(ey)) * (Math.abs(E0 - X[a]) + Math.abs(N0 - Y[a]) + 1)) continue;   // eye on the edge's line
      if ((se > 0) === (st > 0)) { from.push(t); to.push(o); } else { from.push(o); to.push(t); }
    }
    adjStart = new Uint32Array(nt + 1);
    for (i = 0; i < from.length; i++) { adjStart[from[i] + 1]++; indeg[to[i]]++; }
    for (i = 0; i < nt; i++) adjStart[i + 1] += adjStart[i];
    adj = new Uint32Array(from.length); var fill = adjStart.slice(0, nt);
    for (i = 0; i < from.length; i++) adj[fill[from[i]]++] = to[i];
    var order = new Uint32Array(nt), head = 0, tail = 0, done = new Uint8Array(nt);
    // start from the eye's triangle outwards (any order is valid; nearest-first keeps it tidy)
    var d2 = new Float64Array(nt), seeds = [];
    for (t = 0; t < nt; t++) {
      var cx = (X[T[3 * t]] + X[T[3 * t + 1]] + X[T[3 * t + 2]]) / 3 - E0, cy = (Y[T[3 * t]] + Y[T[3 * t + 1]] + Y[T[3 * t + 2]]) / 3 - N0;
      d2[t] = cx * cx + cy * cy;
      if (indeg[t] === 0) seeds.push(t);
    }
    seeds.sort(function (p, q) { return d2[p] - d2[q]; });
    for (i = 0; i < seeds.length; i++) { order[tail++] = seeds[i]; done[seeds[i]] = 1; }
    while (head < tail) {
      var u = order[head++];
      for (k = adjStart[u]; k < adjStart[u + 1]; k++) { var v = adj[k]; if (--indeg[v] === 0 && !done[v]) { done[v] = 1; order[tail++] = v; } }
    }
    var cycles = nt - tail;
    if (cycles) {
      var rest = [];
      for (t = 0; t < nt; t++) if (!done[t]) rest.push(t);
      rest.sort(function (p, q) { return d2[p] - d2[q]; });
      for (i = 0; i < rest.length; i++) order[tail++] = rest[i];
    }
    return { order: order, cycles: cycles, constraints: from.length };
  }
  function meshSource(H, mesh, order, E0, N0, opts) {
    opts = opts || {};
    var T = mesh.tri, X = mesh.x, Y = mesh.y, Z = mesh.z, tag = opts.tag || 0;
    for (var i = 0; i < order.length; i++) {
      var t = order[i], a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
      H.tri(t, tag, X[a] - E0, Y[a] - N0, Z[a], X[b] - E0, Y[b] - N0, Z[b], X[c] - E0, Y[c] - N0, Z[c]);
    }
  }
  // height on a mesh at (E, N) (linear scan), or null
  function sampleMesh(mesh, E, N) {
    var T = mesh.tri, X = mesh.x, Y = mesh.y, Z = mesh.z;
    for (var t = 0; t < T.length / 3; t++) {
      var a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
      var d = (Y[b] - Y[c]) * (X[a] - X[c]) + (X[c] - X[b]) * (Y[a] - Y[c]);
      var l1 = ((Y[b] - Y[c]) * (E - X[c]) + (X[c] - X[b]) * (N - Y[c])) / d, l2 = ((Y[c] - Y[a]) * (E - X[c]) + (X[a] - X[c]) * (N - Y[c])) / d, l3 = 1 - l1 - l2;
      if (l1 >= -1e-12 && l2 >= -1e-12 && l3 >= -1e-12) return l1 * Z[a] + l2 * Z[b] + l3 * Z[c];
    }
    return null;
  }

  // ---- the viewshed, composed --------------------------------------------------------------
  // viewshed(rings, E, N, opts): rings [near, far, ...] are grids, each finer and inside the
  // next; ring k > 0 skips quads touching ring k-1 (a plan ray leaves a convex ring once, so
  // everything in it is in front of everything outside). opts: eye (m above the ground,
  // default 1.5), maxDist (m), and the Horizon options.
  // Returns the Horizon result plus ms.
  function viewshed(rings, E0, N0, opts) {
    opts = opts || {};
    var eye = opts.eye === undefined ? 1.5 : opts.eye, zg = sampleTIN(rings[0], E0, N0);
    if (zg === null) return null;
    var t0 = Date.now(), H = Horizon(zg + eye, { sectors: opts.sectors, curvature: opts.curvature, pieces: opts.pieces, E: E0, N: N0 });
    for (var ri = 0; ri < rings.length; ri++) gridSource(H, rings[ri], E0, N0, { hole: ri > 0 ? rings[ri - 1] : null, maxDist: opts.maxDist, tag: ri });
    var res = H.result(); res.ms = Date.now() - t0;
    return res;
  }
  // viewshedMesh(mesh, E, N, opts): the same from an explicit mesh, ordered by orderTopo
  // unless opts.order is given. Adds `cycles` (triangles that had to be forced into order).
  function viewshedMesh(mesh, E0, N0, opts) {
    opts = opts || {};
    var eye = opts.eye === undefined ? 1.5 : opts.eye, zg = sampleMesh(mesh, E0, N0);
    if (zg === null) return null;
    var t0 = Date.now(), ord = opts.order ? { order: opts.order, cycles: 0 } : orderTopo(mesh, E0, N0);
    var t1 = Date.now(), H = Horizon(zg + eye, { sectors: opts.sectors, curvature: opts.curvature, pieces: opts.pieces, E: E0, N: N0 });
    meshSource(H, mesh, ord.order, E0, N0, { tag: opts.tag });
    var res = H.result(); res.ms = Date.now() - t0; res.msOrder = t1 - t0; res.cycles = ord.cycles;
    return res;
  }

  // Visible fraction of each cell of grid g, from the pieces of ring `ring`, sampled on an
  // ss x ss grid of points per cell: Uint8Array of counts 0 .. ss*ss.
  function coverage(res, g, ss, ring) {
    ss = ss || 2; ring = ring || 0;
    var out = new Uint8Array(g.w * g.h), P = res.pieces, xy = P.xy, cap = ss * ss, step = g.cell / ss;
    for (var p = 0; p < P.n; p++) {
      if (P.ring[p] !== ring) continue;
      var a = P.off[p], b = P.off[p + 1], n = b - a, i;
      var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, s2 = 0;
      for (i = a; i < b; i++) {
        var x = xy[2 * i], y = xy[2 * i + 1];
        if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        var j = i + 1 === b ? a : i + 1; s2 += x * xy[2 * j + 1] - xy[2 * j] * y;
      }
      var sgn = s2 >= 0 ? 1 : -1;
      // sample k along x: E = x0 + (k + 0.5) * step; along y: N = ytop - (m + 0.5) * step
      var k0 = Math.max(0, Math.ceil((xmin - g.x0) / step - 0.5)), k1 = Math.min(g.w * ss - 1, Math.floor((xmax - g.x0) / step - 0.5));
      var m0 = Math.max(0, Math.ceil((g.ytop - ymax) / step - 0.5)), m1 = Math.min(g.h * ss - 1, Math.floor((g.ytop - ymin) / step - 0.5));
      for (var m = m0; m <= m1; m++) {
        var Ny = g.ytop - (m + 0.5) * step;
        for (var k = k0; k <= k1; k++) {
          var Ex = g.x0 + (k + 0.5) * step, inside = true;
          for (i = a; i < b && inside; i++) {
            var j2 = i + 1 === b ? a : i + 1;
            var cr = (xy[2 * j2] - xy[2 * i]) * (Ny - xy[2 * i + 1]) - (xy[2 * j2 + 1] - xy[2 * i + 1]) * (Ex - xy[2 * i]);
            if (cr * sgn < -1e-9) inside = false;
          }
          if (inside) { var o = Math.floor(m / ss) * g.w + Math.floor(k / ss); if (out[o] < cap) out[o]++; }
        }
      }
    }
    return out;
  }

  var api = { viewshed: viewshed, viewshedMesh: viewshedMesh, Horizon: Horizon, gridSource: gridSource, meshSource: meshSource,
              orderTopo: orderTopo, sampleTIN: sampleTIN, sampleMesh: sampleMesh, coverage: coverage, R_EFF: R_EFF };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LunaOSVM = api;
})(typeof self !== "undefined" ? self : this);
