import type { LatLng, ViewportBounds } from "../types";
import { simplifyToMax } from "./simplify";
import { hasRoadNetwork, roughSnapPath } from "./roadCache";

/**
 * FOSSGIS's public OSRM instance. Free, no API key, but rate-limited (~1 req/sec)
 * and intended for light/non-commercial use only. Swap this for a self-hosted OSRM
 * (or a backend proxy) if this project ever needs production-grade reliability.
 */
const BASE_URL = "https://routing.openstreetmap.de/routed-foot";
/**
 * We use /route (connect these waypoints via real streets), not /match (align a
 * noisy GPS trace to the road graph). /match fits actual recorded GPS traces, but
 * this instance caps it at ~10 coordinates; /route comfortably handles 90+ and is
 * the better semantic fit for "follow real streets through these drawn points"
 * anyway.
 *
 * MAX_ROUTE_WAYPOINTS is deliberately much lower than that ~90 cap: it's a quality
 * knob, not a safety margin. A smooth shape like a 48-segment circle produces many
 * waypoints just tens of meters apart; sending OSRM every one of them forces it
 * through each individually-snapped point in sequence, and a single bad snap/tie-break
 * anywhere in that long chain can send the whole route into a wild detour (confirmed
 * live: the *identical* 49-point request returned two very differently-shaped routes
 * on separate calls). Fewer, more spread-out waypoints give OSRM more room to find a
 * sensible connecting path between each pair, which is far more robust in practice —
 * at the cost of following the drawn outline a bit less tightly between points.
 *
 * Raised from 24: a short, deliberate deviation (e.g. a drawn dip down a specific side
 * street, surrounded by much longer straight stretches) can get Douglas-Peucker-
 * simplified away before it ever reaches OSRM once a shape needs heavy simplification
 * to fit under this cap — nothing pins the route through that street, so OSRM is free
 * to pick a shorter path between the surrounding (kept) waypoints instead (confirmed
 * live: a drawn route down Alexandra Place instead crossed at a Beach Road zebra
 * crossing because no waypoint survived simplification on that street). 40 trades back
 * some of that robustness margin for more retained route detail, while staying well
 * under the 49-point threshold where instability was observed.
 */
const MAX_ROUTE_WAYPOINTS = 40;

export class RoutingError extends Error {}

interface OsrmRouteResponse {
  code: string;
  message?: string;
  routes?: Array<{
    distance: number;
    geometry: { coordinates: [number, number][] };
    legs: Array<{ distance: number }>;
  }>;
}

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

function cumulativeDistances(points: LatLng[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversineMeters(points[i - 1], points[i]));
  return cum;
}

function pointAtDistance(points: LatLng[], cum: number[], target: number): LatLng {
  if (target <= 0) return points[0];
  const totalLength = cum[cum.length - 1];
  if (target >= totalLength) return points[points.length - 1];
  let i = 1;
  while (cum[i] < target) i++;
  const segStart = cum[i - 1];
  const segLen = cum[i] - segStart || 1;
  const t = (target - segStart) / segLen;
  const [lat1, lng1] = points[i - 1];
  const [lat2, lng2] = points[i];
  return [lat1 + (lat2 - lat1) * t, lng1 + (lng2 - lng1) * t];
}

function sliceByDistance(points: LatLng[], cum: number[], from: number, to: number): LatLng[] {
  const result: LatLng[] = [pointAtDistance(points, cum, from)];
  for (let i = 0; i < points.length; i++) {
    if (cum[i] > from && cum[i] < to) result.push(points[i]);
  }
  result.push(pointAtDistance(points, cum, to));
  return result;
}

/**
 * Below this detour ratio (a leg's snapped distance vs. the straight-line distance
 * between the two drawn waypoints it connects), OSRM's path is treated as a real,
 * legitimate route and kept as-is. Above it, OSRM could only connect those two points
 * via a big detour — in practice because there's no nearby path at all (e.g. the gap
 * is open ground: a field, a park with no path through it). A user drawing straight
 * across terrain like that already knows it's walkable/runnable, so that stretch is
 * replaced with the straight line they actually drew instead of forcing a street
 * detour around it. Thresholds are empirical, not derived.
 */
