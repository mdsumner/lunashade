# Folding lunashade into lunamap: a discussion piece

For the people working on [lunamap](https://github.com/mdsumner/lunamap). This sets out what a sun and shade
layer could add to lunamap, how much code it would take, and the questions to settle before doing it. Nothing
here is decided. The [prototype](../) is a standalone page, so it can be tried without touching lunamap.

## What it would give a group like ours

Terrain decides where the sun does and does not reach, especially from May to August. Some uses that are
specific enough to matter:

- **Frost and black ice on roads.** Road segments that get no direct sun before late morning in winter stay
  frozen longest. A "no sun before 11 am today" overlay on the road network is a direct answer to "which
  bends will be icy on an early call-out".
- **Fuel dryness and aspect.** Slopes that get many hours of direct sun dry out faster than shaded gullies.
  lunamap already shows vegetation flammability; hours of sun on the same ground is a natural companion
  layer, and it changes with the season in a way vegetation mapping does not.
- **When the sun is in your eyes.** The skyline view shows when the sun rises over, or sets behind, the
  ridge at a spot: driving into a low sun on a known road, or planning a burn or a photo.
- **Everyday questions.** Gardens, solar panels on a hall or shed, siting a water tank or a meeting point
  that stays warm in winter. These bring people to the map, which helps when it matters.

Caveat for every one of these: the DEM is bare ground. Under forest the ground is in shade for most of the
day whatever the terrain does. The layer says where the land itself blocks the sun, not where the trees do.

## Options, from least to most work

### 1. A pin-panel row (smallest, probably most useful)

lunamap's pin panel already gets the pin's elevation from the same 2 m DEM (`js/extras.js` loads
`js/profile.js` and geotiff.js on first use). One more row could read:

> Sun today: 10:12 - 15:31 (5 h 19 min); midwinter 3 h 02 min

That needs the skyline at the pin (`horizon()` in `js/engine.js`) and the sun path (`js/sun.js`). The skyline
needs a read of about 2 km around the pin at 4 m, plus 40 km at 64 m (a handful of COG tiles), then well
under a second of arithmetic. Tapping the row could open the skyline chart. No overlay, no mode
switch, nothing to explain.

### 2. An Explore-mode overlay

The prototype as a lunamap tool: "Sun and shade here" loads a square around the map centre, with a time
slider, play button and an "hours of sun today" option. In code terms:

- `js/engine.js` and `js/sun.js` are classic scripts with no dependencies; `js/worker.js` runs them off the
  main thread. They can be copied in as they are.
- The DEM reader in the prototype is lunamap's `openDEM()` / level choice, extended to block-average when no
  overview is coarse enough. The two would merge.
- The overlay is a canvas in a Leaflet overlay; lunamap would load it on demand like the wind rose or
  3D view.

This belongs in Explore rather than Field: it takes a deliberate action and a few seconds, and it is not
something to fiddle with on a call-out.

### 3. A roads product

Sample the shade along theLIST road network (which lunamap already loads for routing) and colour road
segments by first direct sun of the day, or hours of sun, for the date. This could run on demand for the
roads near the pin, or be precomputed for each month for the whole area a group covers and saved with the
offline road pack.

### 3a. What can be seen from here

The [viewshed](viewshed.html) answers "what ground can be seen from this pin" (or from a tower at 30 m),
with the skyline as a by-product. For a brigade: lookout coverage, where a smoke column could be seen from,
radio line of sight to a repeater (with the caveat that radio is not quite line of sight). It reads the
same DEM; a few seconds per spot at the moment.

### 4. Precomputed, statewide

Store horizon angles (or monthly hours of sun) for the whole state in object storage, so any of the above
is an instant lookup and works offline for a saved area. This is the larger project described in the
[notes](./#the-bigger-product-a-horizon-angle-stack). It pairs naturally with the terrain tiles being built
for the 3D view: same DEM, same tiling decisions.

## Cost on a phone

On a desktop browser, one sun position over 1000 x 1000 cells takes tens of milliseconds, and hours of sun
for a midwinter day at 10-minute steps takes a few seconds. A phone will probably be several times slower,
and a 4 km square needs roughly 50 to 100 MB of memory. The pin-panel row needs a fraction of that. None of
it needs a server; it reads the same public COG that lunamap's elevation and profiles already use.

## Questions for the team

1. Is the pin-panel row worth having by itself? It is the cheapest option and the one most likely to be
   used.
2. Is the roads layer (frost and ice) useful in practice, or would people simply know which roads ice up?
3. Should it work offline? That decides between computing on demand and precomputing for saved areas.
4. How much do trees matter for the questions we care about? If a lot, we need a surface model (LiDAR or
   canopy height) before this is more than a curiosity in forested areas.
5. Who would check it against reality: known sunrise times at a few spots in the shadow of the mountain?

Comments welcome as issues on [mdsumner/lunashade](https://github.com/mdsumner/lunashade/issues).
