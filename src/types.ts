export type LatLng = [number, number];

export type ShapeKind = "polyline" | "polygon" | "rectangle" | "circle";

export interface DrawnShape {
  id: string;
  kind: ShapeKind;
  /** Ordered lat/lng points as drawn (closed loop for polygon/rectangle/circle). */
  points: LatLng[];
  createdAt: number;
  /** Shapes sharing a groupId (e.g. all contours of one typed word) drag together as a unit. Defaults to own id. */
  groupId?: string;
}

/** The map's current visible area, in plain lat/lng degrees (kept Leaflet-free so
 * routing/search logic doesn't need to import Leaflet types). */
export interface ViewportBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface RouteResult {
  id: string;
  sourceShapeId: string;
  /** Matched (or, when unsnapped, raw) lat/lng points for the final route. */
  points: LatLng[];
  distanceMeters: number;
  snapped: boolean;
  createdAt: number;
}
