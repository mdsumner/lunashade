// lunashade - polygonize.js: turn a north-up grid mask (or class labels) into
// dissolved polygons with holes, following cell edges. Used for the GeoJSON export.
// Classic script, no dependencies; also exports for node.
//
// Every boundary between an "in" cell and an "out" cell (or the grid edge) becomes a
// directed unit edge with the inside on its left, so outer rings run counter-clockwise
// and holes clockwise (map coordinates, north up), as RFC 7946 asks. Edges are linked
// into rings; where two cells touch only at a corner the walk turns left, so cells
// joined only diagonally become separate polygons (4-connectivity). Vertices are kept
// only where the direction changes. Holes are assigned to the smallest outer ring that
// contains them.
// ---------------------------------------------------------------------------
(function (root) {
  // directions: 0 E, 1 N, 2 W, 3 S (N is up the map, i.e. row index decreasing)
  var LEFT = [1, 2, 3, 0], RIGHT = [3, 0, 1, 2];

  // mask: Uint8Array-like (w*h), truthy = in. g: { w, h, cell, x0, ytop }.
  // Returns { polygons: [[outer, hole, ...], ...] } with rings as flat [x0, y0, x1, y1, ...]
  // closed (last = first), in the grid's map coordinates; or throws if maxVertices is exceeded.
  function polygonize(mask, g, opts) {
    opts = opts || {};
    var w = g.w, h = g.h, W = w + 1, maxV = opts.maxVertices || 3e6;
    var DV = [1, -W, -1, W];
    var out = new Uint8Array(W * (h + 1));        // bits: outgoing edge directions at each lattice vertex
    var nEdges = 0, r, c, i;
    for (r = 0; r < h; r++) for (c = 0; c < w; c++) {
      if (!mask[r * w + c]) continue;
      var tl = r * W + c;
      if (c === 0 || !mask[r * w + c - 1]) { out[tl] |= 8; nEdges++; }                    // left side, going S from TL
      if (r === h - 1 || !mask[(r + 1) * w + c]) { out[tl + W] |= 1; nEdges++; }          // bottom, going E from BL
      if (c === w - 1 || !mask[r * w + c + 1]) { out[tl + W + 1] |= 2; nEdges++; }        // right side, going N from BR
      if (r === 0 || !mask[(r - 1) * w + c]) { out[tl + 1] |= 4; nEdges++; }              // top, going W from TR
    }
    if (nEdges > maxV) throw new Error("too complex to export (" + nEdges + " edges)");
    function pick(v, d, extra) {      // next direction at v arriving in direction d: left, straight, right
      var cand = [LEFT[d], d, RIGHT[d]];
      for (var k = 0; k < 3; k++) if (out[v] & (1 << cand[k]) || cand[k] === extra) return cand[k];
      return -1;
    }
    var rings = [];
    for (var v0 = 0; v0 < out.length; v0++) {
      while (out[v0]) {
        var d0 = 0; while (!(out[v0] & (1 << d0))) d0++;
        var pts = [], v = v0, d = d0, prevD = -1, guard = 0;
        out[v] &= ~(1 << d);
        for (;;) {
          if (d !== prevD) { pts.push(v); prevD = d; }
          v += DV[d];
          var nd = pick(v, d, v === v0 ? d0 : -1);
          if (v === v0 && nd === d0) break;
          if (nd < 0) throw new Error("polygonize: open ring");     // cannot happen for a valid mask
          out[v] &= ~(1 << nd); d = nd;
          if (++guard > nEdges + 4) throw new Error("polygonize: runaway ring");
        }
        // the start vertex is a corner unless the ring arrives there going d0
        if (prevD === d0 && pts.length > 1) pts.shift();
        var xy = new Float64Array(2 * pts.length + 2), A = 0, xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
        for (i = 0; i < pts.length; i++) {
          var x = g.x0 + (pts[i] % W) * g.cell, y = g.ytop - Math.floor(pts[i] / W) * g.cell;
          xy[2 * i] = x; xy[2 * i + 1] = y;
          if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
        xy[2 * pts.length] = xy[0]; xy[2 * pts.length + 1] = xy[1];
        for (i = 0; i < pts.length; i++) A += xy[2 * i] * xy[2 * i + 3] - xy[2 * i + 2] * xy[2 * i + 1];
        rings.push({ xy: xy, area: A / 2, bb: [xmin, ymin, xmax, ymax] });
      }
    }
    var outers = rings.filter(function (q) { return q.area > 0; }), holes = rings.filter(function (q) { return q.area < 0; });
    var polys = outers.map(function (q) { return [q]; });
    holes.forEach(function (hq) {
      // a point just inside the hole: the midpoint of its first edge, nudged to its left (into the hole... which is
      // outside the polygon), so test the first vertex shifted by a quarter cell along the inward normal of the outer
      var px = (hq.xy[0] + hq.xy[2]) / 2, py = (hq.xy[1] + hq.xy[3]) / 2;
      var ex = hq.xy[2] - hq.xy[0], ey = hq.xy[3] - hq.xy[1], L = Math.hypot(ex, ey);
      px += -ey / L * g.cell * 0.25; py += ex / L * g.cell * 0.25;    // left of a CW hole edge = inside the polygon
      var best = -1, bestA = Infinity;
      for (var k = 0; k < outers.length; k++) {
        var o = outers[k];
        if (px < o.bb[0] || px > o.bb[2] || py < o.bb[1] || py > o.bb[3] || o.area >= bestA) continue;
        if (inRing(o.xy, px, py)) { best = k; bestA = o.area; }
      }
      if (best >= 0) polys[best].push(hq);
    });
    return { polygons: polys.map(function (p) { return p.map(function (q) { return q.xy; }); }), rings: rings.length };
  }
  function inRing(xy, x, y) {
    var inside = false, n = xy.length / 2 - 1;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var yi = xy[2 * i + 1], yj = xy[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < (xy[2 * j] - xy[2 * i]) * (y - yi) / (yj - yi) + xy[2 * i]) inside = !inside;
    }
    return inside;
  }
  // class labels (0 .. n-1, 255 = none) -> one polygonize result per class
  function polygonizeClasses(labels, g, n, opts) {
    var res = [], m = new Uint8Array(labels.length);
    for (var k = 0; k < n; k++) {
      var any = false;
      for (var i = 0; i < labels.length; i++) { m[i] = labels[i] === k ? 1 : 0; if (m[i]) any = true; }
      res.push(any ? polygonize(m, g, opts) : { polygons: [], rings: 0 });
    }
    return res;
  }

  var api = { polygonize: polygonize, polygonizeClasses: polygonizeClasses, inRing: inRing };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LunaPoly = api;
})(typeof self !== "undefined" ? self : this);
