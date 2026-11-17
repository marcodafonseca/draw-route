import L from "leaflet";
import type { LatLng } from "../types";

/**
 * Reduces a point list toward a target count using Douglas-Peucker (via Leaflet's
 * own implementation). Lat/lng is treated as plain Euclidean space, which is fine
 * for the small distances involved in a single hand-drawn route.
 */
export function simplifyToMax(points: LatLng[], maxPoints: number): LatLng[] {
  if (points.length <= maxPoints) return points;

  let tolerance = 0.00005;
  let result = points;
  for (let i = 0; i < 20 && result.length > maxPoints; i++) {
    const asLeafletPoints = points.map((p) => L.point(p[1], p[0]));
    const simplified = L.LineUtil.simplify(asLeafletPoints, tolerance);
    result = simplified.map((p): LatLng => [p.y, p.x]);
    tolerance *= 1.6;
  }
  return result;
}
