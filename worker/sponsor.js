// The fee payer's side of POST /api/fee-payer/sign (index.js): the instruction
// allowlist a transaction must pass before the worker countersigns it, the
// rent maths behind what each kind may cost the fee payer, the hourly
// per-wallet and per-IP request limits, and the global daily lamports cap.
//
// Part of a copy of production's worker, with deletions: every declaration
// has production's code, and the comments describe this copy.
// validateInstructions' resolve_dispute branch is unreachable in this copy:
// index.js refuses that kind before calling it (see the PUBLIC COPY note on
// the fee-payer route's kind allowlist).

import { PublicKey, SystemProgram } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'

// reads an 8-byte little-endian u64 out of instruction data at `offset`,
// via DataView rather than Buffer methods — instruction.data here comes
// from the 'buffer' npm polyfill (no Node Buffer global in Workers without
// nodejs_compat), and DataView works identically over either
function readU64LE(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
  return view.getBigUint64(0, true)
}

function u64LEBytes(value) {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

/* ── fee payer ─────────────────────────────────────────────────────────
   Sponsors network fees — and, for `initialize`, the one-time rent to
   create the booking PDA and escrow vault ATA — so a wallet never needs
   its own SOL.

   POST /api/fee-payer/sign partial-signs a transaction the CLIENT built
   and the user's own wallet already signed (as the escrow program's
   required signer). The worker did not construct it, so it never
   blind-signs it: validateInstructions below checks every instruction
   against the shape expected for the declared `kind` (program ids, the
   escrow call's discriminator, the instruction count and, where the fee
   payer's rent is spent or recovered, the accounts) before countersigning.
   ────────────────────────────────────────────────────────────────────── */

const PURA_PROGRAM_ID = new PublicKey('2eUXsNeT5oCk5Q6NGg6ZXC8Y5Yc3p8DguBBsDzEBiGXt')

// first 8 bytes of sha256("global:<ix name>") — static per Anchor's IDL,
// copied from src/idl/pura_escrow.json rather than recomputed at runtime
const DISCRIMINATORS = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  cancel: [232, 219, 223, 41, 219, 236, 220, 190],
  release: [253, 249, 15, 206, 28, 127, 193, 241],
  accept: [65, 150, 70, 216, 133, 6, 107, 4],
  mark_delivered: [240, 118, 188, 142, 64, 85, 107, 18],
  dispute: [216, 92, 128, 146, 202, 85, 135, 73],
  resolve_dispute: [231, 6, 202, 6, 96, 103, 12, 230],
}

function matchesDiscriminator(data, name) {
  const want = DISCRIMINATORS[name]
  if (data.length < 8) return false
  for (let i = 0; i < 8; i++) if (data[i] !== want[i]) return false
  return true
}

// Solana's rent-exemption formula (Rent::default()): (128 + data_len) *
// lamports_per_byte_year(3480) * exemption_threshold(2.0) — a cluster-wide
// constant, not chain state, so this needs no RPC call
const rentExemptMinimum = (dataLen) => Math.ceil((128 + dataLen) * 3480 * 2)
const BOOKING_ACCOUNT_LEN = 8 + 154 // anchor discriminator + Booking::INIT_SPACE (state.rs) — 146 + 8 for delivered_at
const TOKEN_ACCOUNT_LEN = 165 // SPL Token TokenAccount::LEN
const BOOKING_RENT = rentExemptMinimum(BOOKING_ACCOUNT_LEN)
const VAULT_RENT = rentExemptMinimum(TOKEN_ACCOUNT_LEN)
// initialize's `payer`/`close` authority is now the fee_payer account
// itself (Anchor CPIs the rent directly, not a client-chosen amount — see
// initialize.rs), so unlike the old top-up-transfer design this is a
// fixed, non-attacker-influenceable cost, not a cap on client input.
const INITIALIZE_RENT_COST = BOOKING_RENT + VAULT_RENT

const SYSTEM_PROGRAM_ID = SystemProgram.programId

function isAssociatedTokenAccountCreateIx(ix) {
  return ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
    ix.keys.length >= 6 &&
    ix.data.length <= 1 // Create = no data, CreateIdempotent = single byte (1)
}