const DETOUR_RATIO_THRESHOLD = 1.6;
const DETOUR_ABSOLUTE_MARGIN_M = 30;

function preserveOpenStretches(
  waypoints: LatLng[],
  routeGeometry: LatLng[],
  legDistances: number[]
): MatchedRoute {
  const cum = cumulativeDistances(routeGeometry);

  let cursor = 0;
  let totalDistance = 0;
  const points: LatLng[] = [];

  for (let i = 0; i < legDistances.length; i++) {
    const legDistance = legDistances[i];
    const straightDistance = haversineMeters(waypoints[i], waypoints[i + 1]);
    const isOpenStretch = legDistance > straightDistance * DETOUR_RATIO_THRESHOLD + DETOUR_ABSOLUTE_MARGIN_M;
    console.debug(
      `[routing] leg ${i}: snapped=${legDistance.toFixed(1)}m straight=${straightDistance.toFixed(1)}m` +
        (isOpenStretch ? " -> STRAIGHTENED (treated as open stretch)" : "")
    );

    const legPoints = isOpenStretch
      ? [waypoints[i], waypoints[i + 1]]
      : sliceByDistance(routeGeometry, cum, cursor, cursor + legDistance);

    if (points.length > 0) points.pop(); // shared boundary point with the previous leg
    points.push(...legPoints);
    totalDistance += isOpenStretch ? straightDistance : legDistance;
    cursor += legDistance;
  }

  return { points, distanceMeters: totalDistance };
}

export function haversineDistanceMeters(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

export interface MatchedRoute {
  points: LatLng[];
  distanceMeters: number;
}

async function fetchRoute(input: LatLng[]): Promise<MatchedRoute> {
  const coords = input.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = `${BASE_URL}/route/v1/foot/${coords}?geometries=geojson&overview=full`;
  console.debug(`[routing] sending ${input.length} waypoints to OSRM`, input, url);

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new RoutingError(
      "Couldn't reach the routing service. Check your connection and try again."
    );
  }

  if (!response.ok) {
    throw new RoutingError(`Routing service returned an error (HTTP ${response.status}).`);
  }

  const data: OsrmRouteResponse = await response.json();
  if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
    throw new RoutingError(
      "No nearby paths or roads could connect this shape. Try drawing closer to a street or trail."
    );
  }

  const best = data.routes[0];
  const routeGeometry: LatLng[] = best.geometry.coordinates.map(([lng, lat]): LatLng => [lat, lng]);
  return preserveOpenStretches(input, routeGeometry, best.legs.map((leg) => leg.distance));
}

// --- Shape-fidelity scoring and corrective retries -------------------------------
//
// OSRM snaps to whatever roads actually exist, which can noticeably distort a drawn
// shape's proportions (e.g. a letter's loop getting squashed to fit the street grid).
// Since the user only cares about the *shape* reading correctly — not its exact size
// or position — we score each attempt by how well its PROPORTIONS (not absolute size)
// match the original, and if a result is too distorted, retry with the input nudged by
// a corrective scale/offset inferred from how the previous attempt actually came out.

const MAX_ATTEMPTS = 3;
/** Below this normalized shape-distance, a result is "good enough" — stop retrying.
 * Empirically chosen, not derived: 0 is a perfect proportional match, ~0.5+ is a
 * noticeably different shape. */
const GOOD_ENOUGH_FIDELITY = 0.3;
const RATE_LIMIT_DELAY_MS = 1100;
const FIDELITY_SAMPLE_POINTS = 24;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function metersPerDegreeAt(lat: number): { perLat: number; perLng: number } {
  const latRad = (lat * Math.PI) / 180;
  return { perLat: 111320, perLng: 111320 * Math.cos(latRad) };
}

