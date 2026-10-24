// lunashade - align.js: when does the sun pass behind a peak, as seen from a spot?
// Pure geometry, no DEM: the peak's position and height, the observer's position and
// eye height, and the sun (js/sun.js). Used by the Hobart vignette; also exports for node.
//
// From the observer the peak sits at a true azimuth A and an apparent elevation h
// (straight line of sight, lowered by earth curvature and raised by standard terrestrial
// refraction, k = 0.13). The sun's centre is at that same point in the sky when its
// declination is
//     sin(dec) = sin(lat) sin(h0) + cos(lat) cos(h0) cos(A)
// with h0 the sun's true (unrefracted) elevation for apparent elevation h. Declination
// changes slowly through the year, so that fixes the date (two dates a year, either side
// of a solstice, or none if the sun never goes that far north or south). The time on the
// date comes from the hour angle. Grids are MGA zone 55 metres; theta is the grid azimuth
// of true north at the observer (meridian convergence), so true az = grid az - theta.
// ---------------------------------------------------------------------------
(function (root) {
  var RAD = Math.PI / 180, R_EFF = 6371000 / (1 - 0.13);

  // apparent elevation (deg) of a target dz metres higher at d metres
  function apparentElevation(dz, d) { return Math.atan((dz - d * d / (2 * R_EFF)) / d) / RAD; }
  // atmospheric refraction (deg) for an apparent elevation (Bennett 1982)
  function refractionApparent(ha) { return ha < -1 ? 0 : 1 / Math.tan((ha + 7.31 / (ha + 4.4)) * RAD) / 60; }

  // geometry of the peak from the observer
  function sightline(obs, peak, theta) {
    var dE = peak.E - obs.E, dN = peak.N - obs.N, d = Math.sqrt(dE * dE + dN * dN);
    var azGrid = Math.atan2(dE, dN) / RAD, az = ((azGrid - (theta || 0)) % 360 + 360) % 360;
    var h = apparentElevation(peak.z - (obs.z + (obs.eye === undefined ? 1.6 : obs.eye)), d);
    return { d: d, az: az, h: h };
  }
  // declination (deg) at which the sun's centre passes through apparent (az, h) at latitude lat
  function declinationFor(lat, az, h) {
    var h0 = (h - refractionApparent(h)) * RAD, p = lat * RAD, A = az * RAD;
    var s = Math.sin(p) * Math.sin(h0) + Math.cos(p) * Math.cos(h0) * Math.cos(A);
    return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
  }

  // A calendar: the sun's declination each evening from a start date, for turning a
  // declination into dates. days: number of days; at: local minutes for the sample.
  function calendar(S, startDate, days, lat, lon, at) {
    var out = [], t0 = S.hobartToUTC(startDate, at || 1170);
    for (var i = 0; i < days; i++) {
      var t = t0 + i * 86400000;
      out.push({ date: S.hobartDateString(t), decl: S.sunPosition(t, lat, lon).decl });
    }
    return out;
  }
  // fractional day indexes where the calendar's declination crosses dec (each crossing)
  function crossings(cal, dec) {
    var out = [];
    for (var i = 0; i + 1 < cal.length; i++) {
      var a = cal[i].decl - dec, b = cal[i + 1].decl - dec;
      if (a === 0) out.push(i);
      else if (a * b < 0) out.push(i + a / (a - b));
    }
    return out;
  }
  // On a given local date, the evening time (local minutes) when the sun's azimuth is az,
  // and the sun's apparent elevation then; null if the sun never reaches az that evening.
  function timeAtAzimuth(S, date, lat, lon, az) {
    function f(m) { var p = S.sunPosition(S.hobartToUTC(date, m), lat, lon); return { p: p, g: ((p.az - az + 540) % 360) - 180 }; }
    // afternoon in the southern hemisphere: azimuth falls from north through west
    var lo = 720, hi = 1380, a = f(lo), b = f(hi);
    if (!(a.g > 0 && b.g < 0)) return null;
    for (var k = 0; k < 40; k++) {
      var m = (lo + hi) / 2, c = f(m);
      if (c.g > 0) lo = m; else hi = m;
    }
    var r = f((lo + hi) / 2);
    return { minute: (lo + hi) / 2, elev: r.p.elev, az: r.p.az };
  }
  // Everything for one observer: the sightline, and each date in the calendar when the
  // sun's centre passes within `within` degrees of the peak (default: the sun's radius).
  function alignment(S, cal, obs, peak, opts) {
    opts = opts || {};
    var sl = sightline(obs, peak, opts.theta), dec = declinationFor(obs.lat, sl.az, sl.h);
    var res = { sight: sl, decl: dec, events: [] };
    if (sl.az < 180) return res;          // the peak is not in the western sky: no sunset alignment
    crossings(cal, dec).forEach(function (x) {
      var i = Math.round(x), best = null;
      for (var j = Math.max(0, i - 1); j <= Math.min(cal.length - 1, i + 1); j++) {
        var t = timeAtAzimuth(S, cal[j].date, obs.lat, obs.lon, sl.az);
        if (!t) continue;
        var miss = t.elev - sl.h;
        if (!best || Math.abs(miss) < Math.abs(best.miss)) best = { date: cal[j].date, minute: t.minute, elev: t.elev, miss: miss, x: x };
      }
      if (!best) return;
      // the run of dates when some part of the disk crosses the peak (sun radius 0.267 deg)
      var within = opts.within || 0.267, first = best.date, last = best.date, j0 = cal.map(function (c) { return c.date; }).indexOf(best.date);
      for (var dj = -1; dj >= -6; dj--) { var c = cal[j0 + dj]; if (!c) break; var t1 = timeAtAzimuth(S, c.date, obs.lat, obs.lon, sl.az); if (!t1 || Math.abs(t1.elev - sl.h) > within) break; first = c.date; }
      for (dj = 1; dj <= 6; dj++) { var c2 = cal[j0 + dj]; if (!c2) break; var t2 = timeAtAzimuth(S, c2.date, obs.lat, obs.lon, sl.az); if (!t2 || Math.abs(t2.elev - sl.h) > within) break; last = c2.date; }
      best.first = first; best.last = last;
      res.events.push(best);
    });
    return res;
  }

  var api = { sightline: sightline, declinationFor: declinationFor, calendar: calendar, crossings: crossings,
              timeAtAzimuth: timeAtAzimuth, alignment: alignment, apparentElevation: apparentElevation,
              refractionApparent: refractionApparent };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LunaAlign = api;
})(typeof self !== "undefined" ? self : this);