// release/cancel/resolve_dispute all close the escrow vault ATA (and the
// booking PDA) back to whichever account the instruction names as
// `fee_payer` (see release.rs/cancel.rs/resolve_dispute.rs) — rent the
// REAL fee payer originally spent at initialize(). If a caller could name
// a different pubkey there, every release/cancel/resolve would quietly
// redirect that recovered rent to an attacker instead of back to the
// platform's own wallet — a slow drain, not a one-time loss. This check
// is what stops that.
function requireRealFeePayer(actual, feePayerPubkey) {
  if (!actual.equals(feePayerPubkey)) throw new Error('fee_payer account does not match configured fee payer')
}

// validates instruction shape for one `kind` and returns { wallet,
// atRiskLamports }: wallet is whoever's signature this sponsorship rides
// on (the tx's OTHER signature, never chosen by the caller) — shipper,
// carrier, or (for resolve_dispute) the arbitrator, depending on kind and,
// for release, on which one is actually authorizing it; atRiskLamports is
// what the fee payer's own SOL is actually exposed to beyond the flat
// per-signature fee — the caller adds that flat fee itself, since it's
// the same for every kind
function validateInstructions(kind, instructions, feePayerPubkey, mint) {
  const unknownProgram = instructions.find((ix) => (
    !ix.programId.equals(SYSTEM_PROGRAM_ID) &&
    !ix.programId.equals(TOKEN_PROGRAM_ID) &&
    !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
    !ix.programId.equals(PURA_PROGRAM_ID)
  ))
  if (unknownProgram) throw new Error(`unexpected program in transaction: ${unknownProgram.programId.toBase58()}`)

  const escrowIx = instructions[instructions.length - 1]
  if (!escrowIx.programId.equals(PURA_PROGRAM_ID) || !matchesDiscriminator(escrowIx.data, kind)) {
    throw new Error(`last instruction is not a valid ${kind} call`)
  }

  if (kind === 'initialize') {
    if (instructions.length < 1 || instructions.length > 2) throw new Error('unexpected instruction count')
    const [shipper, feePayerAcc, booking, , ixMint, shipperAta, escrowVault, tokenProgram, atProgram, systemProgram] =
      escrowIx.keys.map((k) => k.pubkey)
    requireRealFeePayer(feePayerAcc, feePayerPubkey)
    if (!ixMint.equals(mint)) throw new Error('wrong mint')
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) || !atProgram.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || !systemProgram.equals(SYSTEM_PROGRAM_ID)) {
      throw new Error('wrong program account')
    }
    const bookingId = readU64LE(escrowIx.data, 16)
    const [expectedBooking] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('booking'), shipper.toBuffer(), u64LEBytes(bookingId)],
      PURA_PROGRAM_ID
    )
    if (!booking.equals(expectedBooking)) throw new Error('booking PDA mismatch')
    if (!shipperAta.equals(getAssociatedTokenAddressSync(mint, shipper))) throw new Error('shipper ATA mismatch')
    if (!escrowVault.equals(getAssociatedTokenAddressSync(mint, booking, true))) throw new Error('escrow vault mismatch')

    // the only thing that may precede the escrow call now is a defensive,
    // idempotent (re-)creation of the shipper's own ATA — initialize()
    // itself pays its rent directly via the fee_payer account above (a
    // fixed, Anchor-computed cost, not client-chosen), so unlike the old
    // design there's no top-up transfer left to validate or cap here.
    // Previously flagged in README.md's known-gaps list: atRiskLamports
    // for initialize undercounted this ATA-creation rent when present —
    // fixed by actually checking ataCreateIxPresent, same as release/
    // resolve_dispute already do for their own optional ATA-create.
    let ataCreateIxPresent = false
    for (const ix of instructions.slice(0, -1)) {
      if (!isAssociatedTokenAccountCreateIx(ix)) throw new Error('unexpected instruction before initialize')
      const [payer, ata, owner, ataMint] = ix.keys.map((k) => k.pubkey)
      if (!payer.equals(feePayerPubkey) || !owner.equals(shipper) || !ataMint.equals(mint) || !ata.equals(shipperAta)) {
        throw new Error('unexpected ATA creation')
      }
      ataCreateIxPresent = true
    }
    return { wallet: shipper, atRiskLamports: INITIALIZE_RENT_COST + (ataCreateIxPresent ? VAULT_RENT : 0) }
  }

  if (kind === 'cancel') {
    if (instructions.length !== 1) throw new Error('unexpected instruction count')
    const [shipper, , feePayerAcc] = escrowIx.keys.map((k) => k.pubkey)
    requireRealFeePayer(feePayerAcc, feePayerPubkey)
    // net recovery, not a new spend: the vault/booking rent being
    // reclaimed here is rent the fee payer already spent at initialize()
    return { wallet: shipper, atRiskLamports: 0 }
  }

  if (kind === 'release') {
    if (instructions.length < 1 || instructions.length > 2) throw new Error('unexpected instruction count')
    const [authority, , , feePayerAcc, , carrierTokenAccount, carrier] = escrowIx.keys.map((k) => k.pubkey)
    requireRealFeePayer(feePayerAcc, feePayerPubkey)
    let ataCreateIxPresent = false
    for (const ix of instructions.slice(0, -1)) {
      if (!isAssociatedTokenAccountCreateIx(ix)) throw new Error('unexpected instruction before release')
      const [payer, ata, owner, ataMint] = ix.keys.map((k) => k.pubkey)
      if (!payer.equals(feePayerPubkey) || !owner.equals(carrier) || !ataMint.equals(mint) || !ata.equals(carrierTokenAccount)) {
        throw new Error('unexpected ATA creation')
      }
      ataCreateIxPresent = true
    }
    // authority is whoever actually signs this — the shipper (any time)
    // or the carrier (only once the on-chain review-window check passes;
    // enforced by the program itself, not re-derived here). Net recovery
    // of the vault's rent offsets most of the cost, same reasoning as
    // cancel — the worst-case ATA-create is the only real new spend.
    return { wallet: authority, atRiskLamports: ataCreateIxPresent ? VAULT_RENT : 0 }
  }

  if (kind === 'accept') {
    if (instructions.length !== 1) throw new Error('unexpected instruction count')
    return { wallet: escrowIx.keys[0].pubkey, atRiskLamports: 0 } // carrier
  }

  if (kind === 'mark_delivered') {
    if (instructions.length !== 1) throw new Error('unexpected instruction count')
    return { wallet: escrowIx.keys[0].pubkey, atRiskLamports: 0 } // carrier
  }

  if (kind === 'dispute') {
    if (instructions.length !== 1) throw new Error('unexpected instruction count')
    return { wallet: escrowIx.keys[0].pubkey, atRiskLamports: 0 } // shipper or carrier
  }

  if (kind === 'resolve_dispute') {
    if (instructions.length < 1 || instructions.length > 2) throw new Error('unexpected instruction count')
    const [arbitrator, , , feePayerAcc, , , carrierTokenAccount, carrier] = escrowIx.keys.map((k) => k.pubkey)
    requireRealFeePayer(feePayerAcc, feePayerPubkey)
    let ataCreateIxPresent = false
    for (const ix of instructions.slice(0, -1)) {
      if (!isAssociatedTokenAccountCreateIx(ix)) throw new Error('unexpected instruction before resolve_dispute')
      const [payer, ata, owner, ataMint] = ix.keys.map((k) => k.pubkey)
      if (!payer.equals(feePayerPubkey) || !owner.equals(carrier) || !ataMint.equals(mint) || !ata.equals(carrierTokenAccount)) {
        throw new Error('unexpected ATA creation')
      }
      ataCreateIxPresent = true
    }
    return { wallet: arbitrator, atRiskLamports: ataCreateIxPresent ? VAULT_RENT : 0 }
  }

  throw new Error('unknown kind')
}

