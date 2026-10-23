// lunashade - sun.js: sun position (NOAA solar calculator equations) and
// Australia/Hobart local time helpers. Shared by the page, the worker and the
// node tests (classic script; also exports for node).
// ---------------------------------------------------------------------------
(function (root) {
  var RAD = Math.PI / 180;

  // Sun azimuth (degrees clockwise from true north) and elevation (degrees above
  // the flat horizon, with standard atmospheric refraction) at UTC time ms.
  function sunPosition(ms, lat, lon) {
    var jd = ms / 86400000 + 2440587.5, T = (jd - 2451545) / 36525;
    var L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    var M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    var e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    var Mr = M * RAD;
    var C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
            Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
    var omega = (125.04 - 1934.136 * T) * RAD;
    var lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
    var eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    var eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD;
    var decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
    var y = Math.pow(Math.tan(eps / 2), 2), L0r = L0 * RAD;
    var eot = 4 / RAD * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
              0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
    var utcMin = (((ms % 86400000) + 86400000) % 86400000) / 60000;
    var tst = utcMin + eot + 4 * lon;
    var ha = (tst / 4 - 180) * RAD, phi = lat * RAD;
    var cz = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
    cz = Math.max(-1, Math.min(1, cz));
    var elev = 90 - Math.acos(cz) / RAD;
    var az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / RAD + 180;
    if (elev > -1) {   // refraction (Bennett), degrees
      elev += 1.02 / Math.tan((elev + 10.3 / (elev + 5.11)) * RAD) / 60;
    }
    return { az: (az + 360) % 360, elev: elev, decl: decl / RAD };
  }

  // UTC offset (minutes) of Australia/Hobart at UTC time ms, via Intl
  var fmt = null;
  function hobartOffset(ms) {
    try {
      if (!fmt) fmt = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Hobart", hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      var p = {}; fmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
      var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
      return Math.round((asUTC - Math.floor(ms / 60000) * 60000) / 60000);
    } catch (e) { return 600; }
  }
  // UTC ms for a Hobart local date ("YYYY-MM-DD") and minutes after local midnight
  function hobartToUTC(dateStr, minutes) {
    var d = dateStr.split("-").map(Number), base = Date.UTC(d[0], d[1] - 1, d[2], 0, 0) + minutes * 60000;
    var off = hobartOffset(base - 600 * 60000);
    var t = base - off * 60000, off2 = hobartOffset(t);
    return off2 === off ? t : base - off2 * 60000;
  }
  function hobartDateString(ms) {
    var t = new Date(ms + hobartOffset(ms) * 60000);
    return t.toISOString().slice(0, 10);
  }
  function fmtClock(minutes) {
    var m = Math.round(minutes), h = Math.floor(m / 60) % 24, mm = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  var api = { sunPosition: sunPosition, hobartOffset: hobartOffset, hobartToUTC: hobartToUTC,
              hobartDateString: hobartDateString, fmtClock: fmtClock };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LunaSun = api;
})(typeof self !== "undefined" ? self : this);
