import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { LatLng, ViewportBounds } from "../types";

/**
 * A local, approximate road/path network for the current map area, used only to give
 * an instant "rough snap" preview while dragging a shape — nearest-vertex lookup
 * against cached geometry, no network call per frame. The real, accurate snap still
 * goes through OSRM via routing.ts; this is purely a cheap visual hint.
 *
 * Road geometry comes from MapTiler's vector tiles rather than the Overpass API: the
 * free public Overpass instance (and every mirror of it tried) turned out to be too
 * unreliable in practice — confirmed via direct, repeated testing — to build a "quick
 * preview" on top of. MapTiler's tile CDN is the production-grade alternative; it just
 * requires a free API key (see VITE_MAPTILER_KEY below) instead of being anonymous.
 */

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
/** OpenMapTiles schema: roads/paths live in the "transportation" layer. */
const ROAD_LAYER = "transportation";
/** Fixed zoom for the tiles we fetch, independent of the map's own current zoom — high
 * enough for street-level detail, low enough that a few-km area is only a handful of
 * tiles. */
const TILE_ZOOM = 15;
/** Grid cell size for the spatial index, in degrees (~30m) — coarse on purpose, this
 * is a "quick and rough" preview, not the real snap. */
const GRID_CELL_DEG = 0.0003;
/** Extra margin fetched around the viewport so small pans/drags don't need a refetch. */
const PAD_FACTOR = 0.5;
/** Max span (degrees, ~3km) for the actual tile fetch, regardless of how far zoomed
 * out the map is — this cache only exists to make dragging a shape feel responsive at
 * the zoom level you'd actually do that at, not to mirror the whole visible area. */
const MAX_QUERY_SPAN_DEG = 0.03;

let cachedBounds: ViewportBounds | null = null;
let grid: Map<string, LatLng[]> | null = null;
let fetchInFlight: Promise<void> | null = null;

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const [lat1, lng1] = a;
  const [lat2, lng2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function cellKey(lat: number, lng: number): string {
  return `${Math.floor(lat / GRID_CELL_DEG)}:${Math.floor(lng / GRID_CELL_DEG)}`;
}

function buildGrid(points: LatLng[]): Map<string, LatLng[]> {
  const g = new Map<string, LatLng[]>();
  for (const p of points) {
    const key = cellKey(p[0], p[1]);
    const bucket = g.get(key);
    if (bucket) bucket.push(p);
    else g.set(key, [p]);
  }
  return g;
}

function padBounds(bounds: ViewportBounds, factor: number): ViewportBounds {
  const latPad = (bounds.north - bounds.south) * factor;
  const lngPad = (bounds.east - bounds.west) * factor;
  return {
    north: bounds.north + latPad,
    south: bounds.south - latPad,
    east: bounds.east + lngPad,
    west: bounds.west - lngPad,
  };
}

function clampSpan(bounds: ViewportBounds): ViewportBounds {
  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;
  const latSpan = Math.min(bounds.north - bounds.south, MAX_QUERY_SPAN_DEG) / 2;
  const lngSpan = Math.min(bounds.east - bounds.west, MAX_QUERY_SPAN_DEG) / 2;
  return {
    north: centerLat + latSpan,
    south: centerLat - latSpan,
    east: centerLng + lngSpan,
    west: centerLng - lngSpan,
  };
}

function fullyContains(outer: ViewportBounds, inner: ViewportBounds): boolean {
  return (
    outer.north >= inner.north &&
    outer.south <= inner.south &&
    outer.east >= inner.east &&
    outer.west <= inner.west
  );
}

interface TileCoord {
  x: number;
  y: number;
  z: number;
}

function lngLatToTile(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1) };
}

function tilesForBounds(bounds: ViewportBounds, zoom: number): TileCoord[] {
  const nw = lngLatToTile(bounds.west, bounds.north, zoom);
  const se = lngLatToTile(bounds.east, bounds.south, zoom);
  const tiles: TileCoord[] = [];
  for (let x = nw.x; x <= se.x; x++) {
    for (let y = nw.y; y <= se.y; y++) {
      tiles.push({ x, y, z: zoom });
    }
  }
  return tiles;
}

/** Fetches one vector tile and flattens its road layer's geometry into plain lat/lng
 * points. Resolves to an empty array (never rejects) on any failure, so one bad tile
 * doesn't sink the whole viewport's worth of data. */
