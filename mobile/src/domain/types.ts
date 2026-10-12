/**
 * The neutral domain model — what the SCREENS speak.
 *
 * Screens are typed against these types rather than the chain's decoded
 * accounts, and an adapter (`domain/crypto/mapping.ts`) produces them from the
 * escrow program's `Booking` accounts. The rule is one-way: `domain/` must
 * never import from `lib/chain`, `lib/solana`, `@solana/web3.js` or
 * `@privy-io/*`. Adapters import domain, not the reverse.
 */

/**
 * Opaque shipment identifier: the booking account's base58 address (its PDA).
 * Screens only ever pass it back, so a string is the honest type.
 */
export type ShipmentId = string;

/**
 * Whoever is on the other end. `ref` is the backend's own identifier (a wallet
 * address); `label` is what a human should see.
 *
 * `ref` is deliberately NOT parsed or compared by screens — only the adapter
 * that produced it knows what it means.
 */
export type PartyRef = {
  ref: string;
  label?: string | null;
  phone?: string | null;
};

/**
 * Money with its unit attached.
 *
 * `minor` is the smallest unit — micro-USDC (1e6) for USDC — so no float ever
 * holds an amount, and `currency` travels with it, so a bare number never has
 * to be guessed at.
 */
export type Money = {
  minor: bigint;
  currency: 'USDC' | 'GEL' | 'USD' | 'EUR';
};

/** Fixed-point scale per currency, for formatting only. */
export const MINOR_PER_UNIT: Record<Money['currency'], bigint> = {
  USDC: 1_000_000n,
  GEL: 100n,
  USD: 100n,
  EUR: 100n,
};

/**
 * The shipment lifecycle the screens show.
 *
 * The escrow adapter maps the program's four on-chain status bytes onto these
 * names. It never produces `invoiced` or `paid` — on the escrow, settlement IS
 * the release — but screens handle them as terminal states rather than assume
 * they cannot occur.
 */
export type ShipmentStatus =
  | 'open'
  | 'accepted'
  | 'in_transit'
  | 'delivered'
  | 'released'
  | 'invoiced'
  | 'paid'
  | 'cancelled'
  | 'disputed';

/** Terminal states: nothing a carrier or shipper does moves these. */
export const TERMINAL_STATUSES: readonly ShipmentStatus[] = [
  'released',
  'paid',
  'cancelled',
] as const;

/**
 * How this shipment settles. The screens need this to know what to SAY, not
 * just what to show. The escrow adapter always produces `escrow`.
 */
export type PaymentTerms =
  | { kind: 'escrow'; heldUntilDelivery: true }
  | { kind: 'invoice'; dueAfterDelivery: true };

/** A geographic point, already unscaled. */
export type Point = { lat: number; lng: number };

/**
 * One shipment, as a screen needs it.
 *
 * Every field is either present or explicitly null — no `undefined`-means-
 * maybe. Fields the chain cannot know are null rather than absent, so a
 * screen never has to guess.
 */
export type Shipment = {
  id: ShipmentId;
  status: ShipmentStatus;
  /** Gross amount escrowed or agreed. Null when a rate is not yet set. */
  amount: Money | null;
  /** What the carrier nets after the platform's take, when it is knowable. */
  carrierNet: Money | null;
  terms: PaymentTerms;

  shipper: PartyRef | null;
  carrier: PartyRef | null;
  /** The people at each end, distinct from the account holders
   *  (cargo.{pickup,dropoff}_contact_* on the server). */
  pickupContact: PartyRef | null;
  dropoffContact: PartyRef | null;

  pickup: Point | null;
  dropoff: Point | null;
  pickupName: string | null;
  dropoffName: string | null;
  distanceKm: number | null;

  weightKg: number | null;
  volumeM3: number | null;
  /** Intermediate stops, when the route has any. */
  stops: number | null;

  /** Unix seconds; 0/null where unset, never a sentinel date. */
  pickupDate: number | null;
  dropoffDate: number | null;
  deliveredAt: number | null;

  deliveryPhoto: string | null;
  disputed: boolean;

  /**
   * Escape hatch for rail-specific data a screen genuinely needs and the
   * model should not generalise — the on-chain booking id for a release
   * instruction, say. Adapters own the shape; screens pass it back untouched.
   */
  raw?: unknown;
};

/** Formatting helper. Display only. */
export function formatMoney(m: Money | null): string {
  if (!m) return '—';
  const per = MINOR_PER_UNIT[m.currency];
  const whole = m.minor / per;
  const frac = m.minor % per;
  const digits = per === 1_000_000n ? 6 : 2;
  const fracStr = frac.toString().padStart(digits, '0').replace(/0+$/, '');
  const n = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return m.currency === 'USDC' || m.currency === 'USD' ? `$${n}` : `${n} ₾`;
}
