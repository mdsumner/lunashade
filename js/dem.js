// lunashade - dem.js: read north-up MGA zone 55 grids from the Tasmania 2 m DEM, a
// single cloud-optimised GeoTIFF, with geotiff.js (after lunamap's js/profile.js).
// Shared by the main page and the Hobart vignette. Classic script: LunaDEM(url) returns
// { openDEM, readMGA, netMark, netSince }. Counts the range requests geotiff.js makes for
// the DEM (and their bytes), to see what a load costs.
// ---------------------------------------------------------------------------
(function (root) {
  function LunaDEM(DEM_URL) {
    // count the requests geotiff.js makes for the DEM (and their bytes), to see what a load costs
    var net = { n: 0, bytes: 0 }, realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.split("?")[0] !== DEM_URL.split("?")[0]) return realFetch(input, init);
      net.n++;
      var hd = init && init.headers, rg = hd ? (typeof hd.get === "function" ? hd.get("Range") : (hd.Range || hd.range)) : null;
      var m = rg && /bytes=(\d+)-(\d+)/.exec(rg);
      return realFetch(input, init).then(function (resp) {
        var cl = +resp.headers.get("content-length");
        net.bytes += cl > 0 ? cl : (m ? +m[2] - +m[1] + 1 : 0);
        return resp;
      });
    };
    function netMark() { return { n: net.n, bytes: net.bytes, t: performance.now() }; }
    function netSince(a) {
      var b = netMark(), kb = (b.bytes - a.bytes) / 1024;
      return (b.n - a.n) + " req, " + (kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB") + ", " + ((b.t - a.t) / 1000).toFixed(1) + " s";
    }
    var demPromise = null;
    function openDEM() {
      if (!demPromise) demPromise = GeoTIFF.fromUrl(DEM_URL, { allowFullFile: false }).then(function (tiff) {
        return Promise.all([tiff.getImageCount(), tiff.getImage(0)]).then(function (r) {
          var img0 = r[1], o = img0.getOrigin(), res = img0.getResolution(), nd = img0.getGDALNoData();
          return { tiff: tiff, count: r[0], W: img0.getWidth(), H: img0.getHeight(), x0: o[0], y0: o[1],
                   dx: res[0], dy: -res[1], nodata: nd, levels: {} };
        });
      }).catch(function (e) { demPromise = null; throw e; });
      return demPromise;
    }
    function demLevel(dem, k) {
      if (!dem.levels[k]) dem.levels[k] = dem.tiff.getImage(k).then(function (img) {
        return { img: img, w: img.getWidth(), h: img.getHeight(), sx: dem.W / img.getWidth() };
      });
      return dem.levels[k];
    }
    // a north-up grid over bbox [xmin, ymin, xmax, ymax] (MGA94 z55) at about `cell` metres:
    // the coarsest overview not coarser than cell, block-averaged further if needed.
    // Sea, no-data and outside the DEM are 0 m.
    function readMGA(bbox, cell) {
      return openDEM().then(function (dem) {
        var k = 0;
        while (k + 1 < dem.count && dem.dx * Math.pow(2, k + 1) <= cell * 1.001) k++;
        return demLevel(dem, k).then(function (lv) {
          var lc = dem.dx * lv.sx, f = Math.max(1, Math.round(cell / lc)), oc = lc * f;
          var c0 = Math.floor((bbox[0] - dem.x0) / oc), c1 = Math.ceil((bbox[2] - dem.x0) / oc);
          var r0 = Math.floor((dem.y0 - bbox[3]) / oc), r1 = Math.ceil((dem.y0 - bbox[1]) / oc);
          var w = c1 - c0, h = r1 - r0, z = new Float32Array(w * h);
          var g = { z: z, w: w, h: h, cell: oc, x0: dem.x0 + c0 * oc, ytop: dem.y0 - r0 * oc, level: k, block: f };
          var wc0 = Math.max(0, c0 * f), wc1 = Math.min(lv.w, c1 * f), wr0 = Math.max(0, r0 * f), wr1 = Math.min(lv.h, r1 * f);
          if (wc1 <= wc0 || wr1 <= wr0) return g;
          if ((wc1 - wc0) * (wr1 - wr0) > 40e6) throw new Error("the DEM has no overview coarse enough for a " + Math.round(cell) + " m read");
          return lv.img.readRasters({ window: [wc0, wr0, wc1, wr1], samples: [0], interleave: false }).then(function (r) {
            var band = r[0], ww = wc1 - wc0, wh = wr1 - wr0, nd = dem.nodata;
            function val(v) { return (v !== v || v < -1000 || v > 10000 || (nd !== null && v === nd)) ? 0 : v; }
            if (f === 1) {
              for (var y = 0; y < wh; y++) for (var x = 0; x < ww; x++)
                z[(wr0 - r0 + y) * w + (wc0 - c0 + x)] = val(band[y * ww + x]);
            } else {
              var cnt = new Uint16Array(w * h);
              for (var y2 = 0; y2 < wh; y2++) {
                var oy = Math.floor((wr0 + y2) / f) - r0;
                for (var x2 = 0; x2 < ww; x2++) {
                  var o = oy * w + Math.floor((wc0 + x2) / f) - c0;
                  z[o] += val(band[y2 * ww + x2]); cnt[o]++;
                }
              }
              for (var i = 0; i < z.length; i++) if (cnt[i]) z[i] /= cnt[i];
            }
            return g;
          });
        });
      });
    }
    return { url: DEM_URL, openDEM: openDEM, readMGA: readMGA, netMark: netMark, netSince: netSince };
  }
  root.LunaDEM = LunaDEM;
})(window);
