// §K.2 — turn a spoken pickup address into map coordinates.
//
// When intake parses a `pickupLocation` string but no lat/lng (the common case
// for a real caller reading out an address), the pipeline geocodes it so the map
// can pin the exact spot instead of a neighbourhood guess. The lookup is
// injectable via PipelineDeps.geocode so vitest never touches the network — tests
// pass a stub; production wires `nominatimGeocode`.

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** location text → coordinates, or null on any miss/failure. Never throws. */
export type Geocoder = (location: string) => Promise<GeoPoint | null>;

// San Francisco bounding box (west,north,east,south) to bias + bound results, so
// "500 Main St" resolves in SF rather than another city with the same street.
const SF_VIEWBOX = '-122.53,37.82,-122.35,37.70';
const TIMEOUT_MS = 3000;

/**
 * Default geocoder: Nominatim (OpenStreetMap) free-form search, bounded to SF.
 *
 * Plain `fetch` + `AbortController`, so it runs identically on Node 18+ and the
 * Workers runtime. Any failure — non-OK status, timeout, malformed body, no
 * result — returns null, which leaves the donation's coords absent (the map then
 * falls back to whatever intake already had, i.e. nothing).
 */
export const nominatimGeocode: Geocoder = async (location) => {
  const q = encodeURIComponent(`${location}, San Francisco, CA`);
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=1` +
    `&viewbox=${SF_VIEWBOX}&bounded=1&q=${q}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Nominatim's usage policy requires an identifying User-Agent.
      headers: { 'User-Agent': 'Donna-food-rescue/1.0 (demo)' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    const first = Array.isArray(data) ? data[0] : undefined;
    if (!first || first.lat == null || first.lon == null) return null;
    const lat = Number.parseFloat(first.lat);
    const lng = Number.parseFloat(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
