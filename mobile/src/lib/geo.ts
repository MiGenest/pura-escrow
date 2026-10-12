import { haversine } from './chain';

/**
 * Place search and route distance for the booking form.
 *
 * The web client uses the Google Places JS SDK for search (LocationSearch.jsx)
 * and it does not port: it is a browser-only SDK loaded from a <script> tag,
 * behind an HTTP-referrer-restricted key that a phone cannot present. So this
 * uses Nominatim, which solana/app already calls directly for its own
 * geocodeAddress() and map reverse-geocode, needs no key, and returns the ISO
 * country code a booking's corridor (domestic or cross-border) is derived from.
 *
 * The honest trade: Nominatim's autocomplete is weaker than Places',
 * noticeably so for Georgian addresses. That is a search-quality problem, not
 * a correctness one — every downstream field (lat/lng, country, display name)
 * has the same meaning either way.
 */

export type Place = {
  lat: number;
  lng: number;
  /** Full formatted address — becomes cargo.pickup_name / dropoff_name. */
  name: string;
  /** First component, for cards and the confirm sheet. */
  short: string;
  /** ISO 3166-1 alpha-2, or null. null is a valid answer: the worker's
   *  resolveCorridor() reads an unknown country as CROSS_BORDER. */
  country: string | null;
};

export type RouteInfo = {
  km: number;
  minutes: number;
  /** true when this is the straight-line fallback rather than a real road
   *  route — surfaced in the UI, because it changes the price. */
  straight: boolean;
};

/** Nominatim's usage policy requires an identifying User-Agent. */
const UA = 'pura-escrow-demo (github.com/MiGenest/pura-escrow)';

/** Neither of these should be able to hang a form the user is typing into. */
async function getJson(url: string, ms = 8000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

type NominatimHit = {
  lat: string;
  lon: string;
  display_name?: string;
  address?: { country_code?: string };
};

function toPlace(hit: NominatimHit): Place | null {
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const name = hit.display_name ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  // Nominatim returns country_code lowercase; the worker's normalizeCountry
  // upper-cases and length-checks it, and only ever stores a valid alpha-2.
  const raw = hit.address?.country_code;
  const country = typeof raw === 'string' && /^[a-z]{2}$/i.test(raw.trim())
    ? raw.trim().toUpperCase()
    : null;
  return { lat, lng, name, short: name.split(',')[0], country };
}

/** Typeahead results. Returns [] on any failure — a search that errors must
 *  leave the field usable, never throw into the screen. */
export async function searchPlaces(query: string): Promise<Place[]> {
  if (query.trim().length < 2) return [];
  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1` +
      `&q=${encodeURIComponent(query.trim())}`;
    const hits = (await getJson(url)) as NominatimHit[];
    if (!Array.isArray(hits)) return [];
    return hits.map(toPlace).filter((p): p is Place => p !== null);
  } catch (err) {
    console.log('[geo] search failed', String(err));
    return [];
  }
}

/**
 * Road distance, with the same straight-line fallback RouteMap.jsx uses.
 *
 * Distance is a PRICE INPUT, not decoration — priceUsdFor() multiplies by it
 * — so the fallback is reported rather than hidden: an OSRM outage silently
 * repricing every load to its shorter as-the-crow-flies distance is exactly
 * the kind of thing that should be visible on the screen before funds lock.
 * (The web client's `minutes: km` in this branch is not a typo of ours; it is
 * copied, and it is only ever displayed.)
 */
export async function routeBetween(pickup: Place, dropoff: Place): Promise<RouteInfo> {
  const straightKm = haversine(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
  try {
    const coords = `${pickup.lng},${pickup.lat};${dropoff.lng},${dropoff.lat}`;
    // overview=false: this client draws no map, so the geometry is pure
    // payload. The web app asks for it because RouteMap renders the line.
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`;
    const data = (await getJson(url)) as { routes?: { distance: number; duration: number }[] };
    const route = data.routes?.[0];
    if (!route) throw new Error('no route in response');
    return { km: route.distance / 1000, minutes: route.duration / 60, straight: false };
  } catch (err) {
    console.log('[geo] osrm failed, using straight line', String(err));
    return { km: straightKm, minutes: straightKm, straight: true };
  }
}
