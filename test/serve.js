// static server with Range support: node serve.js <root> <port>; /testdata/* from TESTDATA
const http = require("http"), fs = require("fs"), path = require("path");
const root = process.argv[2], port = +process.argv[3], td = process.env.TESTDATA;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".tif": "image/tiff", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png" };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  let f = p.startsWith("/testdata/") ? path.join(td, p.slice(10)) : path.join(root, p);
  if (f.endsWith("/")) f += "index.html";
  fs.stat(f, (e, s) => {
    if (e || !s.isFile()) { res.writeHead(404); return res.end(); }
    const h = { "Content-Type": types[path.extname(f)] || "application/octet-stream", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
    const r = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    if (r) { const a = +r[1], b = r[2] ? Math.min(+r[2], s.size - 1) : s.size - 1;
      res.writeHead(206, Object.assign(h, { "Content-Range": `bytes ${a}-${b}/${s.size}`, "Content-Length": b - a + 1 }));
      fs.createReadStream(f, { start: a, end: b }).pipe(res);
    } else { res.writeHead(200, Object.assign(h, { "Content-Length": s.size })); fs.createReadStream(f).pipe(res); }
  });
}).listen(port);
