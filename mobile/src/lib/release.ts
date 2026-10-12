import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';

import idl from '@/idl/pura_escrow.json';
import { netAfterPlatformFee } from './accept';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from './ata';
import { recordCargoCompletion } from './cargo';
import { FEE_PAYER, PLATFORM_TREASURY_TOKEN_ACCOUNT, PROGRAM_ID, USDC_MINT } from './constants';
import { connection } from './solana';
import { type SigningWallet } from './profile';
import { buildAndSimulate, sponsorSignAndSend } from './sponsor';

/**
 * release() — pay the carrier and close the escrow.
 *
 * Same shape as cancel.ts: no Anchor, instruction built by hand from the
 * IDL, simulated before any wallet prompt, sponsored by the platform. Three
 * things make it meaningfully bigger than cancel, and all three are why it
 * was split into its own pass:
 *
 * 1. DUAL AUTHORITY. release.rs accepts either party, on different terms:
 *    the SHIPPER any time the booking is Accepted or Delivered ("it's their
 *    own money, an early release isn't a security issue" — release.rs), and
 *    the CARRIER only once status is Delivered AND REVIEW_WINDOW_SECS has
 *    elapsed since delivered_at. Which one is valid is not knowable from
 *    the account list, so the program decides in the handler. Client-side
 *    this is advisory gating only — see canCarrierSelfRelease below.
 *
 * 2. THE OPTIONAL ATA-CREATE. The carrier's USDC account may not exist
 *    (unlike cancel's shipper ATA, which necessarily does — they funded the
 *    escrow from it). An idempotent create is prepended when it is missing,
 *    paid by FEE_PAYER. The worker allows release to carry 1 or 2
 *    instructions for exactly this, and validates the create's payer/owner/
 *    mint/address if present.
 *
 * 3. A PLATFORM FEE IS TAKEN. The carrier receives less than the escrowed
 *    amount. The net is computed by netAfterPlatformFee, imported from
 *    accept.ts rather than re-derived here so both screens quote the same
 *    number from the same PLATFORM_FEE_BPS. (It lives in accept.ts for
 *    historical reasons — it was needed there first. If a third consumer
 *    appears it should move to its own module; two does not justify the
 *    churn on code that is already device-verified.)
 */

/** From the IDL, not hardcoded — same rule accept.ts and cancel.ts follow. */
const RELEASE_DISCRIMINATOR = Buffer.from(
  (idl.instructions.find((i) => i.name === 'release')?.discriminator ?? []) as number[]
);

/** `release(booking_id: u64)` — discriminator + the id little-endian, 16
 *  bytes total. DataView rather than Buffer.writeBigUInt64LE for the same
 *  reason cancel.ts uses it: the polyfill's BigInt methods are not reliably
 *  typed in React Native. */
function releaseData(bookingId: bigint): Buffer {
  const data = new Uint8Array(RELEASE_DISCRIMINATOR.length + 8);
  data.set(RELEASE_DISCRIMINATOR, 0);
  new DataView(data.buffer).setBigUint64(RELEASE_DISCRIMINATOR.length, bookingId, true);
  return Buffer.from(data);
}

/**
 * Twelve accounts, in release.rs's declared order.
 *
 * Load-bearing twice over, as with cancel: Anchor matches positionally, and
 * worker/index.js destructures indices 0, 3, 5 and 6 (authority, fee_payer,
 * carrier_token_account, carrier) to decide whose signature the sponsorship
 * rides on and to validate any ATA-create. release.rs's own comment notes
 * `mint` sits after the token accounts and before the programs precisely to
 * keep those indices stable — so this order must not be "tidied".
 *
 * `authority` is whoever is actually signing: the shipper or the carrier.
 * `shipper` at index 1 is separate and always the booking's shipper, since
 * it is what seeds the booking PDA.
 */
export function buildReleaseInstruction({
  authority,
  shipper,
  carrier,
  bookingPda,
  bookingId,
}: {
  authority: PublicKey;
  shipper: PublicKey;
  carrier: PublicKey;
  bookingPda: PublicKey;
  bookingId: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: shipper, isSigner: false, isWritable: false },
      { pubkey: bookingPda, isSigner: false, isWritable: true },
      { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(bookingPda, USDC_MINT), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(carrier, USDC_MINT), isSigner: false, isWritable: true },
      { pubkey: carrier, isSigner: false, isWritable: false },
      { pubkey: PLATFORM_TREASURY_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: releaseData(bookingId),
  });
}

