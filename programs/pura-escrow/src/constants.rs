use anchor_lang::prelude::*;

#[constant]
pub const COUNTER_SEED: &[u8] = b"counter";

#[constant]
pub const HELLO_WORLD_LAMPORTS: u64 = 1;

#[constant]
pub const MAX_COUNT: u64 = 10;

// Booking.status values. Kept as a plain u8 (not a Rust enum) so the
// account layout stays a fixed-width struct — decodeBooking() in the
// client's src/lib/chain.js reads this offset directly, same reasoning
// as everywhere else in this file that a byte-for-byte layout matters.
#[constant]
pub const STATUS_OPEN: u8 = 0;
#[constant]
pub const STATUS_ACCEPTED: u8 = 1;
#[constant]
pub const STATUS_DELIVERED: u8 = 2;
#[constant]
pub const STATUS_DISPUTED: u8 = 3;

// How long a shipper has, after the carrier calls mark_delivered, to
// either release() or dispute() before the carrier can self-release via
// the same release() instruction. Protects the carrier from a shipper who
// goes silent post-delivery — without this, a silent shipper freezes the
// carrier's payment forever (see release.rs's release-authority check).
// 48h, tunable in one place: change this constant and every check that
// reads it moves with it.
#[constant]
pub const REVIEW_WINDOW_SECS: i64 = 48 * 60 * 60;

// Platform take-rate on release, in basis points (500 = 5%). The exact rate
// is not decided — this is a placeholder value, not a decision.
// Changing it requires a program upgrade (see the program's upgrade
// authority — a single keypair, per the earlier custody review), same
// as any other logic change here.
#[constant]
pub const PLATFORM_FEE_BPS: u64 = 500;

#[constant]
pub const BPS_DENOMINATOR: u64 = 10_000;

// ⚠️ PLACEHOLDER, NOT A REAL WALLET — this exact value
// (2GNkLeKLvg17YG6CzeooXqrav5cQV4Zj8E1D75JsfNqT) was generated once for
// this patch and its private key was immediately discarded; nobody can
// ever sign for it. `handle_release` explicitly refuses to run while this
// constant still equals PLATFORM_TREASURY_PLACEHOLDER (see release.rs) —
// this is a deliberate fail-closed guard, not an oversight. Replace this
// with the platform's real treasury wallet's pubkey before running
// `anchor deploy`, and separately create that wallet's USDC associated
// token account on devnet (this program only ever transfers into an
// existing ATA, it never creates the treasury's).
#[constant]
pub const PLATFORM_TREASURY_PLACEHOLDER: Pubkey = pubkey!("2GNkLeKLvg17YG6CzeooXqrav5cQV4Zj8E1D75JsfNqT");

// Real platform treasury wallet — switched 2026-09-07 (superseding the
// prior 52mTuFxuTdg... address from earlier the same day) to
// BYD7T4wXX7dz2MgozMa2hqyTMsg5k32S8ikrxZ8t5gLj. Its USDC associated token
// account was created on devnet separately (see the deploy notes) —
// release() will keep failing (via the require_keys_neq! guard in
// release.rs) if this is ever reverted back to PLATFORM_TREASURY_PLACEHOLDER
// above.
#[constant]
pub const PLATFORM_TREASURY: Pubkey = pubkey!("BYD7T4wXX7dz2MgozMa2hqyTMsg5k32S8ikrxZ8t5gLj");

// ⚠️ PLACEHOLDER, NOT A REAL WALLET — same discarded-keypair pattern as
// PLATFORM_TREASURY_PLACEHOLDER above. `resolve_dispute` refuses to run
// while ARBITRATOR still equals this value (see resolve_dispute.rs).
//
// This is the only key that can split a disputed escrow: once a booking is
// disputed, release() and cancel() both refuse to run, and nothing moves
// the money until this key signs resolve_dispute(). The dispute's reason
// and evidence stay off-chain; the decision is one signature, checked
// here, rather than two unrelated systems having to
// agree. Same custody caveat as PLATFORM_TREASURY and the program's
// own upgrade authority: a single non-multisig keypair, flagged in the
// earlier custody review as something to harden before mainnet
// (Squads multisig + timelock), not something this patch changes.
#[constant]
pub const ARBITRATOR_PLACEHOLDER: Pubkey = pubkey!("3PBz4h9uUwrGWyv8xVwzKjmtjpEYw3M65V4jsftjrsHR");

