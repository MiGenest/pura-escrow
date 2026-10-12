import { Connection, PublicKey } from '@solana/web3.js';

import { PROGRAM_ID } from './constants';

/**
 * On-chain booking reads, ported from solana/app/src/lib/chain.js.
 *
 * Deliberately NOT using Anchor. The web client decodes these accounts by
 * hand too — Anchor's Program/AnchorProvider is only needed to BUILD
 * instructions, which is the accept flow, and that is out of scope here.
 * Read-only therefore costs no extra dependency.
 *
 * The layout below must stay byte-identical to the web decoder and to
 * programs/pura-escrow/src/state.rs. Field order and widths are not
 * negotiable; the trailing fields are length-guarded exactly as the web
 * version guards them, so an account written before those fields existed
 * still decodes instead of throwing.
 */

/** Status discriminants, mirroring the IDL constants the web app reads. */
export const STATUS_OPEN = 0;
export const STATUS_ACCEPTED = 1;
export const STATUS_DELIVERED = 2;
export const STATUS_DISPUTED = 3;

export type Booking = {
  bookingId: bigint;
  amount: bigint;
  shipper: PublicKey;
  carrier: PublicKey;
  mint: PublicKey;
  status: number;
  bump: number;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  pickupDate: number;
  dropoffDate: number;
  deliveredAt: number;
};

export type BookingRow = { pda: PublicKey; account: Booking };

/** 8-byte Anchor discriminator + the fixed-size fields the current program
 *  defines. Matches idl.accounts.Booking exactly. */
export const BOOKING_ACCOUNT_BYTES = 162;

/**
 * The web version leans on Node Buffer's readInt32LE. React Native's Buffer
 * polyfill has it, but a DataView works on a plain Uint8Array too and does
 * not depend on which shape web3.js hands back — worth the few extra lines
 * given this is the one place a silent mis-decode would poison every screen.
 */
export function decodeBooking(data: Uint8Array): Booking {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8; // Anchor account discriminator

  const u64 = () => {
    const v = view.getBigUint64(o, true);
    o += 8;
    return v;
  };
  const key = () => {
    const k = new PublicKey(data.slice(o, o + 32));
    o += 32;
    return k;
  };
  const i32 = () => {
    const v = view.getInt32(o, true);
    o += 4;
    return v;
  };

  const bookingId = u64();
  const amount = u64();
  const shipper = key();
  const carrier = key();
  const mint = key();
  const status = data[o]; o += 1;
  const bump = data[o]; o += 1;
  const pickupLat = i32();
  const pickupLng = i32();
  const dropoffLat = i32();
  const dropoffLng = i32();

  // Length-guarded tail — same reasoning as the web decoder's comments.
  let pickupDate = 0;
  let dropoffDate = 0;
  if (data.length >= o + 16) {
    pickupDate = Number(u64());
    dropoffDate = Number(u64());
  }
  let deliveredAt = 0;
  if (data.length >= o + 8) {
    deliveredAt = Number(u64());
  }

  return {
    bookingId, amount, shipper, carrier, mint, status, bump,
    pickupLat, pickupLng, dropoffLat, dropoffLng, pickupDate, dropoffDate, deliveredAt,
  };
}

/** Same split the web client makes: mine = assigned to this carrier,
 *  open = unassigned and still STATUS_OPEN. */
export async function fetchCarrierBookings(
  connection: Connection,
  walletPk: PublicKey
): Promise<{ mine: BookingRow[]; open: BookingRow[] }> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID);
  const mine: BookingRow[] = [];
  const open: BookingRow[] = [];
  for (const { pubkey, account } of accounts) {
    // A Booking is 162 bytes (8 discriminator + 154 of fixed-size fields).
    // ANYTHING SHORTER IS A PRE-UPGRADE ACCOUNT the deployed program can no
    // longer deserialize — accept() on one fails with AnchorError 3003
    // AccountDidNotDeserialize before any logic runs. Confirmed on devnet
    // 2026-09-18: a 154-byte booking (missing delivered_at, added alongside
    // mark_delivered) simulated as 3003 while a 162-byte one simulated
    // clean. The old `< 154` floor let exactly those through, so both
    // clients listed un-acceptable loads as open. Kept as >= rather than
    // === so a future field addition widens rather than breaks this.
    if (account.data.length < BOOKING_ACCOUNT_BYTES) continue;
    try {
      const acc = decodeBooking(new Uint8Array(account.data));
      if (acc.carrier.equals(walletPk)) mine.push({ pda: pubkey, account: acc });
      else if (acc.status === STATUS_OPEN && acc.carrier.equals(PublicKey.default)) {
        open.push({ pda: pubkey, account: acc });
      }
    } catch {
      continue;
    }
  }
  return { mine, open };
}