function toLocalMeters(center: LatLng, point: LatLng): { x: number; y: number } {
  const { perLat, perLng } = metersPerDegreeAt(center[0]);
  return { x: (point[1] - center[1]) * perLng, y: (point[0] - center[0]) * perLat };
}

function fromLocalMeters(center: LatLng, p: { x: number; y: number }): LatLng {
  const { perLat, perLng } = metersPerDegreeAt(center[0]);
  return [center[0] + p.y / perLat, center[1] + p.x / perLng];
}

function centroidOf(points: LatLng[]): LatLng {
  let sumLat = 0;
  let sumLng = 0;
  for (const [lat, lng] of points) {
    sumLat += lat;
    sumLng += lng;
  }
  return [sumLat / points.length, sumLng / points.length];
}

/** RMS distance from center, in meters — a scale-free "spread" measure of a point set. */
function rmsRadiusMeters(points: LatLng[], center: LatLng): number {
  let sumSq = 0;
  for (const p of points) {
    const { x, y } = toLocalMeters(center, p);
    sumSq += x * x + y * y;
  }
  return Math.sqrt(sumSq / points.length);
}

/** Median distance from center, in meters — like rmsRadiusMeters but robust to a few
 * outlier points. Used for fidelity-scale normalization specifically: a single wild
 * detour inflates RMS radius enough to shrink its own normalized footprint away
 * (self-canceling), but barely moves the median, so the detour still shows up as a
 * clear outlier once normalized by it. */
function medianRadiusMeters(points: LatLng[], center: LatLng): number {
  const distances = points
    .map((p) => {
      const { x, y } = toLocalMeters(center, p);
      return Math.hypot(x, y);
    })
    .sort((a, b) => a - b);
  const mid = Math.floor(distances.length / 2);
  return distances.length % 2 === 0 ? (distances[mid - 1] + distances[mid]) / 2 : distances[mid];
}

/** Resamples a (possibly closed) polyline to `n` points evenly spaced by arc length,
 * so two paths with very different point densities/counts become comparable. */
function resampleAlongPath(points: LatLng[], n: number): LatLng[] {
  if (points.length === 1) return new Array(n).fill(points[0]);

  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineMeters(points[i - 1], points[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total === 0) return new Array(n).fill(points[0]);

  const result: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    let seg = 1;
    while (seg < cumulative.length - 1 && cumulative[seg] < target) seg++;
    const segStart = cumulative[seg - 1];
    const segLen = cumulative[seg] - segStart || 1;
    const t = (target - segStart) / segLen;
    const [lat1, lng1] = points[seg - 1];
    const [lat2, lng2] = points[seg];
    result.push([lat1 + (lat2 - lat1) * t, lng1 + (lng2 - lng1) * t]);
  }
  return result;
}

/**
 * Scale/position-invariant distance between two paths' PROPORTIONS: both are resampled
 * to the same point count by arc-length fraction, each centered and normalized by its
 * own (outlier-robust, median) spread, then compared point-for-point BY INDEX.
 *
 * Tried an order-independent (nearest-point/Chamfer) version instead, on the theory that
 * index correspondence breaks down when a detour eats a disproportionate share of a
 * route's length. It made things worse: a wild detour's points often pass near *some*
 * other point on the original outline by pure chance, so nearest-point matching scored
 * those detours deceptively well. Order matters for a loop/path — index correspondence,
 * imperfect as it is, at least penalizes a route for going the wrong way.
 *
 * 0 = identical proportions, regardless of overall size or where either sits on the map.
 */
