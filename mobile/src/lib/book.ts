import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';

import idl from '@/idl/pura_escrow.json';
import {
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from './ata';
import {
  API,
  FEE_PAYER,
  MIN_SHARE,
  PROGRAM_ID,
  RATE_PER_KM_USD,
  REF_LOAD_KG,
  REF_LOAD_M3,
  USDC_MINT,
  type VehicleType,
} from './constants';
import { resolveCorridor } from './corridor';
import type { Place } from './geo';
import { type SigningWallet } from './profile';
import { connection } from './solana';
import { buildAndSimulate, signWithRetry, sponsorSignAndSend } from './sponsor';

/**
 * Posting a load: the shipper side of the escrow.
 *
 * Port of the web client's createBooking(). The order of operations is the
 * part worth being careful about, because it is not what "create a booking"
 * suggests:
 *
 *   1. build `initialize` (+ an idempotent create of the shipper's own ATA)
 *   2. simulate
 *   3. sign, sponsor, submit          <- USDC LEAVES THE WALLET HERE
 *   4. POST /api/cargo                <- metadata, best-effort, may fail
 *
 * Step 4 failing is survivable and deliberately not fatal: the escrow is
 * already live on-chain, and the web client reports the same state as
 * "sync pending" rather than an error. Step 3 failing means nothing
 * happened at all.
 *
 * No Anchor, same as accept.ts. `initialize` is a 56-byte data buffer and
 * ten accounts whose order and addresses the IDL already pins.
 */

type IdlAccount = { name: string; signer?: boolean; writable?: boolean; address?: string };

const INITIALIZE_DISCRIMINATOR = Buffer.from(
  (idl.instructions.find((i) => i.name === 'initialize')?.discriminator ?? []) as number[]
);

/** Account order is not a style choice: worker/index.js's validateInstructions
 *  destructures these positionally to re-derive the booking PDA, both ATAs
 *  and the real fee payer, and rejects the transaction on any mismatch. Taking
 *  the order (and the fixed addresses) from the IDL rather than retyping them
 *  makes that impossible to get subtly wrong. */
const INITIALIZE_ACCOUNTS = (idl.instructions.find((i) => i.name === 'initialize')?.accounts ??
  []) as IdlAccount[];

const CARGO_MESSAGE_PREFIX = 'pura:cargo:';

/* ------------------------------ pricing ------------------------------ *
 * Computed, never entered. Same formula as BookView, so the same load
 * prices identically on both clients — which matters while they write to
 * the same escrow program and the same D1 table.
 * -------------------------------------------------------------------- */

/** A partial load pays a proportional share of the lane, floored at
 *  MIN_SHARE: whichever of weight or volume fills more of a reference
 *  truck wins. */
export function loadFactorFor(weightKg: number, volumeM3: number): number {
  return Math.min(1, Math.max(MIN_SHARE, weightKg / REF_LOAD_KG, volumeM3 / REF_LOAD_M3));
}

export function priceUsdFor(km: number, weightKg: number, volumeM3: number): number {
  return km * RATE_PER_KM_USD * loadFactorFor(weightKg, volumeM3);
}

/** What actually gets locked. Whole USDC, minimum 1 — a booking worth $0
 *  would still cost the platform rent, and the web client rounds the same
 *  way, so the two must not disagree. */
export const amountUsdcFor = (priceUsd: number) => Math.max(1, Math.round(priceUsd));

/* ----------------------------- instruction ---------------------------- */

/** u64 little-endian, for the PDA seed. */
function u64LEBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  new DataView(buf.buffer, buf.byteOffset, 8).setBigUint64(0, value, true);
  return buf;
}

export function bookingPdaFor(shipper: PublicKey, bookingId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('booking'), shipper.toBuffer(), u64LEBytes(bookingId)],
    PROGRAM_ID
  );
  return pda;
}

/**
 * 8 discriminator + u64 amount + u64 booking_id + 4x i32 coords + 2x i64
 * dates = 56 bytes, in the IDL's declared argument order.
 *
 * The worker reads booking_id straight back out at offset 16 to re-derive
 * the PDA, so the layout is verified server-side on every post — a shifted
 * field here is a rejected transaction, not a silently wrong booking.
 */
function initializeData(args: {
  amountUsdc: number;
  bookingId: bigint;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  pickupDateUnix: number;
  dropoffDateUnix: number;
}): Buffer {
  const data = Buffer.alloc(8 + 8 + 8 + 4 * 4 + 8 * 2);
  INITIALIZE_DISCRIMINATOR.copy(data, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // USDC has 6 decimals; amountUsdc is whole dollars.
  view.setBigUint64(8, BigInt(args.amountUsdc) * 1_000_000n, true);
  view.setBigUint64(16, args.bookingId, true);
  view.setInt32(24, args.pickupLat, true);
  view.setInt32(28, args.pickupLng, true);
  view.setInt32(32, args.dropoffLat, true);
  view.setInt32(36, args.dropoffLng, true);
  view.setBigInt64(40, BigInt(args.pickupDateUnix), true);
  view.setBigInt64(48, BigInt(args.dropoffDateUnix), true);
  return data;
}

function buildInitializeInstruction(
  supplied: Record<string, PublicKey>,
  data: Buffer
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: INITIALIZE_ACCOUNTS.map((a) => {
      const pubkey = supplied[a.name] ?? (a.address ? new PublicKey(a.address) : undefined);
      if (!pubkey) throw new Error(`no pubkey for initialize account "${a.name}"`);
      return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable };
    }),
    data,
  });
}

