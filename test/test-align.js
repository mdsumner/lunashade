// node test/test-align.js : the closed-form "sun behind the peak" dates in js/align.js
// against a brute-force search (every minute of every evening), from a few spots
// around Hobart. Coordinates are GDA94 / MGA zone 55, precomputed with proj4.
var S = require("../js/sun.js"), A = require("../js/align.js");
var RAD = Math.PI / 180;
var summit = { E: 519374.6, N: 5250705.2, z: 1271 };      // kunanyi summit, 42.896000 S 147.237306 E
var spots = [   // name, E, N, lat, lon, theta (grid azimuth of true north), ground m
  ["near Salamanca", 527028.2, 5251678.8, -42.8870, 147.3310, 0.2252, 5],
  ["Lindisfarne Bay", 529252.3, 5256222.7, -42.8460, 147.3580, 0.2434, 2],
  ["Bellerive", 530709.3, 5253107.0, -42.8740, 147.3760, 0.2558, 2]];
var cal = A.calendar(S, "2026-10-10", 150, -42.88, 147.3);
function sep(az1, el1, az2, el2) {
  var a = Math.sin(el1 * RAD) * Math.sin(el2 * RAD) + Math.cos(el1 * RAD) * Math.cos(el2 * RAD) * Math.cos((az1 - az2) * RAD);
  return Math.acos(Math.max(-1, Math.min(1, a))) / RAD;
}
var fails = 0;
spots.forEach(function (s) {
  var obs = { E: s[1], N: s[2], lat: s[3], lon: s[4], z: s[6], eye: 1.6 };
  var t0 = Date.now(), res = A.alignment(S, cal, obs, summit, { theta: s[5] }), ms = Date.now() - t0;
  var sl = res.sight;
  // brute force: closest approach of the sun's centre to the peak, each evening, to the minute
  var best = [];
  cal.forEach(function (c) {
    var mn = 99, at = 0;
    for (var m = 900; m < 1320; m++) {
      var p = S.sunPosition(S.hobartToUTC(c.date, m), obs.lat, obs.lon), d = sep(p.az, p.elev, sl.az, sl.h);
      if (d < mn) { mn = d; at = m; }
    }
    best.push({ date: c.date, sep: mn, minute: at });
  });
  var minima = best.filter(function (b, i) { return i > 0 && i < best.length - 1 && b.sep <= best[i - 1].sep && b.sep <= best[i + 1].sep && b.sep < 0.5; });
  console.log(s[0] + ": peak at az " + sl.az.toFixed(2) + ", elev " + sl.h.toFixed(2) + " deg, " + (sl.d / 1000).toFixed(2) + " km; decl " + res.decl.toFixed(2) + " (" + ms + " ms)");
  res.events.forEach(function (e) {
    console.log("   closed form: " + e.date + " " + S.fmtClock(e.minute) + ", centre passes " + e.miss.toFixed(3) + " deg from the peak; disk on it " + e.first + " to " + e.last);
  });
  minima.forEach(function (b) { console.log("   brute force: " + b.date + " " + S.fmtClock(b.minute) + ", closest " + b.sep.toFixed(3) + " deg"); });
  // every brute-force minimum must match an event on the same date, within 2 minutes
  minima.forEach(function (b) {
    var e = res.events.filter(function (e) { return e.date === b.date; })[0];
    if (!e || Math.abs(e.minute - b.minute) > 2) { console.log("   MISMATCH on " + b.date); fails++; }
  });
  if (minima.length !== res.events.length) { console.log("   MISMATCH in count"); fails++; }
  if (s[0] === "Lindisfarne Bay" && res.events.length) { console.log("   expected none: the summit is south of any sunset"); fails++; }
});
if (fails) { console.log(fails + " FAIL"); process.exit(1); } else console.log("all ok");
