import { PublicKey } from '@solana/web3.js';

import { associatedTokenAddress } from './ata';

import idl from '@/idl/pura_escrow.json';

/**
 * Chain + backend constants for the native app.
 *
 * These mirror solana/app/src/constants.js, which remains the source of
 * truth while the web app is still the live client. Values are COPIED from
 * there deliberately rather than re-derived — a mobile build pointed at a
 * different program, mint or fee payer than the deployed web client would
 * produce transactions the on-chain program rejects, or worse, route money
 * somewhere nobody chose (see docs/RISK-REGISTER.md §7 rule 2).
 *
 * The program ID is read out of the committed IDL rather than pasted, for
 * the same reason solana/app does it: the client builds instructions from
 * the IDL's account ordering, so an ID that disagrees with the IDL beside it
 * is incoherent by construction. src/idl/pura_escrow.json is a byte-for-byte
 * copy of the web app's, pinned by the .sha256 next to it.
 */

/** Devnet throughout — mainnet is gated on the security audit. */
export const CLUSTER = 'devnet' as const;
export const RPC_HTTP = 'https://api.devnet.solana.com';
export const RPC_WS = 'wss://api.devnet.solana.com';

/** Anchor escrow program. Read from the IDL, never hardcoded. */
export const PROGRAM_ID = new PublicKey(idl.address);

/**
 * Cloudflare Worker serving /api/*. The web app uses a relative path in
 * production because the same Worker serves its static assets; a native
 * build has no such same-origin server, so it always needs the absolute URL
 * — exactly the branch solana/app/src/constants.js takes for Capacitor.
 */
export const API = 'https://pura.misha-9f1.workers.dev';

/**
 * Devnet test-USDC mint this deployment uses. Must match the worker's
 * USDC_MINT var and the program's EXPECTED_USDC_MINT.
 */
export const USDC_MINT = new PublicKey('DABiRdamfNZuxWaTHHWvKuMUW7TP6fmHdRXuPfr5duws');

/**
 * Fee-payer wallet that sponsors network fees and escrow rent so users never
 * need their own SOL. Pinned on-chain as EXPECTED_FEE_PAYER in the program's
 * constants.rs, so this is not a free choice — it must match the deployed
 * program or every instruction referencing it fails.
 */
export const FEE_PAYER = new PublicKey('DLYBFc7WpiZes9zAL5Az37sXTANAzK7xyUCMR9HHLpys');

/**
 * release()'s `treasury_token_account`.
 *
 * DERIVED, NOT PASTED — and that is a correction to the web client, whose
 * constants.js hardcodes this address under the comment "Fixed address, not
 * derived client-side". That claim does not survive reading release.rs: the
 * account carries `associated_token::authority = PLATFORM_TREASURY` and
 * `associated_token::mint = booking.mint`, which together say it is exactly
 * the canonical ATA of the treasury wallet for this mint — fully derivable,
 * and verified to equal web's hardcoded GSGbxLdL… (see the assertion below).
 *
 * What the web comment gets RIGHT is the security property, and it is worth
 * restating because it is the reason this is safe to derive: the caller
 * cannot substitute a different destination. PLATFORM_TREASURY is compiled
 * into the program, so a wrong address here fails the constraint rather than
 * misrouting the platform's fee. Deriving therefore trades nothing away.
 *
 * Same rule ata.ts already follows for the token programs: read the pinned
 * value from the IDL beside the code that uses it, so an address that
 * disagrees with the deployed program is impossible by construction rather
 * than by someone remembering to update two files.
 */
const PLATFORM_TREASURY = new PublicKey(
  idl.constants.find((c) => c.name === 'PLATFORM_TREASURY')?.value ?? ''
);

export const PLATFORM_TREASURY_TOKEN_ACCOUNT = associatedTokenAddress(
  PLATFORM_TREASURY,
  USDC_MINT
);

/**
 * Belt and braces. The derivation above is correct today and was checked
 * against both the deployed program and the live devnet account (right mint,
 * right owner). Pinning the expected result means a future change that
 * silently alters it — a different mint, a treasury rotation like the one on
 * 2026-09-07, a broken ATA derivation — fails loudly at startup instead of
 * sending the platform's take-rate somewhere nobody is watching.
 */
if (PLATFORM_TREASURY_TOKEN_ACCOUNT.toBase58() !== 'GSGbxLdLJ8HAud5gvpKseqUJzCouXYo8FE8hzLxbCzdf') {
  throw new Error(
    `BUG: treasury ATA derived as ${PLATFORM_TREASURY_TOKEN_ACCOUNT.toBase58()}, expected GSGbxLdLJ8HAud5gvpKseqUJzCouXYo8FE8hzLxbCzdf`
  );
}

/** How long after mark_delivered() the shipper has to release() or dispute()
 *  before the carrier may self-release. From the IDL, not duplicated by hand
 *  — mirrors web constants.js's idlConst('REVIEW_WINDOW_SECS'). 48h. */
export const REVIEW_WINDOW_SECS = Number(
  idl.constants.find((c) => c.name === 'REVIEW_WINDOW_SECS')?.value ?? 0
);

/**
 * Pricing. Copied from solana/app/src/constants.js, and the copy is
 * load-bearing: the amount this produces is what `initialize` locks in
 * escrow, so a mobile build that priced differently would post the same load
 * at a different price than the web client for no reason the shipper could
 * see. The formula lives in lib/book.ts's priceUsdFor().
 *
 * The shipper cannot override the result — computed-only, exactly as the
 * web client does it. It is a fixed demo formula, not a market quote.
 */
export const RATE_PER_KM_USD = 1.15;

/** A full truckload, used to scale the price down for partial loads. */
export const REF_LOAD_KG = 20000;
export const REF_LOAD_M3 = 86;

/** Floor on that scaling — a 50kg parcel still pays a quarter of the lane. */
export const MIN_SHARE = 0.25;

/**
 * The worker's own allowlist (worker/index.js's VEHICLE_TYPES). A value
 * outside this set is a 400 on POST /api/cargo, so the picker must not be
 * able to produce one.
 */
export const VEHICLE_TYPES = ['flatbed', 'refrigerated', 'curtainside', 'tanker'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
