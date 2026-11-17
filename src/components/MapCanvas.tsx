import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, TileLayer, Polygon, Polyline, useMap, useMapEvent } from "react-leaflet";
import DrawControl from "./DrawControl";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "../lib/constants";
import { ensureRoadNetworkLoaded, hasRoadNetwork, roughSnapPath } from "../lib/roadCache";
import type { DrawnShape, LatLng, RouteResult, ViewportBounds } from "../types";

export interface ShapeMoveUpdate {
  shapeId: string;
  points: LatLng[];
}

interface MapCanvasProps {
  shapes: DrawnShape[];
  routes: RouteResult[];
  selectedShapeIds: ReadonlySet<string>;
  loadingShapeIds: ReadonlySet<string>;
  onShapeCreated: (shape: DrawnShape) => void;
  onCenterChange: (center: LatLng) => void;
  onBoundsChange: (bounds: ViewportBounds) => void;
  onShapesMoved: (updates: ShapeMoveUpdate[]) => void;
  onSelectionChange: (next: Set<string>) => void;
}

function toViewportBounds(bounds: L.LatLngBounds): ViewportBounds {
  return {
    north: bounds.getNorth(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    west: bounds.getWest(),
  };
}

function ViewportReporter({
  onCenterChange,
  onBoundsChange,
}: {
  onCenterChange: (center: LatLng) => void;
  onBoundsChange: (bounds: ViewportBounds) => void;
}) {
  const map = useMap();

  useEffect(() => {
    const center = map.getCenter();
    const bounds = toViewportBounds(map.getBounds());
    onCenterChange([center.lat, center.lng]);
    onBoundsChange(bounds);
    ensureRoadNetworkLoaded(bounds);
    // Intentionally run once on mount only; "moveend" below covers later changes,
    // and the callbacks must stay out of the deps or non-memoized props would loop.
  }, []);

  useMapEvent("moveend", () => {
    const center = map.getCenter();
    const bounds = toViewportBounds(map.getBounds());
    onCenterChange([center.lat, center.lng]);
    onBoundsChange(bounds);
    ensureRoadNetworkLoaded(bounds);
  });

  return null;
}

function LocateControl() {
  const map = useMap();

  const handleLocate = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      map.flyTo([pos.coords.latitude, pos.coords.longitude], 15);
    });
  };

  return (
    <button className="locate-btn" onClick={handleLocate} title="Use my location">
      📍
    </button>
  );
}

function routeIdForShape(shapeId: string, routes: RouteResult[]): RouteResult | undefined {
  return routes.find((r) => r.sourceShapeId === shapeId);
}

interface ShapesLayerProps {
  shapes: DrawnShape[];
  routes: RouteResult[];
  selectedShapeIds: ReadonlySet<string>;
  loadingShapeIds: ReadonlySet<string>;
  onShapesMoved: (updates: ShapeMoveUpdate[]) => void;
  onSelectionChange: (next: Set<string>) => void;
}

function groupIdsFor(shape: DrawnShape, shapes: DrawnShape[]): string[] {
  const groupKey = shape.groupId ?? shape.id;
  return shapes.filter((s) => (s.groupId ?? s.id) === groupKey).map((s) => s.id);
}

function centroidOfPoints(points: LatLng[]): LatLng {
  let sumLat = 0;
  let sumLng = 0;
  for (const [lat, lng] of points) {
    sumLat += lat;
    sumLng += lng;
  }
  return [sumLat / points.length, sumLng / points.length];
}