function shapeFidelity(original: LatLng[], candidate: LatLng[]): number {
  const n = FIDELITY_SAMPLE_POINTS;
  const a = resampleAlongPath(original, n);
  const b = resampleAlongPath(candidate, n);
  const centerA = centroidOf(a);
  const centerB = centroidOf(b);
  const radiusA = medianRadiusMeters(a, centerA) || 1;
  const radiusB = medianRadiusMeters(b, centerB) || 1;

  let sumSq = 0;
  let maxSq = 0;
  for (let i = 0; i < n; i++) {
    const pa = toLocalMeters(centerA, a[i]);
    const pb = toLocalMeters(centerB, b[i]);
    const dx = pa.x / radiusA - pb.x / radiusB;
    const dy = pa.y / radiusA - pb.y / radiusB;
    const d2 = dx * dx + dy * dy;
    sumSq += d2;
    if (d2 > maxSq) maxSq = d2;
  }
  // Blend average and worst-point error: a single severe localized detour (the common
  // real-world failure mode here — one bad snap sending part of the route far off
  // course) should clearly hurt the score even if most of the shape still tracks well,
  // which a pure average would dilute away.
  return 0.5 * Math.sqrt(sumSq / n) + 0.5 * Math.sqrt(maxSq);
}

/** Derives a corrective scale + offset from how far the last attempt's route drifted
 * (in size and position) from the original shape, and applies it to the original —
 * always re-derived from the original rather than compounded, so each retry is an
 * independent best-effort guess rather than an escalating one. */
function correctiveInput(original: LatLng[], lastRoute: LatLng[]): LatLng[] {
  const origCenter = centroidOf(original);
  const routeCenter = centroidOf(lastRoute);
  const origRadius = rmsRadiusMeters(original, origCenter);
  const routeRadius = rmsRadiusMeters(lastRoute, routeCenter);

  const rawScale = routeRadius > 1 ? origRadius / routeRadius : 1;
  const scale = Math.min(Math.max(rawScale, 0.5), 2); // sanity clamp against wild overcorrection

  // Pre-compensate for the direction the road network pulled the shape in, by offsetting
  // the opposite way.
  const driftLat = origCenter[0] - routeCenter[0];
  const driftLng = origCenter[1] - routeCenter[1];

  return original.map(([lat, lng]): LatLng => {
    const local = toLocalMeters(origCenter, [lat, lng]);
    const scaled = fromLocalMeters(origCenter, { x: local.x * scale, y: local.y * scale });
    return [scaled[0] + driftLat, scaled[1] + driftLng];
  });
}

interface FidelityScoredRoute {
  points: LatLng[];
  distanceMeters: number;
  fidelity: number;
}

/**
 * Snaps `startingInput` (a placement of `original`, possibly translated/unchanged) onto
 * the road network, retrying up to `maxAttempts` times with a corrective scale/offset
 * when a result comes out too distorted — and keeping whichever attempt best preserves
 * `original`'s proportions. Also guards against OSRM's observed per-request
 * non-determinism: identical input can occasionally come back with a wildly different
 * (badly snapped) route, so a second attempt gives a bad draw a chance to recover even
 * when there's no obvious distortion to correct for yet.
 */
async function bestEffortRoute(
  original: LatLng[],
  startingInput: LatLng[],
  maxAttempts: number
): Promise<FidelityScoredRoute> {
  let candidateInput = startingInput;
  let best: FidelityScoredRoute | null = null;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await delay(RATE_LIMIT_DELAY_MS);

    let result: MatchedRoute;
    try {
      result = await fetchRoute(simplifyToMax(candidateInput, MAX_ROUTE_WAYPOINTS));
    } catch (err) {
      lastError = err;
      break; // keep whatever we already have rather than losing it to a later failure
    }

    const fidelity = shapeFidelity(original, result.points);
    if (!best || fidelity < best.fidelity) {
      best = { points: result.points, distanceMeters: result.distanceMeters, fidelity };
    }
    if (fidelity <= GOOD_ENOUGH_FIDELITY || attempt === maxAttempts - 1) break;

    // Retry the exact same input first (OSRM non-determinism can simply recover on its
    // own), then fall back to a corrective nudge once there's a real distortion to read.
    candidateInput = attempt === 0 ? startingInput : correctiveInput(original, result.points);
  }

  if (!best) throw lastError;
  return best;
}

