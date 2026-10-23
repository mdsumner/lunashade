# lunashade: notes

Musings and working notes behind the [lunashade prototype](../). It answers one question: where does the
sun reach the ground, and for how long, given the shape of the land? Everything is computed in the browser
from the Tasmania 2 m DEM.

## Why build one

Global web shade simulators already exist, and they are good for "will the backyard get sun at 3 pm".
They have two weak spots that matter at 43 degrees south:

- **They only see what is on screen.** Shadows are cast from the terrain inside the current map view.
  At Hobart the midwinter sun reaches only about 24 degrees at noon, and in the morning and evening it is
  much lower, so the shadows that decide whether a street gets sun come from ridges several kilometres
  away. Zoom in to street level and those ridges are no longer in the calculation.
- **Their terrain is coarse.** It is a global elevation product, typically tens of metres, where a gully,
  a road cutting or a terrace wall disappears.

Tasmania has a statewide 2 m DEM, already published as a single cloud-optimised GeoTIFF that a browser can
read directly (a few 512 x 512 tiles at a time, from whichever overview matches the scale needed). That
covers both weak spots: fine detail where you are looking, and a cheap coarse read of the surround out to
tens of kilometres.

## What the DEM is (and is not)

- **Bare earth.** It is ground level only: no trees, no buildings. lunashade therefore shows terrain shade
  only. That is the part existing tools do worst here, so the two complement each other rather than overlap.
  Under forest the ground is shaded most of the day whatever the terrain does.
- **Only about 65% is really 2 m.** Roughly two thirds comes from LiDAR. The rest is interpolated from
  photogrammetric contours, spot heights and coastline, at an effective 10 m. Treat sharp detail outside
  LiDAR areas with suspicion.
- **Grid and datum.** GDA94 / MGA zone 55, heights relative to AHD. Sea and no-data are treated as 0 m.

## How it works

### One sweep per sun position

For a single sun position, shadow over a grid can be found in one pass, O(N) in the number of cells, with no
ray marching:

1. Light travels away from the sun. Visit the grid line by line along the light's direction (columns or
   rows, whichever the light crosses faster).
2. Carry a *shadow surface* H: the lowest height a sun ray can pass over a cell without having touched
   terrain upstream.
3. Moving one line downstream, the surface drops by `step * tan(elevation)`. A cell is in shadow if the
   arriving surface is above the ground there. The surface leaving the cell is `max(ground, arriving)`.
4. The upstream neighbour lies at a fractional offset one line back, so H is interpolated between two
   cells. Where one of the two has no surface, the higher one is used so a real shadow is not smeared away.

On synthetic terrain the sweep agrees with brute-force ray marching (quarter-cell steps, bilinear heights)
on 98 to 100% of cells across a range of sun positions; the disagreements sit on shadow edges. It takes
about 40 ms for a 1500 x 1500 grid in one browser thread.

### Near and far

A single fine grid wide enough for low winter sun would be enormous, so the page reads two:

- **Near**: the area of interest plus a margin, at 2, 4, 8 or 16 m.
- **Far**: 40 km each way at 64 m or coarser, from a COG overview. Cells inside the near domain are
  switched off as casters, because the near grid casts there at full detail.

The far sweep produces the shadow surface *arriving* at each coarse cell from distant terrain only. That
surface is interpolated onto the near grid and fed into the near sweep as an incoming ceiling. A distant
ridge's shadow passes over the near area at the right height, and local terrain still casts at full detail.

On a synthetic test (fine grid everywhere as the reference), near-only gets 10 to 13% of cells wrong at low
sun angles from the far side; near plus far gets 99.2 to 100% right.

### Earth curvature

Over 40 km it matters: the ground falls away by about `d^2 / 2R`, which is about 125 m at 40 km (about 110 m with
standard refraction, k = 0.13). The far sweep carries a distance-since-caster with the surface, so each step
adds the curvature increment as well as the slope drop. The near grid is small enough to ignore it.

### Skyline at a point

