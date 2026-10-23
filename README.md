# lunashade

Sun and shade from the terrain of Tasmania, computed in your browser from the Tasmania 2 m DEM.

**Live:** <https://mdsumner.github.io/lunashade/> - **Notes:** [docs/](docs/index.md) -
**lunamap fold-in:** [docs/lunamap.md](docs/lunamap.md)

Pan to a place, choose an area and detail (2 km at 2 m up to 16 km at 16 m), and load the terrain. Then:

- **Shade now**: terrain shadows for any date and time (Australia/Hobart time), with a play button.
- **Hours of sun**: hours of direct sun on each cell for the day.
- **Skyline**: tap a spot for its horizon traced 40 km out, the sun's path for the date and both
  solstices, and first and last direct sun to the minute.

Terrain only: the DEM is bare earth, so there are no trees or buildings. Prototype; not for safety-critical use.

## How

A static page (plain HTML, CSS and JavaScript, no build step) on GitHub Pages.

| Path | What |
|---|---|
| `index.html`, `app.css` | the page |
| `js/app.js` | map, DEM reads (geotiff.js, COG overviews), overlay drawing, skyline chart |
| `js/worker.js` | holds the terrain and runs the shading off the main thread |
| `js/engine.js` | the shadow sweep (O(N) per sun position), near/far domain, skyline probe |
| `js/sun.js` | sun position (NOAA equations) and Hobart local time |
| `test/test-engine.js` | `node test/test-engine.js`: sweep vs brute force, near/far vs one fine grid, timing |
| `test/make_synth.py`, `test/serve.js` | a synthetic MGA zone 55 COG and a range-request server for local testing |

The method is written up in [docs/index.md](docs/index.md). In short: one directional sweep per sun position
carries a "shadow surface" across the grid; a coarse 40 km surround supplies the incoming surface from
distant ridges (with earth curvature), and the fine grid casts locally.

Run locally with any static server that supports HTTP range requests, for example
`node test/serve.js . 8765`, then open <http://localhost:8765/>. `?dem=URL` points the page at another COG
(MGA94 zone 55, metres); `?load=1&detail=4&date=2026-06-21&time=720` loads straight away.

## Data

Tasmania 2 m Digital Elevation Model, Mineral Resources Tasmania / theLIST, CC BY 3.0 AU ("The LIST
(c) State of Tasmania"), read live from the cloud-optimised copy on
[Source Cooperative](https://source.coop/alexgleith/tasmania-dem-2m). Basemaps: theLIST (CC BY 3.0 AU;
aerial photo CC BY-NC-ND 3.0 AU) and OpenStreetMap contributors.

Libraries from jsDelivr: Leaflet 1.9.4, proj4js 2.12.1, geotiff.js 3.0.5.
