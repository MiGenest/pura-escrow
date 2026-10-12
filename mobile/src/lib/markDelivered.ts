import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';

import idl from '@/idl/pura_escrow.json';
import { PROGRAM_ID, REVIEW_WINDOW_SECS } from './constants';
import { type SigningWallet } from './profile';
import { buildAndSimulate, sponsorSignAndSend } from './sponsor';

/**
 * mark_delivered() — the carrier self-attests delivery on-chain.
 *
 * The simplest instruction in the program: no arguments, two accounts, and
 * NO token accounts at all — no mint, no vault, no ATA, not even fee_payer.
 * Sponsorship still works because the fee payer is the TRANSACTION's fee
 * payer, not an instruction account; that is also why the worker's
 * validateInstructions branch for this kind only checks the instruction
 * count and reads keys[0], with no requireRealFeePayer call to make.
 * assertFeePayerIsSponsor still covers the transaction-level check.
 *
 * What it writes is two fields:
 *   booking.status       = STATUS_DELIVERED
 *   booking.delivered_at = Clock::get().unix_timestamp
 *
 * That timestamp is the whole point. It starts the shipper's
 * REVIEW_WINDOW_SECS clock: the shipper may release or dispute at any time
 * after it, and if they do neither, the carrier may self-release once the
 * window elapses (see release.rs's dual-authority check). Everything in the
 * carrier's claim path is derived from this one number being correct.
 *
 * NOT A REVERSIBLE ACTION. mark_delivered.rs requires
 * `booking.status == STATUS_ACCEPTED`, so a second call fails with
 * NotAccepted — there is no un-deliver. The only way back is dispute().
 *
 * KNOWN GAP — no proof-of-delivery photo. mark_delivered.rs says in so many
 * words that "the client should require a delivery photo be attached before
 * it lets a carrier call this — that's a UX gate, not an on-chain one". This
 * app does not enforce it: a carrier can mark delivery without a photo.
 *
 * KNOWN GAP — no shipper notification: a shipper whose carrier marks delivery
 * from the app is not told until they open it.
 */

/** From the IDL, not hardcoded — same rule accept/cancel/release follow. */
const MARK_DELIVERED_DISCRIMINATOR = Buffer.from(
  (idl.instructions.find((i) => i.name === 'mark_delivered')?.discriminator ?? []) as number[]
);

/**
 * Two keys, in mark_delivered.rs's declared order. keys[0] is what the
 * worker reads as the wallet whose signature the sponsorship rides on, so
 * the order is load-bearing even with only two accounts.
 */
export function buildMarkDeliveredInstruction(
  carrier: PublicKey,
  bookingPda: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: carrier, isSigner: true, isWritable: false },
      { pubkey: bookingPda, isSigner: false, isWritable: true },
    ],
    // No args: the data is the bare 8-byte discriminator.
    data: MARK_DELIVERED_DISCRIMINATOR,
  });
}

export async function markDelivered(
  wallet: SigningWallet,
  bookingPda: PublicKey
): Promise<{ signature: string }> {
  const carrier = new PublicKey(wallet.address);

  // Pre-flight simulate before any wallet prompt. This is where a booking
  // someone already marked, or one this wallet does not carry, surfaces as
  // NotAccepted / NotShipperOrCarrier for free.
  const tx = await buildAndSimulate({
    wallet,
    instructions: [buildMarkDeliveredInstruction(carrier, bookingPda)],
    tag: 'delivered',
    failure: ({ err, anchorLine }) =>
      new Error(
        anchorLine
          ? `This load can't be marked delivered — ${anchorLine.replace(/^Program log: /, '')}`
          : `This load can't be marked delivered (${JSON.stringify(err)}).`
      ),
  });

  const signature = await sponsorSignAndSend({
    wallet, tx, kind: 'mark_delivered', tag: 'delivered',
  });
  return { signature };
}

/**
 * Milliseconds until this booking becomes self-releasable, or 0 once it is.
 *
 * ADVISORY ONLY. The program compares against the CLUSTER's
 * Clock::unix_timestamp, not the phone's, so a device with a skewed clock
 * will disagree at the margin. Fine for rendering a countdown; never treat
 * it as permission — the simulate in releaseBooking is what actually
 * decides, and returns ReviewWindowNotElapsed if this was optimistic.
 */
export function msUntilClaimable(deliveredAtUnixSecs: number): number {
  if (!deliveredAtUnixSecs) return Number.POSITIVE_INFINITY;
  const readyAtMs = (deliveredAtUnixSecs + REVIEW_WINDOW_SECS) * 1000;
  return Math.max(0, readyAtMs - Date.now());
}

/** "41h 12m" / "58m" / "under a minute". Deliberately coarse: a countdown to
 *  the second on a 48-hour wait is false precision, and re-rendering every
 *  second to show it would be worse. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return 'once delivery is confirmed';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'under a minute';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
