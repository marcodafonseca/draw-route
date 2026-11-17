import L from "leaflet";
import "leaflet-draw";

// biome-ignore-all: leaflet-draw ships no types for these private prototype members.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

let installed = false;

/**
 * Patches leaflet-draw's private drawing internals. There's no public extension point
 * for any of this, so these all monkey-patch prototype methods or library functions.
 */
export function installLeafletDrawPatches(): void {
  if (installed) return;
  installed = true;

  installCornerCircleDraw();
  installReadableAreaFix();
  installVertexSnap();
}

/**
 * leaflet-draw's circle tool only draws center-outward (click = center, drag = radius).
 * We want corner-to-corner as the default instead — click = one corner of a bounding box,
 * drag to the opposite corner, circle inscribed in that box — since that's the more
 * intuitive way to size a circle over a target area on a map. Holding Alt restores the
 * original center-outward behavior.
 */
function installCornerCircleDraw(): void {
  const DrawCircle = (L as any).Draw.Circle;
  const SimpleShapeProto = (L as any).Draw.SimpleShape.prototype;

  DrawCircle.prototype._onMouseMove = function (this: any, e: L.LeafletMouseEvent) {
    this._lastAltKey = Boolean((e as unknown as { originalEvent: MouseEvent }).originalEvent?.altKey);

    const latlng = e.latlng;
    const showRadius = this.options.showRadius;
    const useMetric = this.options.metric;

    this._tooltip.updatePosition(latlng);
    if (this._isDrawing) {
      this._drawShape(latlng);

      const radius = this._shape.getRadius().toFixed(1);
      let subtext = "";
      if (showRadius) {
        subtext =
          `${(L as any).drawLocal.draw.handlers.circle.radius}: ` +
          (L as any).GeometryUtil.readableDistance(radius, useMetric, this.options.feet, this.options.nautic);
      }
      this._tooltip.updateContent({ text: this._endLabelText, subtext });
    }
  } as AnyFn;

  DrawCircle.prototype._drawShape = function (this: any, latlng: L.LatLng) {
    const map = this._map;
    const start = this._startLatLng as L.LatLng;

    const center = this._lastAltKey
      ? start
      : L.latLng((start.lat + latlng.lat) / 2, (start.lng + latlng.lng) / 2);
    const radius = this._lastAltKey
      ? map.distance(start, latlng)
      : map.distance(start, latlng) / 2;

    if (!this._shape) {
      this._shape = new L.Circle(center, radius, this.options.shapeOptions);
      map.addLayer(this._shape);
    } else {
      this._shape.setLatLng(center);
      this._shape.setRadius(radius);
    }
  } as AnyFn;

  DrawCircle.prototype._fireCreatedEvent = function (this: any) {
    const circle = new L.Circle(this._shape.getLatLng(), this._shape.getRadius(), this.options.shapeOptions);
    SimpleShapeProto._fireCreatedEvent.call(this, circle);
  } as AnyFn;

  (L as any).drawLocal.draw.handlers.circle.tooltip.start =
    "Click and drag to draw a circle (hold Alt to draw from the center).";
}

const AREA_PRECISION = { km: 2, ha: 2, m: 0, mi: 2, ac: 2, yd: 0, ft: 0, nm: 2 };

/**
 * leaflet-draw 1.0.4's GeometryUtil.readableArea has a bug: `type = typeof isMetric`
 * (src/leaflet.draw.js) is missing its `var`, which throws "type is not defined" under
 * strict mode (ES modules, i.e. every Vite bundle) the moment it's hit — which is on the
 * *second* mousemove of drawing any rectangle or polygon (the first has no shape yet to
 * measure, so the buggy branch is skipped once, then thrown on every move after). That
 * freezes the shape at whatever bounds existed after the first move instead of following
 * the cursor. Patches in a corrected copy of the same logic.
 */