/** Offset of `shipper` inside a Booking account: 8 discriminator + 8
 *  booking_id + 8 amount. Mirrors SHIPPER_OFFSET in the web client's
 *  constants.js. getProgramAccounts' memcmp compares raw account bytes, so
 *  this has to agree with decodeBooking's field order above — get it wrong
 *  and the filter silently matches nothing, which looks exactly like a
 *  shipper with no bookings. */
export const SHIPPER_OFFSET = 24;

/**
 * The shipper's own bookings, split the way ShipmentsView.jsx splits them.
 *
 * Unlike fetchCarrierBookings, this filters SERVER-side with a memcmp on
 * `shipper` instead of pulling every program account down and discarding
 * most of them. The web client does the same; over a phone connection the
 * difference is one wallet's rows versus the whole program's.
 *
 * `transit` / `waiting` are the web's own names for the two groups, and the
 * split is on status alone — deliberately NOT on `carrier` as the carrier
 * scan does. cancel.rs gates on `booking.status == STATUS_OPEN` and nothing
 * else, so splitting on status is what makes `waiting` mean exactly "the
 * set cancel() will accept". Any other predicate here would offer the
 * shipper a Cancel button the chain then refuses.
 */
export async function fetchShipperBookings(
  connection: Connection,
  walletPk: PublicKey
): Promise<{ transit: BookingRow[]; waiting: BookingRow[] }> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: SHIPPER_OFFSET, bytes: walletPk.toBase58() } }],
  });

  const rows: BookingRow[] = [];
  for (const { pubkey, account } of accounts) {
    // Same pre-upgrade floor as the carrier scan: a shorter account is one
    // the deployed program can no longer deserialize, so cancel() on it
    // fails with AnchorError 3003 before any logic runs. Devnet still holds
    // four of these (81/122/138/154 bytes) — listing one would show a
    // booking that can never be cancelled.
    if (account.data.length < BOOKING_ACCOUNT_BYTES) continue;
    try {
      rows.push({ pda: pubkey, account: decodeBooking(new Uint8Array(account.data)) });
    } catch {
      continue;
    }
  }

  // Newest first, matching the web's `b.account.bookingId.cmp(a.account.bookingId)`.
  // bookingId is a bigint here rather than a BN, so it compares directly —
  // but the comparator must still return a number, and `b - a` on bigints
  // returns a bigint, which Array.sort silently mis-handles.
  rows.sort((a, b) =>
    a.account.bookingId < b.account.bookingId
      ? 1
      : a.account.bookingId > b.account.bookingId
        ? -1
        : 0
  );

  return {
    transit: rows.filter((r) => r.account.status !== STATUS_OPEN),
    waiting: rows.filter((r) => r.account.status === STATUS_OPEN),
  };
}
export type StatusKey = 'open' | 'transit' | 'delivered' | 'disputed';

export function statusOf(a: Booking): StatusKey {
  if (a.status === STATUS_DISPUTED) return 'disputed';
  if (a.status === STATUS_DELIVERED) return 'delivered';
  if (a.status === STATUS_ACCEPTED) return 'transit';
  return 'open';
}

/** Coordinates are stored scaled x1e6 on-chain. */
export function coords(a: Booking) {
  return {
    pickup: { lat: a.pickupLat / 1e6, lng: a.pickupLng / 1e6 },
    dropoff: { lat: a.dropoffLat / 1e6, lng: a.dropoffLng / 1e6 },
  };
}

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
