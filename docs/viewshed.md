# Viewshed: an object-space visibility map

What can be seen from a spot, worked out exactly on a triangulation of the terrain instead of by
marching rays across cells. Code: [`js/osvm.js`](../js/osvm.js); tests: `node test/test-osvm.js`. In the
[prototype](../), choose **viewshed** under *Show* and tap a spot.

## Words

- **Viewshed**: the ground visible from an observer, here the eye at a height (1.5 m by default) above
  the terrain. Each point is decided by its **line of sight (LOS)** to the eye.
- **Cast shadow is a viewshed from the sun.** The shade sweep in [the notes](./) answers the same question
  for an observer at infinity, where the rays are parallel (an orthographic view). A point viewshed is the
  perspective version. Same problem, different projection.
- **Hidden surface removal (HSR)**: deciding which surface is nearest along each ray.
  - *Image space*: one answer per pixel; the z-buffer, or on a GPU a shadow map.
  - *Object space*: an exact geometric answer, as polygons. That is what this is.
- **Visibility map**: the division of the observer's view into regions, each labelled with the triangle
  seen there. Taken back to the ground, it is the viewshed as exact polygons.
- **TIN** (triangulated irregular network): terrain as triangles. Here the vertices are the DEM cell
  centres and each square of four neighbours is split on one diagonal.
- **Gnomonic (central) projection**: projection through the eye onto a plane. Straight lines in 3D stay
  straight, so a projected triangle is still a triangle. An azimuth / elevation grid does not have this
  property: straight edges become curves there. A cube map is six gnomonic faces.
- **Front-to-back order** (the in-front-of relation): an order in which nothing can be hidden by a
  triangle that comes later.
- **Horizon / upper envelope**: when triangles are drawn front to back, everything drawn so far covers
  the view from the bottom up to a horizon line. That line is the upper envelope of the projected
  triangle edges.

## Method

1. **Four gnomonic wedges.** The view around the eye is split into four 90 degree wedges of azimuth
   (N, E, S, W). In each wedge, a point at plan offset `q` and height `z` relative to the eye projects to
   `u = right.q / forward.q`, `v = z / forward.q`. At fixed `u` (fixed azimuth), `v` increases with
   elevation angle, so "above" in `v` means "above" in the view. Each wedge is cut into 64 narrow
   sectors of equal width in `u`, which keeps the per-sector bookkeeping small. Every cut is a vertical
   plane through the eye, so triangles are clipped in plan, where the height interpolates linearly.
2. **Front to back with no sort.** For terrain seen from above the ground, anything that can hide a point
   lies nearer to the eye along the same plan ray. On a regular grid of quads, the quads crossed by a
   plan ray from the eye to quad Q have row and column offsets from the eye's quad no larger than Q's
   (on the same side). So visiting quads in increasing `|dcol| + |drow|` is a valid front-to-back
   order; inside a quad, the triangle on the eye's side of the diagonal goes first. (For a general
   Delaunay TIN the same guarantee is Edelsbrunner's acyclicity theorem: sort by power distance from the
   eye to each triangle's circumcircle. On a square grid that ordering reduces to this one.)
3. **Visible = above the horizon.** In each sector the horizon is a piecewise-linear function `v = E(u)`.
   A projected triangle is visible exactly where it lies above `E`; afterwards `E` becomes
   `max(E, top edge of the triangle)`. Most triangles are entirely below the horizon. A cheap test
   catches those before any clipping, using a lower bound on `E` kept in 16 bins per sector.
4. **Back to the ground.** Central projection from a triangle's plane to the image plane is projective,
   so straight edges stay straight. Each visible piece maps back to a convex polygon on its triangle,
   in plan.
5. **Near and far.** The near grid (2 to 16 m) goes first, then the far grid (64 m, the same surround
   the shade uses), skipping far quads that touch the near grid. The near grid is a convex region
   around the eye, and a plan ray leaves it only once, so everything near is in front of everything far.
6. **Earth curvature** (with standard refraction, k = 0.13) lowers each vertex by `d^2 / 2R` before
   projection.

The horizon left at the end is the **skyline** at the spot, for free. It is the same quantity the
skyline probe ray-marches, and the horizon-angle stack in [the notes](./) would store.

## Code layout: kernel, sources, orders