Tapping a point traces the horizon in 360 directions out to 40 km, from 1.5 m above the ground, using the
near grid then the far grid, with curvature. The page draws that skyline against the sun's path for the
chosen date and both solstices, and reports first and last direct sun and the total, to the minute. This is
the horizon-angle idea in miniature: once you know the skyline, any date or time is a lookup.

### Sun position

NOAA solar calculator equations with standard refraction, against true north. The DEM grid is rotated
slightly from true north (meridian convergence, about 0.2 degrees around Hobart), so sun azimuths are
converted to grid azimuths before sweeping. Times are Australia/Hobart local, daylight saving included.

## Viewshed

What can be seen from a tapped spot, computed as an exact object-space visibility map on the DEM as
triangles: gnomonic wedges around the eye, a front-to-back walk with no sort, and a horizon kept as an
upper envelope. The horizon left at the end is the skyline. Written up in [viewshed](viewshed.html).

## Exporting

*Download GeoJSON* writes what is shown as polygons that follow cell edges (shadow at the time, hours of
sun in 1-hour bands, or the visible ground with the observer), in WGS84 lon/lat, with the settings and
the area analysed as properties and features. Grids become polygons by tracing every in/out cell boundary
into rings, outer rings counter-clockwise and holes clockwise. Cells that touch only at a corner stay
separate.

## The DEM file

Load speed depends on how the COG is cut. The status line reports requests, bytes and time for opening
the file, the square and the surround; [checking the DEM COG](cog.html) explains what to look for and
how to check it with gdalraster.

## The bigger product: a horizon-angle stack

The prototype computes on demand for a few kilometres at a time. A statewide version could keep the same
"recipe, not payload" shape:

- Precompute **horizon elevation angles** for every cell in a fixed set of directions (say 72 azimuths, every
  5 degrees), near field from the 2 m grid and far field from an overview, as above.
- Store that as a chunked array (azimuth x row x col, 8 bits per angle is enough at 0.5 degree steps) in
  object storage, beside the DEM.
- Any date and time is then a lookup per pixel: is the sun above the skyline in its direction? Hours of sun
  for a day, a season or a year become cheap reductions over that, in a browser or on a server.

At 72 bytes per cell, the stack is 18 times the size of the DEM as float32, so it probably wants a coarser
grid away from the places people care about. Sun-hour summaries per month (12 values per cell) may be the
better thing to publish, keeping the horizon stack as the source to recompute them from.

## What next

- **Check against reality.** Sunrise and sunset photos or times at known spots in the shadow of kunanyi;
  long-term residents know the date the sun comes back over the ridge.
- **Surfaces, not just ground.** LiDAR point clouds exist for parts of the state (and 1 m surfaces around
  kunanyi). A surface model would add trees and buildings where available; a canopy-height layer could
  fill elsewhere, at lower confidence.
- **Roads.** Sample shade along the road network: "segments that get no sun before 11 am in June" is a
  frost and black-ice question. See the [lunamap fold-in notes](lunamap.html).
- **Insolation.** Weight sunlit time by the angle of incidence on the slope for direct energy (kWh/m2),
  rather than hours.
- **Speed.** The sweep is embarrassingly simple to put on the GPU; sun hours for a year would then be quick
  in the browser.

## Testing

- `node test/test-polygonize.js` checks the GeoJSON polygons against the grid they came from.
- `node test/test-osvm.js` checks the viewshed against brute-force line of sight on the same TIN, and its
  skyline against the probe.
- `node test/test-engine.js` checks the sweep against brute force and the near/far split against a single
  fine grid, and times a sweep.
- `test/make_synth.py` writes a synthetic MGA zone 55 COG with overviews, and `test/serve.js` serves it with
  HTTP range requests; open `index.html?dem=http://localhost:8765/testdata/synth.tif&load=1` against it.

Data: Tasmania 2 m DEM, Mineral Resources Tasmania / theLIST (CC BY 3.0 AU), read from Source Cooperative.
