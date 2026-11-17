import TextRoutePanel, { type FontStatus } from "./TextRoutePanel";
import type { FitPickerState } from "../lib/routing";
import type { DrawnShape, RouteResult } from "../types";

interface ToolbarProps {
  shapes: DrawnShape[];
  routes: RouteResult[];
  selectedShapeIds: ReadonlySet<string>;
  convertingShapeId: string | null;
  searchingFitShapeId: string | null;
  fitPicker: FitPickerState | null;
  errorByShapeId: Record<string, string>;
  fontStatus: FontStatus;
  textError: string | null;
  shareStatus: "idle" | "copied";
  onShare: () => void;
  onSelectShape: (id: string) => void;
  onConvert: (id: string) => void;
  onFindBestFit: (id: string) => void;
  onFitStep: (direction: 1 | -1) => void;
  onCloseFitPicker: () => void;
  onUseUnsnapped: (id: string) => void;
  onExport: (routeId: string) => void;
  onDeleteShape: (id: string) => void;
  onClearAll: () => void;
  onGenerateText: (text: string, letterHeightMeters: number) => void;
}

function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km`;
}

function shapeLabel(shape: DrawnShape): string {
  const names: Record<DrawnShape["kind"], string> = {
    polyline: "Line",
    polygon: "Polygon loop",
    rectangle: "Rectangle loop",
    circle: "Circle loop",
  };
  return names[shape.kind];
}

export default function Toolbar({
  shapes,
  routes,
  selectedShapeIds,
  convertingShapeId,
  searchingFitShapeId,
  fitPicker,
  errorByShapeId,
  fontStatus,
  textError,
  shareStatus,
  onShare,
  onSelectShape,
  onConvert,
  onFindBestFit,
  onFitStep,
  onCloseFitPicker,
  onUseUnsnapped,
  onExport,
  onDeleteShape,
  onClearAll,
  onGenerateText,
}: ToolbarProps) {
  const busy = convertingShapeId !== null || searchingFitShapeId !== null;
  return (
    <aside className="toolbar">
      <div className="toolbar-header">
        <h1>Draw → Route</h1>
        <p>
          Draw a line or shape on the map using the toolbar in the top-left corner, then convert
          it into a runnable route and export it as a GPX file.
        </p>
        {shapes.length > 0 && (
          <button className="share-btn" onClick={onShare}>
            {shareStatus === "copied" ? "Link copied!" : "Copy share link"}
          </button>
        )}
      </div>

      <TextRoutePanel fontStatus={fontStatus} error={textError} onGenerate={onGenerateText} />

      {shapes.length === 0 && <p className="empty-hint">No shapes drawn yet.</p>}

      <ul className="shape-list">
        {shapes.map((shape) => {
          const route = routes.find((r) => r.sourceShapeId === shape.id);
          const isConverting = convertingShapeId === shape.id;
          const isSearchingFit = searchingFitShapeId === shape.id;
          const activeFitPicker = fitPicker?.shapeId === shape.id ? fitPicker : null;
          const error = errorByShapeId[shape.id];

          return (
            <li
              key={shape.id}
              className={`shape-item ${selectedShapeIds.has(shape.id) ? "selected" : ""}`}
              onClick={() => onSelectShape(shape.id)}
            >
              <div className="shape-item-header">
                <span>{shapeLabel(shape)}</span>
                <button
                  className="icon-btn"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteShape(shape.id);
                  }}
                >
                  ✕
                </button>
              </div>

              {route && (
                <div className={`route-summary ${route.snapped ? "snapped" : "unsnapped"}`}>
                  {route.snapped ? "Snapped to roads/paths" : "Unsnapped (as drawn)"} ·{" "}
                  {formatDistance(route.distanceMeters)}
                </div>
              )}

              {activeFitPicker && (
                <div className="fit-picker">
                  <button
                    className="fit-picker-nav"
                    title="Previous option"
                    disabled={activeFitPicker.index === 0}
                    onClick={() => onFitStep(-1)}
                  >
                    ◀
                  </button>
                  <span>
                    Option {activeFitPicker.index + 1} of {activeFitPicker.candidates.length}
                    {activeFitPicker.candidates[activeFitPicker.index].scale !== 1
                      ? ` · ${Math.round(activeFitPicker.candidates[activeFitPicker.index].scale * 100)}% size`
                      : ""}
                  </span>
                  <button
                    className="fit-picker-nav"
                    title="Next option"
                    disabled={activeFitPicker.index === activeFitPicker.candidates.length - 1}
                    onClick={() => onFitStep(1)}
                  >
                    ▶
                  </button>
                  <button className="icon-btn" title="Done choosing" onClick={onCloseFitPicker}>
                    ✕
                  </button>
                </div>
              )}

              {error && <div className="error-text">{error}</div>}

              <div className="shape-item-actions" onClick={(e) => e.stopPropagation()}>
                {!route && (
                  <button disabled={isConverting || busy} onClick={() => onConvert(shape.id)}>
                    {isConverting ? "Matching to roads…" : "Convert to route"}
                  </button>
                )}
                <button disabled={busy} onClick={() => onFindBestFit(shape.id)}>
                  {isSearchingFit ? "Searching nearby area…" : "Find best fit"}
                </button>
                {error && (
                  <button className="secondary" onClick={() => onUseUnsnapped(shape.id)}>
                    Use as drawn
                  </button>
                )}
                {route && (
                  <>
                    <button onClick={() => onExport(route.id)}>Export GPX</button>
                    <button className="secondary" onClick={() => onConvert(shape.id)} disabled={isConverting || busy}>
                      {isConverting ? "Retrying…" : "Re-snap"}
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {shapes.length > 0 && (
        <button className="clear-all-btn" onClick={onClearAll}>
          Clear all
        </button>
      )}
    </aside>
  );
}