/**
 * Snaps a hand-drawn or typed point list onto the real pedestrian path network via OSRM.
 * Since road geometry rarely matches a drawn shape exactly, this makes a best effort to
 * preserve the shape's overall proportions: if the first snap comes out too distorted, it
 * retries with the input nudged by a corrective scale/offset inferred from that attempt,
 * and keeps whichever attempt's result most closely matches the original's proportions.
 */
export async function matchToRoads(points: LatLng[]): Promise<MatchedRoute> {
  if (simplifyToMax(points, MAX_ROUTE_WAYPOINTS).length < 2) {
    throw new RoutingError("Draw a longer shape before converting it to a route.");
  }
  return bestEffortRoute(points, points, MAX_ATTEMPTS);
}

// --- Best-fit search across the current viewport ---------------------------------
//
// "Find best fit" looks for the best place to put a shape within the map area the
// user is currently looking at. A drawn shape is rarely the exact size of whatever real
// path it's meant to trace, so this searches both SIZE and POSITION: several scale
// variants at the shape's own spot (since a real path nearby is usually close to the
// right place already, just not the right size), plus a small grid of other candidate
// positions at the original scale. Each is snapped and ranked by the same proportional
// shape-fidelity metric used above.

export interface FitCandidate {
  points: LatLng[];
  distanceMeters: number;
  fidelity: number;
  /** Scale applied to the original shape to produce this candidate (1 = unchanged). */
  scale: number;
}

/** Tracks an in-progress "find best fit" result set so the UI can step through it. */
export interface FitPickerState {
  shapeId: string;
  candidates: FitCandidate[];
  index: number;
}

const MAX_FIT_CANDIDATES = 10;
const MAX_GRID_CELLS_PER_AXIS = 2; // 2x2 grid of alternative positions, at the original scale
/** Scale variants tried at the shape's own spot — a real path nearby is usually close
 * to the right place already, just drawn the wrong size, so size gets more search
 * budget than position. Biased toward shrinking: a loosely hand-drawn shape tends to
 * overshoot the real path it's meant to trace more often than undershoot it. */
const SCALE_VARIANTS = [0.5, 0.65, 0.8, 1, 1.25, 1.5];

function boundsOfPoints(points: LatLng[]): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/** Scales the shape about its own centroid, then recenters it at `newCenter`. Scaling
 * about its own centroid leaves that centroid in place, so recentering afterward is a
 * plain translation regardless of the scale applied. */
function transformShape(points: LatLng[], newCenter: LatLng, scale: number): LatLng[] {
  const current = centroidOf(points);
  const dLat = newCenter[0] - current[0];
  const dLng = newCenter[1] - current[1];
  return points.map(([lat, lng]): LatLng => {
    const local = toLocalMeters(current, [lat, lng]);
    const rescaled = fromLocalMeters(current, { x: local.x * scale, y: local.y * scale });
    return [rescaled[0] + dLat, rescaled[1] + dLng];
  });
}

interface FitPlacement {
  center: LatLng;
  scale: number;
  /** True only for the one placement that's exactly where/how the user drew it —
   * unchanged position, scale 1 — which earns the full retry budget below. */
  isOriginal: boolean;
}

/** Candidate placements within the viewport: every scale variant at the shape's own
 * spot, plus a small grid of alternative positions (shrunk inward by the shape's own
 * half-size so every candidate keeps the whole shape inside the visible area) at the
 * original scale. Degrades to fewer positions when the shape is too big for the
 * viewport to offer meaningfully different placements. */