export type InitializeArgs = {
  shipper: PublicKey;
  bookingId: bigint;
  amountUsdc: number;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  pickupDateUnix: number;
  dropoffDateUnix: number;
};

/**
 * Everything that goes into the transaction, and nothing that talks to the
 * network — exported, like accept.ts's buildAcceptInstruction, so the exact
 * bytes this produces can be run against the worker's own
 * validateInstructions offline before anything is ever signed.
 *
 * The ATA create comes FIRST and the escrow call LAST. That is not stylistic:
 * the worker takes instructions[length - 1] as the escrow call and requires
 * every instruction before it to be an idempotent create of the shipper's own
 * ATA, paid by the real fee payer.
 */
export function buildInitializeInstructions(args: InitializeArgs): {
  instructions: TransactionInstruction[];
  bookingPda: PublicKey;
  shipperTokenAccount: PublicKey;
  escrowVault: PublicKey;
} {
  const bookingPda = bookingPdaFor(args.shipper, args.bookingId);
  const shipperTokenAccount = associatedTokenAddress(args.shipper, USDC_MINT);
  const escrowVault = associatedTokenAddress(bookingPda, USDC_MINT);

  const initIx = buildInitializeInstruction(
    {
      shipper: args.shipper,
      booking: bookingPda,
      // No carrier yet — the program takes the default pubkey as
      // "unassigned", and fetchCarrierBookings() reads exactly that back as
      // an open load.
      carrier: PublicKey.default,
      shipper_token_account: shipperTokenAccount,
      escrow_vault: escrowVault,
    },
    initializeData({
      amountUsdc: args.amountUsdc,
      bookingId: args.bookingId,
      pickupLat: scaleCoord(args.pickup.lat),
      pickupLng: scaleCoord(args.pickup.lng),
      dropoffLat: scaleCoord(args.dropoff.lat),
      dropoffLng: scaleCoord(args.dropoff.lng),
      pickupDateUnix: args.pickupDateUnix,
      dropoffDateUnix: args.dropoffDateUnix,
    })
  );

  return {
    instructions: [
      // Defensive, and the only instruction the worker tolerates before
      // `initialize`: the ATA is normally created at connect time, so this is
      // usually a no-op. initialize() pays the booking and vault rent itself
      // through the fee_payer account — there is no top-up transfer to build.
      createAssociatedTokenAccountIdempotentInstruction(
        FEE_PAYER,
        shipperTokenAccount,
        args.shipper,
        USDC_MINT
      ),
      initIx,
    ],
    bookingPda,
    shipperTokenAccount,
    escrowVault,
  };
}

/** Coordinates are stored scaled x1e6 on-chain, as i32. */
const scaleCoord = (deg: number) => Math.round(deg * 1e6);

/** '2026-09-18' -> unix seconds; empty -> 0, same as the web client's
 *  dateToUnix, and 0 is what every booking posted before dates existed
 *  carries. */
