/**
 * Which corridor a booking belongs to — ported verbatim from
 * solana/app/src/lib/corridor.js, which itself exists in a second copy
 * inside worker/index.js. Three copies is not a design; it is what a
 * dependency-free ten-line rule costs across a browser bundle, a Worker and
 * a React Native app. Keep them in sync.
 *
 * The worker RE-DERIVES this from the country codes it is sent and returns
 * 400 if the client's answer disagrees, so a drift here is loud rather than
 * silent — which is the only reason a copy is acceptable at all.
 *
 * Every booking settles on the escrow whatever its corridor; the value is
 * recorded with the booking.
 */

export const CORRIDOR_CROSS_BORDER = 'CROSS_BORDER';
export const CORRIDOR_GEORGIA_DOMESTIC = 'GEORGIA_DOMESTIC';
export const GEORGIA_COUNTRY_CODE = 'GE';

export function normalizeCountry(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/** Both ends in Georgia, or it is CROSS_BORDER. An unknown country falls to
 *  CROSS_BORDER on purpose, so a missing code degrades rather than
 *  mis-classifies. */
export function resolveCorridor(
  pickupCountry: string | null | undefined,
  dropoffCountry: string | null | undefined
): string {
  const a = normalizeCountry(pickupCountry);
  const b = normalizeCountry(dropoffCountry);
  if (!a || !b) return CORRIDOR_CROSS_BORDER;
  return a === GEORGIA_COUNTRY_CODE && b === GEORGIA_COUNTRY_CODE
    ? CORRIDOR_GEORGIA_DOMESTIC
    : CORRIDOR_CROSS_BORDER;
}