function installReadableAreaFix(): void {
  (L as any).GeometryUtil.readableArea = function (
    area: number,
    isMetric: boolean | string | string[],
    precision?: Record<string, number>
  ): string {
    const mergedPrecision = L.Util.extend({}, AREA_PRECISION, precision);
    let areaStr: string;

    if (isMetric) {
      let units: string | string[] = ["ha", "m"];
      const kind = typeof isMetric;
      if (kind === "string") {
        units = [isMetric as string];
      } else if (kind !== "boolean") {
        units = isMetric as string[];
      }

      if (area >= 1000000 && units.indexOf("km") !== -1) {
        areaStr = `${(L as any).GeometryUtil.formattedNumber(area * 0.000001, mergedPrecision.km)} km²`;
      } else if (area >= 10000 && units.indexOf("ha") !== -1) {
        areaStr = `${(L as any).GeometryUtil.formattedNumber(area * 0.0001, mergedPrecision.ha)} ha`;
      } else {
        areaStr = `${(L as any).GeometryUtil.formattedNumber(area, mergedPrecision.m)} m²`;
      }
    } else {
      const yd = area / 0.836127;
      if (yd >= 3097600) {
        areaStr = `${(L as any).GeometryUtil.formattedNumber(yd / 3097600, mergedPrecision.mi)} mi²`;
      } else if (yd >= 4840) {
        areaStr = `${(L as any).GeometryUtil.formattedNumber(yd / 4840, mergedPrecision.ac)} acres`;
      } else {
        areaStr = `${(L as any).GeometryUtil.formattedNumber(yd, mergedPrecision.yd)} yd²`;
      }
    }

    return areaStr;
  } as AnyFn;
}

/** Clicking within this many pixels of an already-placed vertex reuses its exact
 * coordinates instead of placing a new, barely-different point nearby. */
const VERTEX_SNAP_RADIUS_PX = 12;

/**
 * Lets a line (or polygon) route revisit an earlier point in the same in-progress
 * drawing exactly — e.g. an out-and-back route, or a loop that crosses itself at a
 * shared waypoint — by clicking on (or near) the small vertex marker leaflet-draw
 * already shows for each placed point.
 *
 * Two parts, because of how leaflet-draw actually receives clicks:
 * 1. addVertex() is the choke-point every click funnels through on the common path
 *    (via the invisible full-size "mouse marker" that catches clicks anywhere on the
 *    map) — patching it snaps a click that lands *near* an existing vertex, within
 *    VERTEX_SNAP_RADIUS_PX, onto that vertex's exact coordinates.
 * 2. That alone turned out not to be enough: confirmed live (by tracing every
 *    mouse/touch handler) that a click landing directly on an *existing marker's own
 *    icon* never reaches the mouse-marker catcher at all — the icon's own DOM element
 *    intercepts it first, so addVertex() above never even runs for the single most
 *    likely case (clicking right on the dot you want to revisit). _createMarker() is
 *    patched to add that missing behavior directly on each marker's own click.
 */
function installVertexSnap(): void {
  const proto = (L as any).Draw.Polyline.prototype;

  const originalAddVertex = proto.addVertex;
  proto.addVertex = function (this: any, latlng: L.LatLng) {
    originalAddVertex.call(this, findExistingVertexNear(this, latlng) ?? latlng);
  } as AnyFn;

  const originalCreateMarker = proto._createMarker;
  proto._createMarker = function (this: any, latlng: L.LatLng) {
    const marker: L.Marker = originalCreateMarker.call(this, latlng);
    marker.on("click", (e: L.LeafletMouseEvent) => {
      // The current last marker already has its own click-to-finish behavior
      // (leaflet-draw's _updateFinishHandler) — leave that alone. Any earlier marker
      // becomes "revisit this point": add a vertex here, exactly, same as clicking
      // near it would via addVertex() above, just reachable at all this way.
      const markers = this._markers as L.Marker[] | undefined;
      if (!markers || markers[markers.length - 1] === marker) return;
      L.DomEvent.stop(e);
      this.addVertex(marker.getLatLng());
    });
    return marker;
  } as AnyFn;
}

function findExistingVertexNear(handler: { _markers?: L.Marker[]; _map?: L.Map }, latlng: L.LatLng): L.LatLng | null {
  const markers = handler._markers;
  const map = handler._map;
  if (!markers || !map || markers.length === 0) return null;

  const clickPt = map.latLngToContainerPoint(latlng);
  let nearest: L.LatLng | null = null;
  let nearestDist = VERTEX_SNAP_RADIUS_PX;

  for (const marker of markers) {
    const markerLatLng = marker.getLatLng();
    const dist = map.latLngToContainerPoint(markerLatLng).distanceTo(clickPt);
    if (dist <= nearestDist) {
      nearestDist = dist;
      nearest = markerLatLng;
    }
  }
  return nearest;
}