/**
 * Advisory only — the chain is the authority.
 *
 * Mirrors web's reviewWindowElapsed(). Reading the wall clock here can only
 * ever be approximate: the program compares against the CLUSTER's
 * Clock::unix_timestamp, not the phone's, and a device with a skewed clock
 * would disagree. That is fine for deciding whether to SHOW a button — the
 * simulate catches a premature attempt as ReviewWindowNotElapsed before any
 * prompt — but it must never be treated as permission.
 */
export function canCarrierSelfRelease(status: number, deliveredAtUnixSecs: number): boolean {
  const STATUS_DELIVERED = Number(
    idl.constants.find((c) => c.name === 'STATUS_DELIVERED')?.value ?? 2
  );
  const REVIEW_WINDOW_SECS = Number(
    idl.constants.find((c) => c.name === 'REVIEW_WINDOW_SECS')?.value ?? 0
  );
  if (status !== STATUS_DELIVERED) return false;
  if (!deliveredAtUnixSecs) return false;
  return Date.now() / 1000 - deliveredAtUnixSecs >= REVIEW_WINDOW_SECS;
}

export type ReleaseResult = {
  signature: string;
  /** False when the chain succeeded but the D1 completion write did not —
   *  the carrier has been paid and the account is closed, but the booking
   *  will be missing from History. Same contract as cancel's. */
  recorded: boolean;
  /** Whether a carrier ATA had to be created as part of this release. */
  createdCarrierAta: boolean;
};

export async function releaseBooking({
  wallet,
  bookingPda,
  bookingId,
  shipper,
  carrier,
  amountRaw,
}: {
  wallet: SigningWallet;
  bookingPda: PublicKey;
  bookingId: bigint;
  shipper: PublicKey;
  carrier: PublicKey;
  amountRaw: bigint;
}): Promise<ReleaseResult> {
  const authority = new PublicKey(wallet.address);
  const carrierTokenAccount = associatedTokenAddress(carrier, USDC_MINT);

  // Checked live rather than assumed: a carrier who has never held USDC has
  // no ATA, and release.rs does NOT create one (no init_if_needed). Without
  // the prepended create the whole release fails on an account that does
  // not exist. Idempotent, so a race that creates it in between is a no-op
  // rather than a failure.
  const ataInfo = await connection.getAccountInfo(carrierTokenAccount);
  const createdCarrierAta = !ataInfo;
  console.log(`[release] carrier ATA ${createdCarrierAta ? 'MISSING — prepending create' : 'exists'}`);

  const releaseIx = buildReleaseInstruction({
    authority,
    shipper,
    carrier,
    bookingPda,
    bookingId,
  });

  const instructions = createdCarrierAta
    ? [
        // Payer is FEE_PAYER, not the authority — the platform funds this,
        // and the worker rejects any other payer (`unexpected ATA creation`).
        createAssociatedTokenAccountIdempotentInstruction(
          FEE_PAYER,
          carrierTokenAccount,
          carrier,
          USDC_MINT
        ),
        releaseIx,
      ]
    : [releaseIx];

  // Pre-flight simulate before any wallet prompt. This is where a carrier's
  // premature self-release surfaces as ReviewWindowNotElapsed, and where a
  // booking someone else already released surfaces as a closed account —
  // both for free, before the user spends a tap.
  const tx = await buildAndSimulate({
    wallet,
    instructions,
    tag: 'release',
    failure: ({ err, anchorLine }) =>
      new Error(
        anchorLine
          ? `This payment can't be released — ${anchorLine.replace(/^Program log: /, '')}`
          : `This payment can't be released (${JSON.stringify(err)}).`
      ),
  });

  const signature = await sponsorSignAndSend({ wallet, tx, kind: 'release', tag: 'release' });

  // Last moment the outcome exists anywhere — the account is closed by now.
  // Never throws; see cargo.ts. The GROSS escrowed amount is recorded, not
  // the carrier's net payout, matching what the web client records and what
  // History displays on both clients.
  const recorded = await recordCargoCompletion(
    wallet,
    bookingPda.toBase58(),
    'released',
    amountRaw
  );

  console.log(
    `[release] net to carrier ${netAfterPlatformFee(Number(amountRaw)) / 1e6} of ${Number(amountRaw) / 1e6}`
  );
  return { signature, recorded, createdCarrierAta };
}
