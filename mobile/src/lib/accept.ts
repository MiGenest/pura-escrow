import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';

import idl from '@/idl/pura_escrow.json';
import { API, PROGRAM_ID } from './constants';
import { type SigningWallet } from './profile';
import { buildAndSimulate, signWithRetry, sponsorSignAndSend } from './sponsor';

/**
 * The accept flow: an on-chain state change, sponsored by the platform.
 *
 * Unlike auth and profile, this is not a free retry — it claims a real
 * booking. Every step below is a port of solana/app/src/lib/transactions.js's
 * sponsorAndSend plus CarrierView's accept(), verified offline against the
 * worker's own checks before it was written (see the dry run: 13/13, no
 * submission).
 *
 * No Anchor. `accept` takes no args and two accounts, so the instruction is
 * eight bytes of discriminator and two keys — Anchor would be a dependency
 * bought for nothing, same reasoning as the read-only decoder.
 */

/** From the IDL, not hardcoded — same rule the rest of the app follows. */
const ACCEPT_DISCRIMINATOR = Buffer.from(
  (idl.instructions.find((i) => i.name === 'accept')?.discriminator ?? []) as number[]
);

const PLATFORM_FEE_BPS = Number(
  idl.constants.find((c) => c.name === 'PLATFORM_FEE_BPS')?.value ?? 0
);
const BPS_DENOMINATOR = 10_000;

/** Mirrors release.rs's integer math exactly (floor), so the number shown
 *  before accepting matches what the chain will actually pay out. */
export const netAfterPlatformFee = (grossRaw: number) =>
  grossRaw - Math.floor((grossRaw * PLATFORM_FEE_BPS) / BPS_DENOMINATOR);

export const PLATFORM_FEE_PCT = PLATFORM_FEE_BPS / 100;

const CARGO_ACCEPT_MESSAGE_PREFIX = 'pura:cargo-accept:';

export function buildAcceptInstruction(carrier: PublicKey, bookingPda: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    // Order matters: the worker derives the expected signer from keys[0]
    // (validateInstructions' accept branch), so this is load-bearing, not
    // cosmetic.
    keys: [
      { pubkey: carrier, isSigner: true, isWritable: false },
      { pubkey: bookingPda, isSigner: false, isWritable: true },
    ],
    data: ACCEPT_DISCRIMINATOR,
  });
}

export type AcceptResult = { signature: string; metaSynced: boolean };

export async function acceptBooking(
  wallet: SigningWallet,
  bookingPda: PublicKey
): Promise<AcceptResult> {
  const carrier = new PublicKey(wallet.address);

  // 1-2. build and PRE-FLIGHT SIMULATE, before any wallet prompt. This is
  //       what catches a stale pre-upgrade booking (AnchorError 3003)
  //       cheaply, and it absorbs a stale blockhash on its own — see
  //       buildAndSimulate.
  const tx = await buildAndSimulate({
    wallet,
    instructions: [buildAcceptInstruction(carrier, bookingPda)],
    tag: 'accept',
    failure: ({ err, anchorLine }) =>
      new Error(
        anchorLine
          ? `This load can't be accepted — ${anchorLine.replace(/^Program log: /, '')}`
          : `This load can't be accepted (${JSON.stringify(err)}).`
      ),
  });

  // 3-6. sponsorship auth, signature, worker countersignature, submit —
  //       all of it shared with the booking flow now, see lib/sponsor.ts.
  const signature = await sponsorSignAndSend({ wallet, tx, kind: 'accept', tag: 'accept' });

  // 7. best-effort D1 mirror so GET /api/cargo starts returning the
  //    shipper's contact details for this booking. A failure here does NOT
  //    undo the acceptance — the chain is already authoritative.
  let metaSynced = false;
  try {
    // Retried once on a wallet-bridge hiccup — see signWithRetry. The
    // acceptance is already on-chain, so this cannot lose the job; what it
    // loses is cargo.carrier, the MIRROR that GET /api/cargo uses to decide
    // whether this wallet may see the shipper's contact details. A carrier
    // whose mirror write failed also cannot upload a delivery photo (the
    // worker's photo route 403s on exactly that column), so the cost of
    // metaSynced=false here is wider than it looks.
    const acceptAuth = await signWithRetry(wallet, CARGO_ACCEPT_MESSAGE_PREFIX, 'accept');
    const r = await fetch(`${API}/api/cargo/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        booking_pda: bookingPda.toBase58(),
        wallet: wallet.address,
        message: acceptAuth.message,
        signature: acceptAuth.signature,
      }),
    });
    metaSynced = r.ok;
    console.log(`[accept] cargo/accept mirror: ${r.status}`);
  } catch (err) {
    console.log('[accept] cargo/accept mirror failed (non-fatal)', String(err));
  }

  return { signature, metaSynced };
}
