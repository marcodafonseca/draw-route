import type { DrawnShape, LatLng, ShapeKind } from "../types";

/**
 * Packs the current shapes into a compact, lossless, URL-safe code so a specific
 * drawing can be reloaded (or shared) via a link, with no server/backend involved.
 *
 * Format (before base64url): [version byte][shape count varuint] then per shape:
 * [kind byte][group ref varuint][point count varuint][points...]. Points are
 * fixed-point micro-degrees (1e6 scale, ~11cm resolution -- matches GPX export
 * precision), zigzag-varint delta-encoded against the previous point in the same
 * shape (the first point is absolute) since consecutive drawn points are usually
 * only meters apart, which keeps most deltas to 1-2 bytes instead of the ~8 a raw
 * float would cost.
 */
const COORD_SCALE = 1e6;
const FORMAT_VERSION = 1;
const SHAPE_KINDS: ShapeKind[] = ["polyline", "polygon", "rectangle", "circle"];

class ByteWriter {
  private bytes: number[] = [];

  writeByte(b: number): void {
    this.bytes.push(b & 0xff);
  }

  writeVarUint(value: number): void {
    let v = value;
    while (v >= 0x80) {
      this.bytes.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.bytes.push(v);
  }

  writeVarInt(value: number): void {
    this.writeVarUint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

class ByteReader {
  private pos = 0;
  private bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  readByte(): number {
    return this.bytes[this.pos++];
  }

  readVarUint(): number {
    let result = 0;
    let shift = 1;
    for (;;) {
      const b = this.bytes[this.pos++];
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) break;
      shift *= 128;
    }
    return result;
  }

  readVarInt(): number {
    const zigzag = this.readVarUint();
    return zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(code: string): Uint8Array {
  const base64 = code.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeShapes(shapes: DrawnShape[]): string {
  const writer = new ByteWriter();
  writer.writeByte(FORMAT_VERSION);
  writer.writeVarUint(shapes.length);

  // A groupId is only meaningful relative to other shapes in the same share (e.g. all
  // contours of one typed word) -- store it as "index of the first shape in this
  // group" rather than the original id, which is regenerated fresh on decode anyway.
  const firstIndexOfGroup = new Map<string, number>();

  shapes.forEach((shape, i) => {
    const groupKey = shape.groupId ?? shape.id;
    if (!firstIndexOfGroup.has(groupKey)) firstIndexOfGroup.set(groupKey, i);
    const groupFirstIndex = firstIndexOfGroup.get(groupKey) as number;

    writer.writeByte(SHAPE_KINDS.indexOf(shape.kind));
    writer.writeVarUint(groupFirstIndex === i ? 0 : groupFirstIndex + 1);

    writer.writeVarUint(shape.points.length);
    let prevLat = 0;
    let prevLng = 0;
    shape.points.forEach(([latDeg, lngDeg], pi) => {
      const lat = Math.round(latDeg * COORD_SCALE);
      const lng = Math.round(lngDeg * COORD_SCALE);
      if (pi === 0) {
        writer.writeVarInt(lat);
        writer.writeVarInt(lng);
      } else {
        writer.writeVarInt(lat - prevLat);
        writer.writeVarInt(lng - prevLng);
      }
      prevLat = lat;
      prevLng = lng;
    });
  });

  return bytesToBase64Url(writer.toUint8Array());
}

let sharedShapeCounter = 0;
function nextSharedShapeId(): string {
  sharedShapeCounter += 1;
  return `shared-${Date.now()}-${sharedShapeCounter}`;
}

export function decodeShapes(code: string): DrawnShape[] | null {
  try {
    const reader = new ByteReader(base64UrlToBytes(code));
    if (reader.readByte() !== FORMAT_VERSION) return null;

    const shapeCount = reader.readVarUint();
    const shapes: DrawnShape[] = [];
    const idByIndex: string[] = [];

    for (let i = 0; i < shapeCount; i++) {
      const kind = SHAPE_KINDS[reader.readByte()];
      if (!kind) return null;
      const groupRef = reader.readVarUint();

      const pointCount = reader.readVarUint();
      const points: LatLng[] = [];
      let lat = 0;
      let lng = 0;
      for (let pi = 0; pi < pointCount; pi++) {
        if (pi === 0) {
          lat = reader.readVarInt();
          lng = reader.readVarInt();
        } else {
          lat += reader.readVarInt();
          lng += reader.readVarInt();
        }
        points.push([lat / COORD_SCALE, lng / COORD_SCALE]);
      }

      const id = nextSharedShapeId();
      idByIndex[i] = id;
      const groupId = groupRef === 0 ? undefined : idByIndex[groupRef - 1];
      shapes.push({ id, kind, points, createdAt: Date.now(), groupId });
    }

    return shapes;
  } catch {
    return null;
  }
}

const SHARE_HASH_PREFIX = "#s=";

export function buildShareUrl(shapes: DrawnShape[]): string {
  const url = new URL(window.location.href);
  url.hash = `s=${encodeShapes(shapes)}`;
  return url.toString();
}

export function readShapesFromLocation(): DrawnShape[] | null {
  if (!window.location.hash.startsWith(SHARE_HASH_PREFIX)) return null;
  return decodeShapes(window.location.hash.slice(SHARE_HASH_PREFIX.length));
}
