import { useCallback, useEffect, useState } from "react";
import MapCanvas, { type ShapeMoveUpdate } from "./components/MapCanvas";
import Toolbar from "./components/Toolbar";
import type { FontStatus } from "./components/TextRoutePanel";
import {
  matchToRoads,
  findBestFit,
  haversineDistanceMeters,
  RoutingError,
  type FitPickerState,
} from "./lib/routing";
import { downloadGpx } from "./lib/gpx";
import { loadRouteFont } from "./lib/font";
import { textToShapes, TextRouteError } from "./lib/textToShapes";
import { buildShareUrl, readShapesFromLocation } from "./lib/shareCode";
import { DEFAULT_CENTER } from "./lib/constants";
import type opentype from "opentype.js";
import type { DrawnShape, LatLng, RouteResult, ViewportBounds } from "./types";
import "./App.css";

let routeCounter = 0;
function nextRouteId(): string {
  routeCounter += 1;
  return `route-${Date.now()}-${routeCounter}`;
}

export default function App() {
  const [shapes, setShapes] = useState<DrawnShape[]>(() => readShapesFromLocation() ?? []);
  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [selectedShapeIds, setSelectedShapeIds] = useState<Set<string>>(
    () => new Set(shapes.map((s) => s.id))
  );
  const [shareStatus, setShareStatus] = useState<"idle" | "copied">("idle");
  const [convertingShapeId, setConvertingShapeId] = useState<string | null>(null);
  const [errorByShapeId, setErrorByShapeId] = useState<Record<string, string>>({});
  const [mapCenter, setMapCenter] = useState<LatLng>(DEFAULT_CENTER);
  const [mapBounds, setMapBounds] = useState<ViewportBounds | null>(null);
  const [font, setFont] = useState<opentype.Font | null>(null);
  const [fontStatus, setFontStatus] = useState<FontStatus>("loading");
  const [textError, setTextError] = useState<string | null>(null);
  const [searchingFitShapeId, setSearchingFitShapeId] = useState<string | null>(null);
  const [fitPicker, setFitPicker] = useState<FitPickerState | null>(null);

  useEffect(() => {
    loadRouteFont()
      .then((loaded) => {
        setFont(loaded);
        setFontStatus("ready");
      })
      .catch(() => setFontStatus("error"));
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isTextInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (isTextInput) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedShapeIds(new Set(shapes.map((s) => s.id)));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shapes]);

  const handleShapeCreated = useCallback((shape: DrawnShape) => {
    setShapes((prev) => [...prev, shape]);
    setSelectedShapeIds(new Set([shape.id]));
  }, []);

  const handleCenterChange = useCallback((center: LatLng) => {
    setMapCenter(center);
  }, []);

  const handleBoundsChange = useCallback((bounds: ViewportBounds) => {
    setMapBounds(bounds);
  }, []);

  // Clicking a shape in the sidebar selects its whole group (e.g. every contour of a
  // typed word), replacing the current selection, same as a plain click on the map.
  const handleSelectShape = useCallback(
    (shapeId: string) => {
      const shape = shapes.find((s) => s.id === shapeId);
      if (!shape) return;
      const groupKey = shape.groupId ?? shape.id;
      const groupIds = shapes.filter((s) => (s.groupId ?? s.id) === groupKey).map((s) => s.id);
      setSelectedShapeIds(new Set(groupIds));
    },
    [shapes]
  );

  const handleShapesMoved = useCallback((updates: ShapeMoveUpdate[]) => {
    const pointsByShapeId = new Map(updates.map((u) => [u.shapeId, u.points]));
    setShapes((prev) =>
      prev.map((s) => {
        const points = pointsByShapeId.get(s.id);
        return points ? { ...s, points } : s;
      })
    );
    // Moving a shape invalidates any route snapped to its old position.
    setRoutes((prev) => prev.filter((r) => !pointsByShapeId.has(r.sourceShapeId)));
    setErrorByShapeId((prev) => {
      const next = { ...prev };
      for (const id of pointsByShapeId.keys()) delete next[id];
      return next;
    });
  }, []);

  const clearErrorFor = (shapeId: string) => {
    setErrorByShapeId((prev) => {
      const next = { ...prev };
      delete next[shapeId];
      return next;
    });
  };

  const replaceRouteFor = (shapeId: string, route: RouteResult) => {
    setRoutes((prev) => [...prev.filter((r) => r.sourceShapeId !== shapeId), route]);
  };

  const handleConvert = async (shapeId: string) => {
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape) return;

    setConvertingShapeId(shapeId);
    clearErrorFor(shapeId);
    try {
      const matched = await matchToRoads(shape.points);
      replaceRouteFor(shapeId, {
        id: nextRouteId(),
        sourceShapeId: shapeId,
        points: matched.points,
        distanceMeters: matched.distanceMeters,
        snapped: true,
        createdAt: Date.now(),
      });
    } catch (err) {
      const message =
        err instanceof RoutingError ? err.message : "Something went wrong converting this shape.";
      setErrorByShapeId((prev) => ({ ...prev, [shapeId]: message }));
    } finally {
      setConvertingShapeId(null);
    }
  };

  const handleFindBestFit = async (shapeId: string) => {
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape || !mapBounds) return;

    setSearchingFitShapeId(shapeId);
    clearErrorFor(shapeId);
    try {
      const candidates = await findBestFit(shape.points, mapBounds);
      if (candidates.length === 0) {
        setErrorByShapeId((prev) => ({
          ...prev,
          [shapeId]: "Couldn't find a good placement in the current view. Try panning to an area with more streets.",
        }));
        return;
      }
      setFitPicker({ shapeId, candidates, index: 0 });
      replaceRouteFor(shapeId, {
        id: nextRouteId(),
        sourceShapeId: shapeId,
        points: candidates[0].points,
        distanceMeters: candidates[0].distanceMeters,
        snapped: true,
        createdAt: Date.now(),
      });
    } catch (err) {
      const message = err instanceof RoutingError ? err.message : "Something went wrong finding a fit.";
      setErrorByShapeId((prev) => ({ ...prev, [shapeId]: message }));
    } finally {
      setSearchingFitShapeId(null);
    }
  };

  const handleFitStep = (direction: 1 | -1) => {
    if (!fitPicker) return;
    const nextIndex = Math.min(Math.max(fitPicker.index + direction, 0), fitPicker.candidates.length - 1);
    if (nextIndex === fitPicker.index) return;

    const candidate = fitPicker.candidates[nextIndex];
    setFitPicker({ ...fitPicker, index: nextIndex });
    replaceRouteFor(fitPicker.shapeId, {
      id: nextRouteId(),
      sourceShapeId: fitPicker.shapeId,
      points: candidate.points,
      distanceMeters: candidate.distanceMeters,
      snapped: true,
      createdAt: Date.now(),
    });
  };

  const handleCloseFitPicker = () => setFitPicker(null);

  const handleUseUnsnapped = (shapeId: string) => {
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape) return;

    clearErrorFor(shapeId);
    replaceRouteFor(shapeId, {
      id: nextRouteId(),
      sourceShapeId: shapeId,
      points: shape.points,
      distanceMeters: haversineDistanceMeters(shape.points),
      snapped: false,
      createdAt: Date.now(),
    });
  };

  const handleExport = (routeId: string) => {
    const route = routes.find((r) => r.id === routeId);
    if (!route) return;
    const date = new Date(route.createdAt).toISOString().slice(0, 10);
    downloadGpx(route.points, `route-${date}`);
  };

  const handleDeleteShape = (shapeId: string) => {
    setShapes((prev) => prev.filter((s) => s.id !== shapeId));
    setRoutes((prev) => prev.filter((r) => r.sourceShapeId !== shapeId));
    clearErrorFor(shapeId);
    setSelectedShapeIds((prev) => {
      if (!prev.has(shapeId)) return prev;
      const next = new Set(prev);
      next.delete(shapeId);
      return next;
    });
    setFitPicker((prev) => (prev?.shapeId === shapeId ? null : prev));
  };

  const handleShare = () => {
    if (shapes.length === 0) return;
    const url = buildShareUrl(shapes);
    window.history.replaceState(null, "", url);
    navigator.clipboard?.writeText(url).catch(() => {});
    setShareStatus("copied");
    window.setTimeout(() => setShareStatus("idle"), 1500);
  };

  const handleClearAll = () => {
    setShapes([]);
    setRoutes([]);
    setErrorByShapeId({});
    setSelectedShapeIds(new Set());
    setFitPicker(null);
  };

  const handleGenerateText = (text: string, letterHeightMeters: number) => {
    if (!font) return;
    setTextError(null);
    try {
      const newShapes = textToShapes(font, text, mapCenter, letterHeightMeters);
      setShapes((prev) => [...prev, ...newShapes]);
      setSelectedShapeIds(new Set(newShapes.map((s) => s.id)));
    } catch (err) {
      setTextError(err instanceof TextRouteError ? err.message : "Couldn't place that text.");
    }
  };

  return (
    <div className="app">
      <Toolbar
        shapes={shapes}
        routes={routes}
        selectedShapeIds={selectedShapeIds}
        convertingShapeId={convertingShapeId}
        searchingFitShapeId={searchingFitShapeId}
        fitPicker={fitPicker}
        errorByShapeId={errorByShapeId}
        fontStatus={fontStatus}
        textError={textError}
        shareStatus={shareStatus}
        onShare={handleShare}
        onSelectShape={handleSelectShape}
        onConvert={handleConvert}
        onFindBestFit={handleFindBestFit}
        onFitStep={handleFitStep}
        onCloseFitPicker={handleCloseFitPicker}
        onUseUnsnapped={handleUseUnsnapped}
        onExport={handleExport}
        onDeleteShape={handleDeleteShape}
        onClearAll={handleClearAll}
        onGenerateText={handleGenerateText}
      />
      <MapCanvas
        shapes={shapes}
        routes={routes}
        selectedShapeIds={selectedShapeIds}
        loadingShapeIds={new Set([convertingShapeId, searchingFitShapeId].filter((id) => id !== null))}
        onShapeCreated={handleShapeCreated}
        onCenterChange={handleCenterChange}
        onBoundsChange={handleBoundsChange}
        onShapesMoved={handleShapesMoved}
        onSelectionChange={setSelectedShapeIds}
      />
    </div>
  );
}