export function dateToUnix(dateStr: string): number {
  if (!dateStr) return 0;
  const ms = new Date(dateStr).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/* ------------------------------- balance ------------------------------ */

/**
 * The shipper's test-USDC balance. Returns 0 rather than throwing when the
 * ATA does not exist yet, which is the state of every wallet that has never
 * been funded — getTokenAccountBalance errors on a missing account.
 */
export async function fetchUsdcBalance(owner: PublicKey): Promise<number> {
  try {
    const ata = associatedTokenAddress(owner, USDC_MINT);
    const res = await connection.getTokenAccountBalance(ata);
    return res.value.uiAmount ?? 0;
  } catch {
    return 0;
  }
}

/* -------------------------------- post -------------------------------- */

export type NewLoad = {
  pickup: Place;
  dropoff: Place;
  weightKg: number;
  volumeM3: number;
  description: string;
  requiredVehicleType: VehicleType | null;
  pickupDate: string;
  dropoffDate: string;
  /** The person at the warehouse / at delivery — optional, and distinct from
   *  the shipper's own account contact below. A carrier with neither falls
   *  back to the account contact, which is how the web client reads them. */
  pickupContactName: string;
  pickupContactPhone: string;
  dropoffContactName: string;
  dropoffContactPhone: string;
  /** The shipper's OWN name and phone, from their profile — BookView takes
   *  these from profile.name/profile.phone, never from the form. */
  contactName: string;
  contactPhone: string;
  distanceKm: number | null;
  priceUsd: number;
  amountUsdc: number;
};

export type PostedLoad = {
  bookingPda: PublicKey;
  signature: string;
  /** false when the on-chain escrow succeeded but POST /api/cargo did not —
   *  the booking exists and is claimable, it just carries no route names,
   *  weight or contact details until it is re-synced. */
  metaSynced: boolean;
};

export async function postLoad(wallet: SigningWallet, load: NewLoad): Promise<PostedLoad> {
  const shipper = new PublicKey(wallet.address);
  // Same id source as the web client. Collisions would need two posts from
  // the same wallet inside one millisecond; the PDA derivation makes a
  // collision a failed transaction rather than an overwrite.
  const bookingId = BigInt(Date.now());

  const { instructions, bookingPda } = buildInitializeInstructions({
    shipper,
    bookingId,
    amountUsdc: load.amountUsdc,
    pickup: load.pickup,
    dropoff: load.dropoff,
    pickupDateUnix: dateToUnix(load.pickupDate),
    dropoffDateUnix: dateToUnix(load.dropoffDate),
  });

  // PRE-FLIGHT SIMULATION, before any wallet prompt — same lesson accept.ts
  // learned on 2026-09-18, and it also absorbs a stale blockhash on its own
  // (see buildAndSimulate). Here it catches the case the form's balance check
  // cannot: a balance that was sufficient when the screen loaded and is not
  // any more.
  console.log(`[book] posting amount=${load.amountUsdc} pda=${bookingPda.toBase58()}`);
  const tx = await buildAndSimulate({
    wallet,
    instructions,
    tag: 'book',
    failure: ({ err, logs, anchorLine }) => {
      if (logs.some((l) => /insufficient funds/i.test(l))) {
        return new Error(`Not enough USDC — this load locks $${load.amountUsdc}.`);
      }
      return new Error(
        anchorLine
          ? `This load can't be posted — ${anchorLine.replace(/^Program log: /, '')}`
          : `This load can't be posted (${JSON.stringify(err)}).`
      );
    },
  });

  const signature = await sponsorSignAndSend({ wallet, tx, kind: 'initialize', tag: 'book' });

  // Off-chain metadata. Everything the carrier's list actually renders lives
  // here — the chain holds only coordinates and an amount.
  let metaSynced = false;
  try {
    // Not retried on a wallet-bridge failure, unlike the fee-payer
    // signature — see signFeePayerAuth's note. Worth remembering that the
    // cost here is not symmetric: the contact columns are INSERT-only, so a
    // row that never lands can never be given contact details later.
    // Retried once on a wallet-bridge hiccup, same helper the fee-payer
    // signature uses. The chain write has already confirmed by this point, so
    // a failure here does not lose the booking — it loses its METADATA, and
    // that is unrecoverable: the worker's ON CONFLICT never updates route
    // names, weight or contact details, so a booking posted with
    // metaSynced=false keeps a blank card forever. Worth a second attempt.
    const auth = await signWithRetry(wallet, CARGO_MESSAGE_PREFIX, 'book');
    const corridor = resolveCorridor(load.pickup.country, load.dropoff.country);
    const res = await fetch(`${API}/api/cargo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        booking_pda: bookingPda.toBase58(),
        shipper: wallet.address,
        weight_kg: load.weightKg,
        volume_m3: load.volumeM3,
        description: load.description,
        required_vehicle_type: load.requiredVehicleType,
        pickup_name: load.pickup.name,
        dropoff_name: load.dropoff.name,
        price_usd: Math.round(load.priceUsd),
        distance_km: load.distanceKm,
        // The shipper's own account contact. The worker stores these
        // INSERT-only — its ON CONFLICT branch updates weight, volume,
        // description, waypoints and vehicle type, and nothing else — so
        // whatever goes in here is what a carrier sees for the life of the
        // booking. That is why the profile's phone is now kept locally.
        contact_name: load.contactName,
        contact_phone: load.contactPhone,
        pickup_contact_name: load.pickupContactName || null,
        pickup_contact_phone: load.pickupContactPhone || null,
        dropoff_contact_name: load.dropoffContactName || null,
        dropoff_contact_phone: load.dropoffContactPhone || null,
        // No waypoints on this screen yet; the column is nullable and the
        // web client sends null for a single-leg booking too.
        waypoints: null,
        // All three optional. The worker re-derives the corridor from the two
        // country codes and 400s on a mismatch — so sending our own answer is
        // a consistency check, not a claim it would otherwise trust.
        corridor,
        pickup_country: load.pickup.country,
        dropoff_country: load.dropoff.country,
        message: auth.message,
        signature: auth.signature,
      }),
    });
    metaSynced = res.ok;
    console.log(`[book] cargo metadata: ${res.status}`);
    if (!res.ok) {
      console.log(`[book] cargo body: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    }
  } catch (err) {
    console.log('[book] cargo metadata failed (non-fatal)', String(err));
  }

  return { bookingPda, signature, metaSynced };
}