The JavaScript and the Rust crate ([`rust/osvm`](../rust/osvm/)) have the same three layers:

- **The kernel** (`Horizon`) takes triangles in front-to-back order and returns area, visible pieces and
  skyline. It knows nothing about where the triangles come from.
- **Sources** feed it: a grid (walked by Manhattan offset, as above) or an explicit mesh (vertex and
  index arrays: any triangulation).
- **Orders** for explicit meshes: `orderTopo` / `order_topo`. Along a plan ray from the eye, the triangles
  crossed are neighbours across shared edges, each crossed from the side facing the eye. So "the
  triangle on the eye's side of a shared edge goes first", over all shared edges, is the whole
  in-front relation. A topological sort of it is a valid order, in linear time. Delaunay meshes never
  have a cycle; constrained or adaptive meshes might, so triangles caught in a cycle are counted and
  appended nearest first. The mesh must cover a convex region, so that no plan ray leaves the mesh and
  comes back.

The Rust crate is checked against the JavaScript: `node test/make-parity.js` writes a fixture of JS
answers, and `cargo test` in `rust/osvm` compares. They agree to the last digit of visible area and on
every count. The Rust version is about 2 times faster: 1.4 s against 2.5 s for 5.1 M triangles.

## How well it works

`node test/test-osvm.js` on synthetic terrain:

- **Against brute force.** Line of sight was sampled at 1/16 of a cell on the same TIN, at 3000 random
  points from each of four observers (eye 1.5 to 10 m). Agreement was 99.9 to 100%, excluding points
  within 5 cm of grazing. The one disagreement inspected was 3.5 cm under the sight line by a finer
  brute-force check.
- **With curvature**, on a 19 km square at 64 m: 100% agreement against brute force with the same
  vertex drop.
- **The explicit-mesh path** gives the same area as the grid path when the diagonals match (relative
  difference 1e-15). With diagonals flipped at random it agrees with brute force on 99.97% of points,
  with no cycles.
- **Skyline vs the ray-marched probe** (bilinear heights, a different surface model): mean difference
  0.012 degrees, maximum 0.11 degrees.
- **Speed (node, one thread).** About 100,000 triangles take 0.2 to 0.4 s. At app size (1000 x 1000 at
  4 m plus 1250 x 1250 at 64 m, 5.1 M triangles) it takes 2.9 s, of which 1.6 s is out to 20 km. About
  85% of triangles are rejected by the quick horizon test. In the browser on a smooth synthetic hill,
  where much more is visible, a 4 km area out to 20 km took 6 to 7 s.

## Limits, for now

- **Triangles per cell.** Every DEM cell becomes two triangles, however far away it is. The real gain
  from triangles has not been taken yet; see below.
- **The ring boundary** between near and far leaves a gap up to one far cell wide that casts nothing.
- **Ground to ground.** It answers "can I see the ground there". Seeing a 2 m target (a person, a
  vehicle, smoke at 50 m) is a different question: whether a raised point is visible, not a surface. It
  needs its own pass.
- **Bare earth.** As with the shade, there are no trees or buildings in the DEM.

## Where it goes next

- **Level of detail in angle, not metres.** What matters is how big an error looks from the eye: a 1 m
  error 10 km away subtends 0.006 degrees. A view-dependent TIN (fine near the eye, coarse far away)
  would cut the triangle count by orders of magnitude. That is the real reason to triangulate, rather
  than two triangles per cell. The catch: visibility is decided at ridgelines, so simplification has to
  protect silhouette edges, not just bound vertical error. A Delaunay TIN keeps exact front-to-back
  order through the power-distance sort.
- **Bindings for the Rust crate**: R through extendr, taking meshes as plain vertex and triangle tables,
  so mesh producers and this kernel stay independent; and WebAssembly for this page.
- **Vector output.** The visible pieces are already polygons in MGA zone 55 (`pieces` in the result),
  so a GeoJSON download, or a dissolved outline, is a short step.
- **GPU for interaction.** A depth cube map rendered from the eye (an omnidirectional shadow map) gives an
  image-space viewshed fast enough to drag the eye around. The object-space version stays the one to
  export.
- **lunamap.** "What can I see from here" at a pin, with the skyline, is a natural companion to the
  pin-panel sun row in the [fold-in notes](lunamap.html).