const SPONSOR_WINDOW_MS = 60 * 60 * 1000
// TEMPORARY — raised from 30/60 to 200/400 on 2026-09-07 for active devnet
// testing (the daily lamports cap below is nowhere near exhausted; these
// per-wallet/per-IP request-count limits were what was actually blocking
// testing with 429s). This Worker has no devnet-vs-mainnet runtime flag to
// key this off of (checked — none exists), so this is a direct constant
// change, not an environment-conditional one. REVERT TO 30/60 BEFORE ANY
// MAINNET DEPLOYMENT — on mainnet these protect the fee payer's real SOL,
// not just testing convenience.
const SPONSOR_LIMIT_PER_WALLET = 200
const SPONSOR_LIMIT_PER_IP = 400
const DAY_MS = 24 * 60 * 60 * 1000
const LAMPORTS_PER_SIGNATURE = 5000
const DEFAULT_DAILY_CAP_LAMPORTS = 1_000_000_000 // 1 SOL/day if env var unset

// thrown by checkAndLogSponsorship for a caller-facing rejection (rate
// limit / daily cap) — distinct from an unexpected server error, so the
// fetch handler can return the right status and a clear message
class SponsorshipRejected extends Error {}

// "today" is a rolling UTC-epoch day (Date.now() truncated to 24h
// boundaries), not calendar midnight in any timezone — simple, and good
// enough for a spend cap rather than a billing ledger
const todayStartMs = () => Math.floor(Date.now() / DAY_MS) * DAY_MS

