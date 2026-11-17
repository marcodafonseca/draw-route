# Draw → Route

Draw a shape or line on a map, snap it to real streets and paths, and export it as a
GPX file for a GPS watch or running app. Client-only — no backend.

## Features

- **Draw** polylines, polygons, rectangles, and circles directly on the map
  (leaflet-draw), or type text to generate a route that traces the letters.
- **Convert to route**: snaps the drawn shape onto the real pedestrian path network
  via OSRM, preserving the shape's proportions as closely as the street grid allows.
  A short stretch with no nearby path (e.g. across a field) is kept as the straight
  line you drew instead of forcing a street detour around it.
- **Find best fit**: searches the current map view (position and scale) for the
  real-world placement that best matches the drawn shape, with a locally-computed
  pre-filter so most of the search doesn't cost an API call.
- **Drag-to-preview**: while dragging a shape, see a rough live preview of how it
  would snap to nearby roads, without hitting the routing API on every frame.
- **Edit after creation**: drag a completed polyline/polygon's individual vertices
  to adjust the route; revisit an earlier point while drawing (e.g. an out-and-back).
- **Share a drawing**: "Copy share link" encodes your current shapes into the URL
  itself (no server involved) — reload or send that link to restore them exactly.
- **Export GPX** for any generated route.

## Setup

```bash
npm install
```

Drag-preview road snapping uses MapTiler's vector tiles and needs a free API key:

1. Sign up at [cloud.maptiler.com](https://cloud.maptiler.com/) (free tier).
2. Create a key and set its allowed origin to `localhost` (or your deploy domain).
3. Create `.env.local` in the project root:
   ```
   VITE_MAPTILER_KEY=your-key-here
   ```
   This isn't a secret — it's inlined into the client bundle — the "Allowed HTTP
   Origins" restriction on the key is the actual access control.

Vite only reads `.env.local` at dev-server startup, so restart `npm run dev` after
creating or editing it.

## Running

```bash
npm run dev      # start the dev server
npm run build    # type-check (tsc -b) and build for production
npm run lint     # oxlint
npm run preview  # preview the production build locally
```

## Architecture

- `src/lib/routing.ts` — OSRM client (`routing.openstreetmap.de/routed-foot`),
  shape-fidelity scoring, and the retry logic behind "Convert to route" / "Find best
  fit". No backend: this calls OSRM's public instance directly from the browser.
- `src/lib/roadCache.ts` — MapTiler vector-tile road network, cached locally per
  viewport, used for the drag-preview snap and for pre-filtering "Find best fit"
  candidates before spending an OSRM call on them.
- `src/lib/shareCode.ts` — compact, lossless shape encoding for share links.
- `src/lib/gpx.ts` — GPX file generation.
- `src/lib/textToShapes.ts` + `src/lib/font.ts` — typed text → route shapes, via
  `opentype.js` outlines of a bold display font (thin fonts don't hold up once
  snapped to roads).
- `src/lib/leafletDrawPatches.ts` — monkey-patches for leaflet-draw internals
  (corner-to-corner circle drawing, vertex revisiting, an upstream area-label bug).
- `src/components/MapCanvas.tsx` — the Leaflet map, shape rendering, drag/resize/
  vertex-edit interactions.
- `src/components/Toolbar.tsx` — the sidebar: shape list, conversion actions, text
  input, share/export/delete controls.
- `src/App.tsx` — owns `DrawnShape[]` / `RouteResult[]` state and wires the two
  components together.

OSRM's public instance is free but rate-limited and has no SLA — fine for this
client-only tool, but the first thing to swap out (for a self-hosted OSRM or a
backend proxy) if this ever needs production-grade reliability.
