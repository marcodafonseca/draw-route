import opentype from "opentype.js";
import fontUrl from "@fontsource/anton/files/anton-latin-400-normal.woff?url";

let fontPromise: Promise<opentype.Font> | null = null;

/** Loads (and caches) the bold display font used to render typed text as route shapes. */
export function loadRouteFont(): Promise<opentype.Font> {
  if (!fontPromise) {
    fontPromise = fetch(fontUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch font (HTTP ${res.status})`);
        return res.arrayBuffer();
      })
      .then((buffer) => opentype.parse(buffer));
  }
  return fontPromise;
}