function candidatePlacements(points: LatLng[], viewport: ViewportBounds): FitPlacement[] {
  const currentCenter = centroidOf(points);
  const placements: FitPlacement[] = SCALE_VARIANTS.map((scale) => ({
    center: currentCenter,
    scale,
    isOriginal: scale === 1,
  }));

  const shapeBounds = boundsOfPoints(points);
  const halfWidth = (shapeBounds.maxLng - shapeBounds.minLng) / 2;
  const halfHeight = (shapeBounds.maxLat - shapeBounds.minLat) / 2;

  const usableWest = viewport.west + halfWidth;
  const usableEast = viewport.east - halfWidth;
  const usableSouth = viewport.south + halfHeight;
  const usableNorth = viewport.north - halfHeight;
  const usableWidth = usableEast - usableWest;
  const usableHeight = usableNorth - usableSouth;
  if (usableWidth <= 0 || usableHeight <= 0) return placements;

  const cols = Math.min(MAX_GRID_CELLS_PER_AXIS, Math.max(1, Math.floor(usableWidth / (halfWidth * 2)) + 1));
  const rows = Math.min(MAX_GRID_CELLS_PER_AXIS, Math.max(1, Math.floor(usableHeight / (halfHeight * 2)) + 1));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lng = cols === 1 ? (usableWest + usableEast) / 2 : usableWest + (c / (cols - 1)) * usableWidth;
      const lat = rows === 1 ? (usableSouth + usableNorth) / 2 : usableSouth + (r / (rows - 1)) * usableHeight;
      const isDup = Math.abs(lat - currentCenter[0]) < 1e-7 && Math.abs(lng - currentCenter[1]) < 1e-7;
      if (!isDup) placements.push({ center: [lat, lng], scale: 1, isOriginal: false });
    }
  }

  return placements.slice(0, MAX_FIT_CANDIDATES + SCALE_VARIANTS.length);
}

/** Per-candidate attempt budget for findBestFit: a second try at the same spot gives a
 * one-off bad snap/tie-break a chance to recover (see bestEffortRoute), without the full
 * 3-attempt budget matchToRoads uses — at 10 candidates, that's already up to 20 of the
 * ~1 req/sec rate-limited calls. */
const MAX_FIT_ATTEMPTS_PER_CANDIDATE = 2;
/** A candidate must score at least this well to be shown at all. Looser than
 * GOOD_ENOUGH_FIDELITY (which just stops matchToRoads from retrying further), since the
 * point here is filtering out options that plainly don't look like the original shape —
 * better to honestly return fewer than 10 options than pad the list with distorted ones
 * just to hit the count. Empirically chosen, not derived. */
const ACCEPTABLE_FIT_FIDELITY = 0.5;
/** Once the local road cache (roadCache.ts) is loaded, speculative candidates are
 * ranked by a free, instant local estimate first, and only this many of the
 * best-looking ones are actually sent to OSRM — cutting the typical OSRM call count
 * roughly in half without ever showing a candidate that wasn't really routed. The
 * user's own placement is exempt from this cap; it's always tried regardless. */
const MAX_OSRM_CANDIDATES_AFTER_PREFILTER = 5;

/** Instant, local-only fidelity estimate for ranking candidates before spending any
 * OSRM calls: snaps the path to nearby cached road vertices (same connectivity-aware
 * lookup the drag-time preview uses — see roadCache.ts) rather than a real connected
 * route, then scores that against the original with the same metric used for real
 * results. Cheap and rough — good enough to prioritize which candidates are worth a
 * real OSRM call, not to present as a final answer on its own. */
function roughFidelityEstimate(original: LatLng[], transformed: LatLng[]): number {
  return shapeFidelity(original, roughSnapPath(transformed));
}

/** If the local road cache covers enough candidates to make it worthwhile, ranks the
 * speculative (non-original) placements by the free local estimate and keeps only the
 * most promising ones, deferring every real OSRM call until this trim has happened. */
