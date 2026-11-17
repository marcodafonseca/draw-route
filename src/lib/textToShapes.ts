import L from "leaflet";
import type opentype from "opentype.js";
import { closeLoop, destinationPoint } from "./shapeToPoints";
import type { DrawnShape, LatLng } from "../types";

const REFERENCE_SIZE = 1000;
const CURVE_SEGMENTS = 12;

interface Point2D {
  x: number;
  y: number;
}

function sampleQuadratic(p0: Point2D, p1: Point2D, p2: Point2D): Point2D[] {
  const points: Point2D[] = [];
  for (let i = 1; i <= CURVE_SEGMENTS; i++) {
    const t = i / CURVE_SEGMENTS;
    const mt = 1 - t;
    points.push({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    });
  }
  return points;
}

function sampleCubic(p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D): Point2D[] {
  const points: Point2D[] = [];
  for (let i = 1; i <= CURVE_SEGMENTS; i++) {
    const t = i / CURVE_SEGMENTS;
    const mt = 1 - t;
    points.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return points;
}

/** Splits a glyph path's commands into flattened (curves-to-line-segments) contours. */
function pathToContours(path: opentype.Path): Point2D[][] {
  const contours: Point2D[][] = [];
  let current: Point2D[] = [];
  let start: Point2D = { x: 0, y: 0 };
  let last: Point2D = { x: 0, y: 0 };

  for (const cmd of path.commands) {
    switch (cmd.type) {
      case "M":
        if (current.length > 0) contours.push(current);
        current = [{ x: cmd.x, y: cmd.y }];
        start = last = { x: cmd.x, y: cmd.y };
        break;
      case "L":
        current.push({ x: cmd.x, y: cmd.y });
        last = { x: cmd.x, y: cmd.y };
        break;
      case "Q": {
        const end = { x: cmd.x, y: cmd.y };
        current.push(...sampleQuadratic(last, { x: cmd.x1, y: cmd.y1 }, end));
        last = end;
        break;
      }
      case "C": {
        const end = { x: cmd.x, y: cmd.y };
        current.push(
          ...sampleCubic(last, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x2, y: cmd.y2 }, end)
        );
        last = end;
        break;
      }
      case "Z":
        current.push({ ...start });
        last = start;
        break;
    }
  }
  if (current.length > 0) contours.push(current);

  return contours.filter((c) => c.length >= 3);
}

let shapeCounter = 0;
function nextId(): string {
  shapeCounter += 1;
  return `text-${Date.now()}-${shapeCounter}`;
}

export class TextRouteError extends Error {}

/**
 * Renders `text` with the given font, scales it so its cap height equals
 * `letterHeightMeters`, and projects each glyph contour around `center` to
 * produce one closed-loop DrawnShape per contour (so holes in letters like
 * "O" or "A" become their own small shape, same as any hand-drawn polygon).
 */
export function textToShapes(
  font: opentype.Font,
  text: string,
  center: LatLng,
  letterHeightMeters: number
): DrawnShape[] {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new TextRouteError("Type something first.");
  }

  const path = font.getPath(trimmed, 0, 0, REFERENCE_SIZE);
  const bbox = path.getBoundingBox();
  const measuredHeight = bbox.y2 - bbox.y1;
  if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) {
    throw new TextRouteError("That text has no visible characters in this font.");
  }

  const contours = pathToContours(path);
  if (contours.length === 0) {
    throw new TextRouteError("That text has no visible characters in this font.");
  }

  const scale = letterHeightMeters / measuredHeight;
  const midX = (bbox.x1 + bbox.x2) / 2;
  const midY = (bbox.y1 + bbox.y2) / 2;
  const centerLatLng = L.latLng(center[0], center[1]);
  // All contours from this call (e.g. both strokes of "A", the dot and stem of "i") move
  // together when dragged, since they're one visual unit even though holes need separate shapes.
  const groupId = `text-group-${Date.now()}`;

  return contours.map((contour) => {
    const points: LatLng[] = contour.map(({ x, y }) => {
      const eastMeters = (x - midX) * scale;
      const northMeters = -(y - midY) * scale;
      const distance = Math.hypot(eastMeters, northMeters);
      const bearing = Math.atan2(eastMeters, northMeters);
      return destinationPoint(centerLatLng, distance, bearing);
    });

    return {
      id: nextId(),
      kind: "polygon",
      points: closeLoop(points),
      createdAt: Date.now(),
      groupId,
    };
  });
}