async function fetchTileRoadPoints({ x, y, z }: TileCoord): Promise<LatLng[]> {
  try {
    const url = `https://api.maptiler.com/tiles/v3/${z}/${x}/${y}.pbf?key=${MAPTILER_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`maptiler error (HTTP ${res.status})`);
    const buffer = await res.arrayBuffer();
    const tile = new VectorTile(new PbfReader(buffer));
    const layer = tile.layers[ROAD_LAYER];
    if (!layer) return [];

    const points: LatLng[] = [];
    for (let i = 0; i < layer.length; i++) {
      const geometry = layer.feature(i).toGeoJSON(x, y, z).geometry;
      if (geometry.type === "LineString") {
        for (const [lng, lat] of geometry.coordinates) points.push([lat, lng]);
      } else if (geometry.type === "MultiLineString") {
        for (const line of geometry.coordinates) {
          for (const [lng, lat] of line) points.push([lat, lng]);
        }
      }
    }
    return points;
  } catch {
    return [];
  }
}

/**
 * Kicks off a fetch of the local road network for roughly snapping shapes while
 * dragging, if the currently cached area doesn't already cover `bounds`. Safe to call
 * on every viewport change — the padded cache area and in-flight check mean most calls
 * are no-ops. Fire-and-forget: nearestRoadPoint just returns null until this resolves
 * (or forever, if VITE_MAPTILER_KEY isn't configured).
 */
export function ensureRoadNetworkLoaded(bounds: ViewportBounds): void {
  if (!MAPTILER_KEY) return;
  if (cachedBounds && fullyContains(cachedBounds, bounds)) return;
  if (fetchInFlight) return;

  const padded = clampSpan(padBounds(bounds, PAD_FACTOR));
  const tiles = tilesForBounds(padded, TILE_ZOOM);

  fetchInFlight = Promise.all(tiles.map(fetchTileRoadPoints))
    .then((perTile) => {
      grid = buildGrid(perTile.flat());
      cachedBounds = padded;
    })
    .finally(() => {
      fetchInFlight = null;
    });
}

/** Whether any road data has actually been loaded yet — lets callers decide not to
 * draw a "preview" that would otherwise just be an exact (and confusing) duplicate of
 * the shape's own outline. */
export function hasRoadNetwork(): boolean {
  return grid !== null;
}

/**
 * Nearest cached road vertex to `point`, searching outward in grid rings — or null if
 * no road data is cached yet, or none was found nearby. Approximate by design: the
 * first ring with any point wins, which can occasionally miss a slightly-closer point
 * just across a cell boundary. Fine for a rough drag-time preview.
 */
export function nearestRoadPoint(point: LatLng): LatLng | null {
  if (!grid) return null;
  const [lat, lng] = point;
  const baseRow = Math.floor(lat / GRID_CELL_DEG);
  const baseCol = Math.floor(lng / GRID_CELL_DEG);

  for (let radius = 0; radius <= 3; radius++) {
    let best: LatLng | null = null;
    let bestDistSq = Infinity;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue; // only this ring
        const bucket = grid.get(`${baseRow + dr}:${baseCol + dc}`);
        if (!bucket) continue;
        for (const p of bucket) {
          const dLat = p[0] - lat;
          const dLng = p[1] - lng;
          const distSq = dLat * dLat + dLng * dLng;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            best = p;
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** A snapped gap bigger than this multiple of the two points' own original (unsnapped)
 * gap — plus a flat margin, so small raw gaps aren't flagged by normal vertex-spacing
 * jitter — is treated as a jump onto a different, disconnected road rather than a real,
 * walkable stretch. Empirically chosen, not derived. */
const MAX_SNAP_JUMP_RATIO = 2;
const MAX_SNAP_JUMP_MARGIN_M = 25;

/**
 * Snaps each point in a path to the nearest cached road vertex — except where that
 * would stretch the gap to the previous point far beyond what it originally was,
 * which is a strong signal the two points landed on different, disconnected streets
 * (e.g. opposite sides of a block of houses with no path through it). Those points
 * fall back to their raw, unsnapped position instead of drawing a straight line
 * through whatever's in between. Still a purely local, instant heuristic — not real
 * graph connectivity — but enough to stop the preview from visibly cutting through
 * buildings.
 */
export function roughSnapPath(points: LatLng[]): LatLng[] {
  if (!grid || points.length === 0) return points;

  const result: LatLng[] = [nearestRoadPoint(points[0]) ?? points[0]];
  for (let i = 1; i < points.length; i++) {
    const snapped = nearestRoadPoint(points[i]) ?? points[i];
    const rawGap = haversineMeters(points[i - 1], points[i]);
    const snappedGap = haversineMeters(result[i - 1], snapped);
    const maxAllowedGap = rawGap * MAX_SNAP_JUMP_RATIO + MAX_SNAP_JUMP_MARGIN_M;
    result.push(snappedGap <= maxAllowedGap ? snapped : points[i]);
  }
  return result;
}
