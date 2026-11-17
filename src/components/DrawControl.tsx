import { useEffect } from "react";
import L from "leaflet";
import "leaflet-draw";
import { useMap } from "react-leaflet";
import { shapeToPoints } from "../lib/shapeToPoints";
import { installLeafletDrawPatches } from "../lib/leafletDrawPatches";
import type { DrawnShape } from "../types";

installLeafletDrawPatches();

interface DrawControlProps {
  onShapeCreated: (shape: DrawnShape) => void;
}

let shapeCounter = 0;
function nextId(): string {
  shapeCounter += 1;
  return `shape-${Date.now()}-${shapeCounter}`;
}

/**
 * Mounts leaflet-draw's drawing toolbar directly on the underlying Leaflet map
 * instance. We don't use react-leaflet-draw here: that wrapper targets
 * react-leaflet's old class-based context API and is broken under react-leaflet v4+.
 * Drawn layers are discarded right after their points are extracted — React state
 * (DrawnShape[] in App) is the single source of truth for what's rendered.
 */
export default function DrawControl({ onShapeCreated }: DrawControlProps) {
  const map = useMap();

  useEffect(() => {
    const scratchGroup = new L.FeatureGroup();
    map.addLayer(scratchGroup);

    const control = new L.Control.Draw({
      draw: {
        marker: false,
        circlemarker: false,
        polyline: { shapeOptions: { color: "#2563eb" } },
        polygon: { shapeOptions: { color: "#2563eb" }, allowIntersection: false },
        rectangle: { shapeOptions: { color: "#2563eb" } },
        circle: { shapeOptions: { color: "#2563eb" } },
      },
    });
    map.addControl(control);

    const handleCreated = (event: L.LeafletEvent) => {
      const layer = (event as L.DrawEvents.Created).layer;
      const extracted = shapeToPoints(layer);
      if (extracted) {
        onShapeCreated({
          id: nextId(),
          kind: extracted.kind,
          points: extracted.points,
          createdAt: Date.now(),
        });
      }
    };

    map.on(L.Draw.Event.CREATED, handleCreated);

    return () => {
      map.off(L.Draw.Event.CREATED, handleCreated);
      map.removeControl(control);
      map.removeLayer(scratchGroup);
    };
  }, [map, onShapeCreated]);

  return null;
}
