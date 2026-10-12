import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';

import idl from '@/idl/pura_escrow.json';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
} from './ata';
import { recordCargoCompletion } from './cargo';
import { FEE_PAYER, PROGRAM_ID, USDC_MINT } from './constants';
import { type SigningWallet } from './profile';
import { buildAndSimulate, sponsorSignAndSend } from './sponsor';

/**
 * The shipper's cancel flow: refund the escrow and close the booking.
 *
 * Ported from ShipmentsView.jsx's cancel(), same structure as accept.ts —
 * no Anchor, instruction built by hand from the IDL, simulated before any
 * wallet prompt, sponsored by the platform.
 *
 * WHAT CANCEL CAN AND CANNOT DO. cancel.rs carries
 * `constraint = booking.status == STATUS_OPEN @ CannotCancelClaimed`, so
 * this only ever works on a still-open, unclaimed listing. Once a carrier
 * has accepted, the chain refuses outright and the booking can only be
 * unwound through dispute()/resolve_dispute(), which the carrier has a say
 * in. That constraint is the fix for what the program's own review called
 * its single worst finding — a shipper used to be able to cancel mid-
 * delivery and take a full refund. The UI must not offer Cancel on a
 * claimed booking; fetchShipperBookings' `waiting` group is exactly the
 * cancellable set.
 *
 * THE COMPLETION WRITE IS NOT OPTIONAL. cancel() closes the on-chain
 * account, so the outcome survives nowhere unless recordCargoCompletion
 * lands it in D1. Shipping the transaction without it would delete the
 * booking from both clients' History permanently. See cargo.ts.
 */

/** From the IDL, not hardcoded — same rule accept.ts and constants.ts follow. */
const CANCEL_DISCRIMINATOR = Buffer.from(
  (idl.instructions.find((i) => i.name === 'cancel')?.discriminator ?? []) as number[]
);

/**
 * `cancel(booking_id: u64)` — 8 bytes of discriminator followed by the id
 * little-endian, which is how Anchor serialises a bare u64 argument. Borsh
 * has no length prefix or padding for a fixed-width scalar, so the data is
 * exactly 16 bytes.
 *
 * The u64 goes in via DataView rather than Buffer.writeBigUInt64LE for the
 * same reason chain.ts decodes with one: the `buffer` polyfill's BigInt
 * methods are not reliably typed or present in React Native, while
 * DataView.setBigUint64 is part of the JS engine itself.
 */
function cancelData(bookingId: bigint): Buffer {
  const data = new Uint8Array(CANCEL_DISCRIMINATOR.length + 8);
  data.set(CANCEL_DISCRIMINATOR, 0);
  new DataView(data.buffer).setBigUint64(CANCEL_DISCRIMINATOR.length, bookingId, true);
  return Buffer.from(data);
}

/**
 * Account order is fixed by cancel.rs's #[derive(Accounts)] struct and is
 * load-bearing twice over: Anchor matches positionally, and
 * worker/index.js's validateInstructions destructures indices 0 and 2 to
 * check the signer and that fee_payer is really the platform's. cancel.rs
 * has a comment about deliberately appending `mint` after the token
 * accounts for exactly that reason — so this order is not cosmetic and must
 * not be "tidied".
 *
 * Note what is NOT here: any ATA-create instruction. shipper_token_account
 * has no init_if_needed in cancel.rs — it must already exist, which it does,
 * since the shipper funded the escrow from it at initialize(). The worker
 * enforces this independently with `instructions.length !== 1`, so a
 * defensive idempotent create would be rejected outright, not ignored.
 */
export function buildCancelInstruction(
  shipper: PublicKey,
  bookingPda: PublicKey,
  bookingId: bigint
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: shipper, isSigner: true, isWritable: false },
      { pubkey: bookingPda, isSigner: false, isWritable: true },
      { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(bookingPda, USDC_MINT), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(shipper, USDC_MINT), isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: cancelData(bookingId),
  });
}

export type CancelResult = {
  signature: string;
  /** False when the on-chain cancel succeeded but the D1 record did not —
   *  the refund is real and final, but this booking will be missing from
   *  History. The UI must say so rather than reporting a clean success. */
  recorded: boolean;
};

export async function cancelBooking(
  wallet: SigningWallet,
  bookingPda: PublicKey,
  bookingId: bigint,
  amountRaw: bigint
): Promise<CancelResult> {
  const shipper = new PublicKey(wallet.address);

  // 1-2. Build and PRE-FLIGHT SIMULATE before any wallet prompt. sigVerify
  //       is off, so cancel.rs's own status constraint runs here — a booking
  //       a carrier accepted in the seconds since the list was fetched fails
  //       as CannotCancelClaimed now, for free, instead of after a tap.
  const tx = await buildAndSimulate({
    wallet,
    instructions: [buildCancelInstruction(shipper, bookingPda, bookingId)],
    tag: 'cancel',
    failure: ({ err, anchorLine }) =>
      new Error(
        anchorLine
          ? `This load can't be cancelled — ${anchorLine.replace(/^Program log: /, '')}`
          : `This load can't be cancelled (${JSON.stringify(err)}).`
      ),
  });

  // 3-6. Sponsorship auth, wallet signature, worker countersignature, submit.
  const signature = await sponsorSignAndSend({ wallet, tx, kind: 'cancel', tag: 'cancel' });

  // 7. The escrow is refunded and the account is closed. This is the last
  //    moment the outcome exists anywhere — see cargo.ts. Never throws, so
  //    a D1 failure cannot be mistaken for a failed cancel.
  const recorded = await recordCargoCompletion(
    wallet,
    bookingPda.toBase58(),
    'cancelled',
    amountRaw
  );

  return { signature, recorded };
}
