/**
 * Chain types -> domain types. The single place the on-chain shape is allowed
 * to meet the neutral one.
 *
 * Nothing here decides anything: it is a projection. Every value comes from a
 * decoded Booking or the D1 cargo mirror, and where the chain simply does not
 * carry a concept the field is null rather than invented.
 */
import type { PublicKey } from '@solana/web3.js';

import { netAfterPlatformFee } from '@/lib/accept';
import {
  STATUS_ACCEPTED,
  STATUS_DELIVERED,
  STATUS_DISPUTED,
  STATUS_OPEN,
  coords,
  type Booking,
  type BookingRow,
} from '@/lib/chain';
import type { CargoHistoryRow, CargoMeta } from '@/lib/cargo';
import type { Money, Shipment, ShipmentStatus } from '../types';

const usdc = (minor: bigint | number): Money => ({
  minor: typeof minor === 'bigint' ? minor : BigInt(Math.round(minor)),
  currency: 'USDC',
});

/**
 * The on-chain status byte, projected onto the shared vocabulary.
 *
 * STATUS_ACCEPTED means a carrier holds it and is driving — the shared model
 * calls that `in_transit`, because that is what the user is told. `released`
 * has no byte: release() CLOSES the account, so a released booking is one
 * that no longer exists on-chain and can only come from the D1 mirror.
 */
export function statusFromChain(a: Booking, disputedMirror = false): ShipmentStatus {
  if (a.status === STATUS_DISPUTED || disputedMirror) return 'disputed';
  if (a.status === STATUS_DELIVERED) return 'delivered';
  if (a.status === STATUS_ACCEPTED) return 'in_transit';
  if (a.status === STATUS_OPEN) return 'open';
  return 'open';
}

const party = (pk: PublicKey, label?: string | null, phone?: string | null) => ({
  ref: pk.toBase58(),
  label: label ?? null,
  phone: phone ?? null,
});

/** A live booking (+ its off-chain mirror) as a Shipment. */
export function shipmentFromBooking(row: BookingRow, meta?: CargoMeta): Shipment {
  const a = row.account;
  const c = coords(a);
  const gross = usdc(a.amount);
  return {
    id: row.pda.toBase58(),
    status: statusFromChain(a, !!meta?.disputed),
    amount: gross,
    carrierNet: usdc(netAfterPlatformFee(Number(a.amount))),
    terms: { kind: 'escrow', heldUntilDelivery: true },
    shipper: party(a.shipper, meta?.contact_name, meta?.contact_phone),
    // PublicKey.default is the program's "unassigned" sentinel, not a party.
    carrier: a.carrier.toBase58() === '11111111111111111111111111111111' ? null : party(a.carrier),
    pickupContact: meta?.pickup_contact_name
      ? { ref: 'pickup', label: meta.pickup_contact_name, phone: meta.pickup_contact_phone ?? null }
      : null,
    dropoffContact: meta?.dropoff_contact_name
      ? { ref: 'dropoff', label: meta.dropoff_contact_name, phone: meta.dropoff_contact_phone ?? null }
      : null,
    pickup: c.pickup,
    dropoff: c.dropoff,
    pickupName: meta?.pickup_name ?? null,
    dropoffName: meta?.dropoff_name ?? null,
    distanceKm: meta?.distance_km ?? null,
    weightKg: meta?.weight_kg ?? null,
    volumeM3: meta?.volume_m3 ?? null,
    stops: meta?.waypoints?.length ?? null,
    pickupDate: a.pickupDate || null,
    dropoffDate: a.dropoffDate || null,
    deliveredAt: a.deliveredAt || null,
    deliveryPhoto: meta?.delivery_photo ?? null,
    disputed: !!meta?.disputed,
    // The release/cancel instructions need the booking id and both parties,
    // and those are chain-shaped. Screens pass this back untouched.
    raw: { pda: row.pda, account: a },
  };
}

/**
 * A finished booking, from D1 only.
 *
 * The on-chain account is gone by the time a history row exists, so most
 * fields are simply unknowable — they are null, not zero. `completed_amount`
 * is documented as GROSS escrowed, pre-take-rate.
 */
export function shipmentFromHistory(r: CargoHistoryRow): Shipment {
  const gross = usdc(r.completed_amount);
  return {
    id: r.booking_pda,
    status: r.completed_status === 'released' ? 'released' : 'cancelled',
    amount: gross,
    carrierNet: r.completed_status === 'released' ? usdc(netAfterPlatformFee(r.completed_amount)) : null,
    terms: { kind: 'escrow', heldUntilDelivery: true },
    shipper: { ref: r.shipper, label: null, phone: null },
    carrier: r.carrier ? { ref: r.carrier, label: null, phone: null } : null,
    pickupContact: null,
    dropoffContact: null,
    pickup: null,
    dropoff: null,
    pickupName: r.pickup_name ?? null,
    dropoffName: r.dropoff_name ?? null,
    distanceKm: null,
    weightKg: null,
    volumeM3: null,
    stops: null,
    pickupDate: null,
    dropoffDate: null,
    deliveredAt: null,
    deliveryPhoto: null,
    disputed: false,
    raw: { completedAt: r.completed_at },
  };
}

/** Recover the chain handles a rail call needs from a Shipment. */
export function chainHandles(s: Shipment): { pda: PublicKey; account: Booking } {
  const raw = s.raw as { pda?: PublicKey; account?: Booking } | undefined;
  if (!raw?.pda || !raw?.account) {
    throw new Error(`shipment ${s.id} carries no chain handles — it did not come from the chain adapter`);
  }
  return { pda: raw.pda, account: raw.account };
}