// per-wallet AND per-IP throttles so the fee payer can't be drained by
// spamming otherwise-legitimate real transactions (see validateInstructions
// above — nothing there stops a wallet from sponsoring its own cheap
// bookings endlessly, since it's genuinely signing them), plus a global
// daily lamports cap shared across every wallet. Logs one row per
// successful sponsorship (wallet, kind, lamports spent, caller IP) — also
// the source the rate limits and cap read back from.
//
// The check and the insert are one statement, not three SELECTs followed
// by an INSERT — that sequence had a real race: N concurrent requests can
// all read "under the limit" before any of them writes its row, letting
// all N through regardless of the limit. An INSERT ... SELECT ... WHERE
// runs as a single indivisible statement in SQLite (and D1 follows the
// same single-statement semantics), so the limit check and the row that
// counts against it can't be split apart by a concurrent request the way
// three separate round-trips could be. `meta.changes` tells us whether the
// WHERE clause actually let the row through; a rejection does one more
// (non-atomic, but only used to word the error — nothing hinges on it
// being race-free) read to say which limit was hit.
async function checkAndLogSponsorship(env, { wallet, ip, kind, lamports, ipLimit = SPONSOR_LIMIT_PER_IP }) {
  const since = Date.now() - SPONSOR_WINDOW_MS
  const dailyCap = Number(env.FEE_PAYER_DAILY_CAP_LAMPORTS) || DEFAULT_DAILY_CAP_LAMPORTS
  const now = Date.now()

  const result = await env.DB.prepare(
    `INSERT INTO fee_sponsorships (wallet, kind, created_at, lamports_spent, ip)
     SELECT ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM fee_sponsorships WHERE wallet = ? AND created_at > ?) < ?
       AND (? IS NULL OR (SELECT COUNT(*) FROM fee_sponsorships WHERE ip = ? AND created_at > ?) < ?)
       AND (SELECT COALESCE(SUM(lamports_spent), 0) FROM fee_sponsorships WHERE created_at > ?) + ? <= ?`
  ).bind(
    wallet, kind, now, lamports, ip || null,
    wallet, since, SPONSOR_LIMIT_PER_WALLET,
    ip || null, ip || null, since, ipLimit,
    todayStartMs(), lamports, dailyCap,
  ).run()

  if (result.meta.changes === 0) {
    // the WHERE clause blocked the insert — re-check each condition
    // individually just to word the rejection; the actual enforcement
    // already happened atomically above, so a race here can only affect
    // which message is shown, never whether the request should be rejected
    const walletCount = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM fee_sponsorships WHERE wallet = ? AND created_at > ?`
    ).bind(wallet, since).first()
    if ((walletCount?.n ?? 0) >= SPONSOR_LIMIT_PER_WALLET) {
      throw new SponsorshipRejected('Too many requests from this wallet — try again in a bit.')
    }
    if (ip) {
      const ipCount = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM fee_sponsorships WHERE ip = ? AND created_at > ?`
      ).bind(ip, since).first()
      if ((ipCount?.n ?? 0) >= ipLimit) {
        throw new SponsorshipRejected('Too many requests from this network — try again in a bit.')
      }
    }
    throw new SponsorshipRejected('Daily sponsorship limit reached — please try again tomorrow.')
  }

  console.log(JSON.stringify({ event: 'fee_sponsorship', wallet, kind, lamports, ip: ip || null }))
}

export { validateInstructions, checkAndLogSponsorship, SponsorshipRejected, LAMPORTS_PER_SIGNATURE }
// for the on-chain carrier check on POST /api/cargo/accept (index.js)
export { PURA_PROGRAM_ID, BOOKING_ACCOUNT_LEN }