// The wallet allowed to resolve disputes. Set 2026-09-11 to a freshly
// generated devnet-only keypair, deliberately NOT reusing the program's
// upgrade authority (BSn7J4Xo…), the treasury (BYD7T4wX…) or the fee
// payer (DLYBFc7W…) — so a compromise
// of any one of those does not also hand over the ability to reassign
// escrowed funds.
//
// Until this was set it equalled ARBITRATOR_PLACEHOLDER, which made
// resolve_dispute() fail closed on every call — and because dispute()
// freezes release()/cancel(), that left any disputed booking permanently
// unrecoverable. See POST-REWRITE-REVIEW.md PR-2.
//
// Custody caveat unchanged: still a single non-multisig keypair. Harden to
// a Squads multisig + timelock before mainnet.
#[constant]
pub const ARBITRATOR: Pubkey = pubkey!("6TuPZv8D1KXMazkoJLCnBvS93kTW91ExZHre1SG7p4Wq");

// ⚠️ PLACEHOLDER — same discarded-keypair pattern as PLATFORM_TREASURY_
// PLACEHOLDER, applied to a mint address instead of a wallet (a mint
// account can never sign, so "nobody can ever sign for it" isn't the
// property that matters here — what matters is that this exact base58
// string was never a real devnet or mainnet USDC mint, so `initialize`
// cannot accidentally pass this check by chance).
//
// USDC_MINT differs per deployment (this app's own devnet test-mint vs.
// Circle's devnet mint vs. real mainnet USDC — see the client's
// VITE_USDC_MINT and the worker's USDC_MINT var), so unlike
// PLATFORM_TREASURY this can't ship pre-filled with one "the" value.
// `initialize` refuses to run while EXPECTED_USDC_MINT still equals this
// placeholder (see initialize.rs) — replace it with whatever mint
// VITE_USDC_MINT/USDC_MINT are actually set to for this deployment before
// running `anchor deploy`, and keep it in sync if that value ever changes.
#[constant]
pub const EXPECTED_USDC_MINT_PLACEHOLDER: Pubkey = pubkey!("6xWSykQ6zo5P5cuCX4QTTcMAwRhrsGKmcRSvWJSJWBt1");

// This deployment's USDC mint. Set 2026-09-11 to the app's own devnet
// test-USDC mint — the same value as wrangler.jsonc's USDC_MINT var and the
// client's VITE_USDC_MINT, verified live on devnet at the time of setting:
// owned by the SPL Token program, type `mint`, 6 decimals.
//
// Keep all three in sync. Until this was set it equalled
// EXPECTED_USDC_MINT_PLACEHOLDER, which made initialize() fail closed on
// every call — no booking could be created at all. See
// POST-REWRITE-REVIEW.md PR-1.
#[constant]
pub const EXPECTED_USDC_MINT: Pubkey = pubkey!("DABiRdamfNZuxWaTHHWvKuMUW7TP6fmHdRXuPfr5duws");

// The sponsoring wallet that pays every booking's rent in initialize()
// (`payer = fee_payer`) and is paid it back when the account closes
// (`close = fee_payer` in release/cancel/resolve_dispute). Read fresh from
// wrangler.jsonc's FEE_PAYER_PUBKEY on 2026-09-11 and cross-checked against
// .env.production's VITE_FEE_PAYER_PUBKEY — both are this value.
//
// Why this needs to be pinned on-chain: `fee_payer` is only declared as
// `Signer`, with no address constraint, so *any* signer could occupy that
// account and collect the rent the platform actually paid — a shipper
// self-signing their own cancel() would pocket the Booking PDA's refund.
// Not a one-time loss but a slow drain, one booking at a time.
//
// worker/index.js already refuses to countersign such a transaction
// (requireRealFeePayer, called from validateInstructions for initialize /
// cancel / release / resolve_dispute) and the client refuses to broadcast
// one (assertFeePayerIsSponsor). This constant is the third layer: those
// two only cover transactions that go through this app, and neither is
// reachable by someone hand-building the instruction against the program
// directly. See POST-REWRITE-REVIEW.md PR-4.
//
// Unlike ARBITRATOR/EXPECTED_USDC_MINT there is deliberately no
// _PLACEHOLDER sentinel here: those shipped unset and needed a fail-closed
// guard to prove they'd been configured. This one is being set to a
// verified address in the same change that introduces it, and the
// constraint is inherently fail-closed anyway — a wrong value makes every
// close fail loudly rather than silently misroute funds. Keep it in sync
// with FEE_PAYER_PUBKEY / VITE_FEE_PAYER_PUBKEY; mainnet will need a
// different wallet here.
#[constant]
pub const EXPECTED_FEE_PAYER: Pubkey = pubkey!("DLYBFc7WpiZes9zAL5Az37sXTANAzK7xyUCMR9HHLpys");
