import L from "leaflet";
import type { LatLng, ShapeKind } from "../types";

const CIRCLE_SEGMENTS = 48;
const EARTH_RADIUS_M = 6371000;

/** Destination point from a center, given a bearing (radians) and distance (meters). */
export function destinationPoint(center: L.LatLng, distanceM: number, bearingRad: number): LatLng {
  const lat1 = (center.lat * Math.PI) / 180;
  const lng1 = (center.lng * Math.PI) / 180;
  const angularDist = distanceM / EARTH_RADIUS_M;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDist) +
      Math.cos(lat1) * Math.sin(angularDist) * Math.cos(bearingRad)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angularDist) * Math.cos(lat1),
      Math.cos(angularDist) - Math.sin(lat1) * Math.sin(lat2)
    );

  return [(lat2 * 180) / Math.PI, (((lng2 * 180) / Math.PI + 540) % 360) - 180];
}

function circleToPoints(layer: L.Circle): LatLng[] {
  const center = layer.getLatLng();
  const radius = layer.getRadius();
  const points: LatLng[] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const bearing = (i / CIRCLE_SEGMENTS) * 2 * Math.PI;
    points.push(destinationPoint(center, radius, bearing));
  }
  return points;
}

/** Leaflet's getLatLngs() nests rings for polygons but is flat for polylines; normalize both. */
function flattenRing(latlngs: unknown): L.LatLng[] {
  if (Array.isArray(latlngs) && latlngs.length > 0 && Array.isArray(latlngs[0])) {
    return flattenRing(latlngs[0]);
  }
  return latlngs as L.LatLng[];
}

export function closeLoop(points: LatLng[]): LatLng[] {
  if (points.length === 0) return points;
  const [firstLat, firstLng] = points[0];
  const [lastLat, lastLng] = points[points.length - 1];
  if (firstLat === lastLat && firstLng === lastLng) return points;
  return [...points, points[0]];
}

export interface ExtractedShape {
  kind: ShapeKind;
  points: LatLng[];
}

/** Converts a leaflet-draw created layer into an ordered lat/lng point list. */
export function shapeToPoints(layer: L.Layer): ExtractedShape | null {
  if (layer instanceof L.Circle) {
    return { kind: "circle", points: closeLoop(circleToPoints(layer)) };
  }
  if (layer instanceof L.Rectangle) {
    const ring = flattenRing((layer as L.Polygon).getLatLngs());
    return { kind: "rectangle", points: closeLoop(ring.map((p): LatLng => [p.lat, p.lng])) };
  }
  if (layer instanceof L.Polygon) {
    const ring = flattenRing(layer.getLatLngs());
    return { kind: "polygon", points: closeLoop(ring.map((p): LatLng => [p.lat, p.lng])) };
  }
  if (layer instanceof L.Polyline) {
    const line = flattenRing(layer.getLatLngs());
    return { kind: "polyline", points: line.map((p): LatLng => [p.lat, p.lng]) };
  }
  return null;
}