function prefilterPlacements(points: LatLng[], placements: FitPlacement[]): FitPlacement[] {
  if (!hasRoadNetwork() || placements.length <= MAX_OSRM_CANDIDATES_AFTER_PREFILTER) return placements;

  const original = placements.filter((p) => p.isOriginal);
  const budget = Math.max(MAX_OSRM_CANDIDATES_AFTER_PREFILTER - original.length, 0);
  const bestAlternatives = placements
    .filter((p) => !p.isOriginal)
    .map((placement) => ({
      placement,
      roughFidelity: roughFidelityEstimate(points, transformShape(points, placement.center, placement.scale)),
    }))
    .sort((a, b) => a.roughFidelity - b.roughFidelity)
    .slice(0, budget)
    .map(({ placement }) => placement);

  return [...original, ...bestAlternatives];
}

/** Within this many meters AND this close in total length, two candidates are treated
 * as the same real route rather than distinct options — different candidate inputs
 * (a different scale, a slightly different spot) sometimes converge on the exact same
 * nearby path once OSRM snaps them. Empirically chosen, not derived. */
const DUPLICATE_CENTROID_TOLERANCE_M = 15;
const DUPLICATE_LENGTH_TOLERANCE_RATIO = 0.03;

function routesAreDuplicates(a: FitCandidate, b: FitCandidate): boolean {
  const lengthTolerance = Math.max(a.distanceMeters, b.distanceMeters) * DUPLICATE_LENGTH_TOLERANCE_RATIO;
  if (Math.abs(a.distanceMeters - b.distanceMeters) > Math.max(lengthTolerance, 10)) return false;
  return haversineMeters(centroidOf(a.points), centroidOf(b.points)) <= DUPLICATE_CENTROID_TOLERANCE_M;
}

/** Collapses candidates that snapped to the same real route into one, keeping whichever
 * copy scored best. Must run on the final, OSRM-routed results — two routes that
 * happen to be the same real path can still arrive with slightly different fidelity
 * scores (OSRM's own non-determinism), so this can't be deduped any earlier. */
function dedupeByRoute(candidates: FitCandidate[]): FitCandidate[] {
  const unique: FitCandidate[] = [];
  for (const candidate of candidates) {
    const matchIndex = unique.findIndex((u) => routesAreDuplicates(u, candidate));
    if (matchIndex === -1) unique.push(candidate);
    else if (candidate.fidelity < unique[matchIndex].fidelity) unique[matchIndex] = candidate;
  }
  return unique;
}

/**
 * Searches the current map viewport for good places to put `points`, returning up to
 * 10 candidate routes ranked best-first by how closely each preserves the original
 * shape's proportions, with duplicates (different candidates that snapped to the same
 * real route) collapsed into one. Candidates that fail to snap at all (e.g. open
 * water), or whose best attempt still doesn't look enough like the original, are
 * dropped rather than padding out the result with options that plainly don't fit.
 */
export async function findBestFit(points: LatLng[], viewport: ViewportBounds): Promise<FitCandidate[]> {
  const placements = prefilterPlacements(points, candidatePlacements(points, viewport));
  const scored: FitCandidate[] = [];

  for (let i = 0; i < placements.length; i++) {
    if (i > 0) await delay(RATE_LIMIT_DELAY_MS);
    const placement = placements[i];
    const transformed = transformShape(points, placement.center, placement.scale);
    // The exact unchanged placement is where the user actually drew it, not a
    // speculative alternative like the rest, so it gets the same full retry budget as
    // a direct "Convert to route" call instead of the cheaper per-candidate one.
    const attempts = placement.isOriginal ? MAX_ATTEMPTS : MAX_FIT_ATTEMPTS_PER_CANDIDATE;
    try {
      const result = await bestEffortRoute(points, transformed, attempts);
      if (result.fidelity <= ACCEPTABLE_FIT_FIDELITY) scored.push({ ...result, scale: placement.scale });
    } catch {
      // No viable route at this candidate spot — skip it, not the whole search.
    }
  }

  return dedupeByRoute(scored).sort((a, b) => a.fidelity - b.fidelity);
}