const LOADER_ICON = L.divIcon({
  className: "shape-loader-icon",
  html: '<div class="shape-loader-spinner"></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const OPPOSITE_CORNER: Record<Corner, Corner> = { nw: "se", se: "nw", ne: "sw", sw: "ne" };
const CORNER_CURSOR_CLASS: Record<Corner, string> = {
  nw: "resize-cursor-nwse",
  se: "resize-cursor-nwse",
  ne: "resize-cursor-nesw",
  sw: "resize-cursor-nesw",
};

function cornerIcon(corner: Corner): L.DivIcon {
  return L.divIcon({
    className: `resize-handle ${CORNER_CURSOR_CLASS[corner]}`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

const VERTEX_ICON = L.divIcon({
  className: "vertex-handle",
  iconSize: [10, 10],
  iconAnchor: [5, 5],
});

/** Indices of `points` worth showing a draggable vertex handle for, plus which OTHER
 * index (if any) must mirror a drag at that index — a closed loop's last point is a
 * duplicate of its first (so the shape renders as a closed ring), so it's skipped here
 * to avoid two overlapping handles, and dragging the first point's handle has to move
 * both ends to keep the ring closed. */
function editableVertexIndices(points: LatLng[]): Array<{ index: number; mirrorIndex: number | null }> {
  if (points.length < 2) return points.map((_, index) => ({ index, mirrorIndex: null }));

  const last = points.length - 1;
  const isClosedLoop = points[0][0] === points[last][0] && points[0][1] === points[last][1];
  const indices = isClosedLoop ? points.slice(0, last).map((_, i) => i) : points.map((_, i) => i);

  return indices.map((index) => ({ index, mirrorIndex: isClosedLoop && index === 0 ? last : null }));
}

function selectionBounds(shapes: DrawnShape[], selectedShapeIds: ReadonlySet<string>): L.LatLngBounds | null {
  let bounds: L.LatLngBounds | null = null;
  for (const shape of shapes) {
    if (!selectedShapeIds.has(shape.id)) continue;
    for (const point of shape.points) {
      bounds = bounds ? bounds.extend(point) : L.latLngBounds(point, point);
    }
  }
  return bounds;
}

function cornerLatLng(bounds: L.LatLngBounds, corner: Corner): L.LatLng {
  const lat = corner[0] === "n" ? bounds.getNorth() : bounds.getSouth();
  const lng = corner[1] === "w" ? bounds.getWest() : bounds.getEast();
  return L.latLng(lat, lng);
}

/** The pixel position of each bbox corner, given where the dragged corner and its
 * fixed diagonal opposite (anchor) currently sit — used to keep the other two resize
 * handles visually tracking the live (uncommitted) bounding box during a resize drag. */
function cornerPixelsDuringResize(
  draggedCorner: Corner,
  anchorPt: L.Point,
  draggedPt: L.Point
): Record<Corner, L.Point> {
  const north = draggedCorner[0] === "n" ? draggedPt.y : anchorPt.y;
  const south = draggedCorner[0] === "n" ? anchorPt.y : draggedPt.y;
  const west = draggedCorner[1] === "w" ? draggedPt.x : anchorPt.x;
  const east = draggedCorner[1] === "w" ? anchorPt.x : draggedPt.x;
  return {
    nw: L.point(west, north),
    ne: L.point(east, north),
    sw: L.point(west, south),
    se: L.point(east, south),
  };
}

interface ResizeSession {
  corner: Corner;
  anchorPt: L.Point;
  spanX: number;
  spanY: number;
  originals: Map<string, LatLng[]>;
}

interface VertexDragSession {
  shapeId: string;
  index: number;
  mirrorIndex: number | null;
  originalPoints: LatLng[];
}

/**
 * With Alt held, constrains the dragged corner onto the diagonal through the anchor
 * (projecting the raw cursor point onto that line), so the resulting sx/sy scale
 * factors come out identical — i.e. aspect-ratio-locked — without applyResize needing
 * to know about aspect locking at all.
 */
function effectiveDraggedPoint(session: ResizeSession, rawPt: L.Point, lockAspect: boolean): L.Point {
  if (!lockAspect) return rawPt;
  const spanLenSq = session.spanX * session.spanX + session.spanY * session.spanY;
  if (spanLenSq === 0) return rawPt;
  const dot = (rawPt.x - session.anchorPt.x) * session.spanX + (rawPt.y - session.anchorPt.y) * session.spanY;
  const s = dot / spanLenSq;
  return L.point(session.anchorPt.x + session.spanX * s, session.anchorPt.y + session.spanY * s);
}

function altKeyHeld(e: L.LeafletEvent): boolean {
  return Boolean((e as unknown as { originalEvent?: MouseEvent }).originalEvent?.altKey);
}

/**
 * Clears a "suppress the next map click" flag shortly after a drag ends, regardless of
 * whether a spurious click actually shows up to consume it. Confirmed live that it's
 * inconsistent which drag gestures produce one — a shape move or corner-resize drag
 * reliably does, but a vertex-handle drag doesn't — so relying on a spurious click to
 * reset the flag left it permanently armed after a vertex edit, silently eating the
 * next *real* click (e.g. an attempt to deselect). A same-tick timeout clears it either
 * way: if a spurious click does land first, it's consumed as before (redundant no-op
 * here); if not, this is what actually resets it before any later, genuine click.
 */
function releaseClickSuppressionSoon(ref: { current: boolean }): void {
  setTimeout(() => {
    ref.current = false;
  }, 0);
}

/**
 * Renders drawn shapes, with full click-anywhere-inside dragging and multi-select:
 * - Closed shapes (polygon/rectangle/circle) render as Polygon with a near-invisible fill
 *   so clicks inside the interior (not just on the border line) grab the shape.
 * - Shapes sharing a groupId (e.g. every contour of one typed word) always move and
 *   (de)select together as a unit.
 * - Plain click selects just the clicked group (replacing the selection), unless it's
 *   already part of the current selection, in which case the whole selection drags together.
 * - Shift-click toggles the clicked group in/out of the selection without starting a drag.
 * - Clicking empty map clears the selection (bubblingMouseEvents:false keeps shape clicks
 *   from reaching this; a one-shot suppress flag also eats the spurious map click that can
 *   follow a drag that ends off of any shape).
 * Drag feedback is applied straight to the Leaflet layers via setLatLngs (bypassing React)
 * for a smooth 1:1 cursor follow; only the final position is committed to React state.
 * - When the selection is non-empty, 4 draggable corner handles appear at its bounding
 *   box; dragging one resizes the whole selection, anchored at the opposite corner.
 *   Holding Alt locks the aspect ratio.
 */
/** Polyline and Polygon instances aren't mutually assignable once their generics are
 * involved (their toGeoJSON() return types diverge), but setLatLngs is all drag needs. */
interface DraggableLayer {
  setLatLngs(latlngs: LatLng[]): unknown;
}

function ShapesLayer({
  shapes,
  routes,
  selectedShapeIds,
  loadingShapeIds,
  onShapesMoved,
  onSelectionChange,
}: ShapesLayerProps) {
  const map = useMap();
  const layerRefs = useRef(new Map<string, DraggableLayer>());
  const markerRefs = useRef<Record<Corner, L.Marker | null>>({ nw: null, ne: null, sw: null, se: null });
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const vertexDragSessionRef = useRef<VertexDragSession | null>(null);
  const suppressNextClickRef = useRef(false);
  // Hidden for the duration of any move/resize drag, since the handles would otherwise
  // sit at the stale (pre-commit) bbox position while the live preview moves underneath.
  const [handlesHidden, setHandlesHidden] = useState(false);

  const startDrag = useCallback(
    (dragIds: string[], e: L.LeafletMouseEvent) => {
      const originals = new Map(
        shapes.filter((s) => dragIds.includes(s.id)).map((s) => [s.id, s.points])
      );
      const startLatLng = e.latlng;

      const wasDraggable = map.dragging.enabled();
      map.dragging.disable();
      setHandlesHidden(true);

      // Rough, local-only live preview: snap each dragged shape's points to the
      // nearest cached road vertex (no network calls during the drag itself — see
      // roadCache.ts) and show it as a thin dashed line, purely a quick visual hint for
      // manually finding a promising spot. "Convert to route" / "Find best fit" still
      // do the real, accurate OSRM snap once you let go.
      const previewLayers = new Map<string, L.Polyline>();
      for (const id of dragIds) {
        const preview = L.polyline([], {
          color: "#f59e0b",
          weight: 2,
          dashArray: "4 4",
          interactive: false,
        }).addTo(map);
        previewLayers.set(id, preview);
      }

      const applyDelta = (dLat: number, dLng: number) => {
        for (const id of dragIds) {
          const layer = layerRefs.current.get(id);
          const original = originals.get(id);
          if (!layer || !original) continue;
          const moved = original.map(([lat, lng]): LatLng => [lat + dLat, lng + dLng]);
          layer.setLatLngs(moved);

          const preview = previewLayers.get(id);
          if (!preview) continue;
          // No road data loaded at all yet — leave the preview empty rather than
          // drawing a "snap" that's secretly just an exact copy of the shape's own
          // outline, which looks like nothing happened at all. Individual points with
          // no nearby road (e.g. a corner over open water) still fall back to their
          // raw position — only the whole-network case is worth hiding.
          preview.setLatLngs(hasRoadNetwork() ? roughSnapPath(moved) : []);
        }
      };

      const onMove = (ev: L.LeafletMouseEvent) => {
        applyDelta(ev.latlng.lat - startLatLng.lat, ev.latlng.lng - startLatLng.lng);
      };

      const onUp = (ev: L.LeafletMouseEvent) => {
        map.off("mousemove", onMove);
        map.off("mouseup", onUp);
        if (wasDraggable) map.dragging.enable();
        setHandlesHidden(false);
        for (const preview of previewLayers.values()) preview.remove();
        releaseClickSuppressionSoon(suppressNextClickRef);

        const dLat = ev.latlng.lat - startLatLng.lat;
        const dLng = ev.latlng.lng - startLatLng.lng;
        if (dLat === 0 && dLng === 0) return;

        applyDelta(dLat, dLng);
        onShapesMoved(
          dragIds.map((id) => ({
            shapeId: id,
            points: originals.get(id)!.map(([lat, lng]): LatLng => [lat + dLat, lng + dLng]),
          }))
        );
      };

      map.on("mousemove", onMove);
      map.on("mouseup", onUp);
    },
    [map, shapes, onShapesMoved]
  );

  const applyResize = useCallback(
    (session: ResizeSession, currentPt: L.Point): ShapeMoveUpdate[] => {
      const sx = session.spanX === 0 ? 1 : (currentPt.x - session.anchorPt.x) / session.spanX;
      const sy = session.spanY === 0 ? 1 : (currentPt.y - session.anchorPt.y) / session.spanY;

      const updates: ShapeMoveUpdate[] = [];
      for (const [id, points] of session.originals) {
        const newPoints = points.map(([lat, lng]): LatLng => {
          const p = map.latLngToContainerPoint([lat, lng]);
          const nx = session.anchorPt.x + (p.x - session.anchorPt.x) * sx;
          const ny = session.anchorPt.y + (p.y - session.anchorPt.y) * sy;
          const ll = map.containerPointToLatLng(L.point(nx, ny));
          return [ll.lat, ll.lng];
        });
        layerRefs.current.get(id)?.setLatLngs(newPoints);
        updates.push({ shapeId: id, points: newPoints });
      }
      return updates;
    },
    [map]
  );

  const handleCornerDragStart = useCallback(
    (corner: Corner) => {
      suppressNextClickRef.current = true;

      const bounds = selectionBounds(shapes, selectedShapeIds);
      if (!bounds) return;

      const anchorPt = map.latLngToContainerPoint(cornerLatLng(bounds, OPPOSITE_CORNER[corner]));
      const draggedOrigPt = map.latLngToContainerPoint(cornerLatLng(bounds, corner));

      resizeSessionRef.current = {
        corner,
        anchorPt,
        spanX: draggedOrigPt.x - anchorPt.x,
        spanY: draggedOrigPt.y - anchorPt.y,
        originals: new Map(
          shapes.filter((s) => selectedShapeIds.has(s.id)).map((s) => [s.id, s.points])
        ),
      };
    },
    [map, shapes, selectedShapeIds]
  );

  const handleCornerDrag = useCallback(
    (corner: Corner, e: L.LeafletEvent) => {
      const session = resizeSessionRef.current;
      if (!session) return;
      const marker = e.target as L.Marker;
      const rawPt = map.latLngToContainerPoint(marker.getLatLng());
      const effectivePt = effectiveDraggedPoint(session, rawPt, altKeyHeld(e));
      applyResize(session, effectivePt);

      // Re-snap every handle (including the dragged one, when aspect-locked it no longer
      // sits exactly under the raw cursor) to the live, possibly-constrained bbox.
      const pixelCorners = cornerPixelsDuringResize(corner, session.anchorPt, effectivePt);
      for (const key of CORNERS) {
        markerRefs.current[key]?.setLatLng(map.containerPointToLatLng(pixelCorners[key]));
      }
    },
    [map, applyResize]
  );

  const handleCornerDragEnd = useCallback(
    (e: L.LeafletEvent) => {
      releaseClickSuppressionSoon(suppressNextClickRef);
      const session = resizeSessionRef.current;
      resizeSessionRef.current = null;
      if (!session) return;
      const marker = e.target as L.Marker;
      const rawPt = map.latLngToContainerPoint(marker.getLatLng());
      const effectivePt = effectiveDraggedPoint(session, rawPt, altKeyHeld(e));
      onShapesMoved(applyResize(session, effectivePt));
    },
    [map, applyResize, onShapesMoved]
  );

  const handleVertexDragStart = useCallback(
    (shapeId: string, index: number, mirrorIndex: number | null) => {
      suppressNextClickRef.current = true;
      const shape = shapes.find((s) => s.id === shapeId);
      if (!shape) return;
      vertexDragSessionRef.current = { shapeId, index, mirrorIndex, originalPoints: shape.points };
    },
    [shapes]
  );

  const vertexPointsFor = (session: VertexDragSession, latlng: L.LatLng): LatLng[] => {
    const next = [...session.originalPoints];
    next[session.index] = [latlng.lat, latlng.lng];
    if (session.mirrorIndex !== null) next[session.mirrorIndex] = [latlng.lat, latlng.lng];
    return next;
  };

  const handleVertexDrag = useCallback(
    (e: L.LeafletEvent) => {
      const session = vertexDragSessionRef.current;
      if (!session) return;
      const marker = e.target as L.Marker;
      layerRefs.current.get(session.shapeId)?.setLatLngs(vertexPointsFor(session, marker.getLatLng()));
    },
    []
  );

  const handleVertexDragEnd = useCallback(
    (e: L.LeafletEvent) => {
      releaseClickSuppressionSoon(suppressNextClickRef);
      const session = vertexDragSessionRef.current;
      vertexDragSessionRef.current = null;
      if (!session) return;
      const marker = e.target as L.Marker;
      onShapesMoved([{ shapeId: session.shapeId, points: vertexPointsFor(session, marker.getLatLng()) }]);
    },
    [onShapesMoved]
  );

  const handleShapeMouseDown = useCallback(
    (shape: DrawnShape, e: L.LeafletMouseEvent) => {
      L.DomEvent.stop(e);
      // Shapes only register a "mousedown" listener (not "click"), so Leaflet's hit-test
      // for the trailing native "click" this gesture produces finds no listener anywhere
      // in the layer chain and falls through to firing it on the map itself regardless of
      // bubblingMouseEvents — which would immediately clear the selection just set below.
      // Eat exactly that one map click.
      suppressNextClickRef.current = true;

      const groupIds = groupIdsFor(shape, shapes);

      if (e.originalEvent.shiftKey) {
        const alreadySelected = groupIds.every((id) => selectedShapeIds.has(id));
        const next = new Set(selectedShapeIds);
        for (const id of groupIds) {
          if (alreadySelected) next.delete(id);
          else next.add(id);
        }
        onSelectionChange(next);
        return;
      }

      if (groupIds.some((id) => selectedShapeIds.has(id))) {
        startDrag([...selectedShapeIds], e);
      } else {
        onSelectionChange(new Set(groupIds));
        startDrag(groupIds, e);
      }
    },
    [shapes, selectedShapeIds, onSelectionChange, startDrag]
  );

  useMapEvent("click", () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (selectedShapeIds.size > 0) onSelectionChange(new Set());
  });

  const bounds = handlesHidden ? null : selectionBounds(shapes, selectedShapeIds);
  // Fine-grained per-point editing only makes sense for exactly one selected shape —
  // for a group/multi-select, dragging the whole bounding box (above) is the tool —
  // and only for hand-drawn polyline/polygon points. A rectangle's points are its 4
  // corners (identical to the resize handles' own positions — showing both at once is
  // redundant and actually conflicts: the two marker types fight over the same pixel),
  // and a circle's points are 48 auto-generated arc samples, not meaningful waypoints.
  const editableShape =
    !handlesHidden && selectedShapeIds.size === 1
      ? shapes.find((s) => selectedShapeIds.has(s.id) && (s.kind === "polyline" || s.kind === "polygon"))
      : undefined;

  return (
    <>
      {shapes.map((shape) => {
        const route = routeIdForShape(shape.id, routes);
        const isSelected = selectedShapeIds.has(shape.id);
        const color = isSelected ? "#2563eb" : "#9ca3af";
        // Two distinctly-typed callbacks (Polygon's ref wants Polygon|null, not the
        // Polyline|null that Polygon's own toGeoJSON generics make incompatible with
        // Polyline's ref type) writing into the same map, keyed by shape id.
        const registerLayer = (instance: L.Polyline | L.Polygon | null) => {
          if (instance) layerRefs.current.set(shape.id, instance);
          else layerRefs.current.delete(shape.id);
        };
        const eventHandlers = { mousedown: (e: L.LeafletMouseEvent) => handleShapeMouseDown(shape, e) };
        const basePathOptions = {
          color,
          weight: isSelected ? 3 : 2,
          dashArray: route ? "6 6" : undefined,
          opacity: route ? 0.5 : 0.9,
          className: "draggable-shape",
          bubblingMouseEvents: false,
        };

        if (shape.kind === "polyline") {
          return (
            <Polyline
              key={shape.id}
              ref={(instance: L.Polyline | null) => registerLayer(instance)}
              positions={shape.points}
              pathOptions={basePathOptions}
              eventHandlers={eventHandlers}
            />
          );
        }

        return (
          <Polygon
            key={shape.id}
            ref={(instance: L.Polygon | null) => registerLayer(instance)}
            positions={shape.points}
            pathOptions={{
              ...basePathOptions,
              fill: true,
              fillColor: color,
              fillOpacity: isSelected ? 0.18 : 0.05,
            }}
            eventHandlers={eventHandlers}
          />
        );
      })}

      {bounds &&
        CORNERS.map((corner) => (
          <Marker
            key={corner}
            position={cornerLatLng(bounds, corner)}
            draggable
            icon={cornerIcon(corner)}
            ref={(instance) => {
              markerRefs.current[corner] = instance;
            }}
            eventHandlers={{
              dragstart: () => handleCornerDragStart(corner),
              drag: (e) => handleCornerDrag(corner, e),
              dragend: (e) => handleCornerDragEnd(e),
            }}
          />
        ))}

      {editableShape &&
        editableVertexIndices(editableShape.points).map(({ index, mirrorIndex }) => (
          <Marker
            key={`vertex-${editableShape.id}-${index}`}
            position={editableShape.points[index]}
            draggable
            icon={VERTEX_ICON}
            eventHandlers={{
              dragstart: () => handleVertexDragStart(editableShape.id, index, mirrorIndex),
              drag: (e) => handleVertexDrag(e),
              dragend: (e) => handleVertexDragEnd(e),
            }}
          />
        ))}

      {shapes
        .filter((shape) => loadingShapeIds.has(shape.id))
        .map((shape) => (
          <Marker
            key={`loader-${shape.id}`}
            position={centroidOfPoints(shape.points)}
            icon={LOADER_ICON}
            interactive={false}
          />
        ))}
    </>
  );
}

export default function MapCanvas({
  shapes,
  routes,
  selectedShapeIds,
  loadingShapeIds,
  onShapeCreated,
  onCenterChange,
  onBoundsChange,
  onShapesMoved,
  onSelectionChange,
}: MapCanvasProps) {
  return (
    <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="map-canvas">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <DrawControl onShapeCreated={onShapeCreated} />
      <ViewportReporter onCenterChange={onCenterChange} onBoundsChange={onBoundsChange} />
      <LocateControl />

      <ShapesLayer
        shapes={shapes}
        routes={routes}
        selectedShapeIds={selectedShapeIds}
        loadingShapeIds={loadingShapeIds}
        onShapesMoved={onShapesMoved}
        onSelectionChange={onSelectionChange}
      />

      {routes.map((route) => (
        <Polyline
          key={route.id}
          positions={route.points}
          pathOptions={{
            color: route.snapped ? "#16a34a" : "#dc2626",
            weight: 4,
            opacity: 0.9,
          }}
        />
      ))}
    </MapContainer>
  );
}
