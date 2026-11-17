/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Free MapTiler API key, used only for the rough drag-time road-snap preview
   * (roadCache.ts). Get one at https://cloud.maptiler.com/ — the feature just stays
   * off if this isn't set. */
  readonly VITE_MAPTILER_KEY?: string;
}
