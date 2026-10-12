// Wallet-signature checks for the escrow demo's worker (index.js). Each one
// proves the caller holds a wallet's key: an ed25519 signature over a fresh,
// prefixed, timestamped message, which for the bound form also names the
// action and commits to a hash of the request.
//
// Part of a copy of production's worker, with deletions: every declaration
// has production's code, and the comments describe this copy.

import nacl from 'tweetnacl'
import bs58 from 'bs58'

const PDA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

const PROFILE_MESSAGE_PREFIX = 'pura:profile:'
const FEEPAYER_MESSAGE_PREFIX = 'pura:feepayer:'
const CARGO_ACCEPT_MESSAGE_PREFIX = 'pura:cargo-accept:'
const CARGO_COMPLETE_MESSAGE_PREFIX = 'pura:cargo-complete:'
const CARGO_MESSAGE_PREFIX = 'pura:cargo:'
// scopes a signature to a *read* of someone's data (GET /api/cargo/history,
// GET /api/cargo) — deliberately a different prefix from every write
// scope above, so a read signature can never be replayed as a write
const READ_MESSAGE_PREFIX = 'pura:read:'
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000

function isPda(s) { return PDA_RE.test(s || '') }

// proves the caller controls `wallet` — they signed a fresh, prefixed,
// timestamped message with it. No sessions, no passwords. The prefix
// scopes what the signature is proof of, so an admin-signed message can't
// be replayed as a profile write and vice versa.
function verifySignedMessage({ wallet, message, signature }, prefix) {
  try {
    if (typeof message !== 'string' || !message.startsWith(prefix)) return false
    const ts = Number(message.slice(prefix.length))
    if (!Number.isFinite(ts)) return false
    const age = Date.now() - ts
    if (age < 0 || age > MAX_MESSAGE_AGE_MS) return false
    if (!isPda(wallet)) return false

    const messageBytes = new TextEncoder().encode(message)
    const signatureBytes = bs58.decode(signature)
    const walletBytes = bs58.decode(wallet)
    return nacl.sign.detached.verify(messageBytes, signatureBytes, walletBytes)
  } catch {
    return false
  }
}

function verifyOwner({ wallet, message, signature }) {
  return verifySignedMessage({ wallet, message, signature }, PROFILE_MESSAGE_PREFIX)
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The exact bytes a bound signature commits to: every request field except
// the auth envelope itself (wallet/message/signature — the message can't
// contain a hash of itself), with keys sorted so client and server agree
// regardless of property order. Only flat string/number fields are used by
// the routes this guards; a nested object would serialize with its own key
// order intact, so if one is ever added it must be canonicalised too.
function canonicalPayload(payload) {
  const out = {}
  for (const key of Object.keys(payload || {}).sort()) {
    if (key === 'wallet' || key === 'message' || key === 'signature') continue
    if (payload[key] === undefined) continue
    out[key] = payload[key]
  }
  return JSON.stringify(out)
}

// verifySignedMessage, but the message also names the action and commits to
// the request payload: `<prefix><action>:<ts>:<sha256(canonical payload)>`.
// The old `<prefix><ts>` form proved only "this wallet signed something in
// this scope in the last 5 minutes", which made any captured triple a
// bearer token for every other route in the scope with any body the
// attacker liked. Binding action + body means a captured signature can only
// ever re-do the exact call it was made for.
async function verifyBoundMessage(auth, prefix, action, payload) {
  try {
    const { wallet, message, signature } = auth || {}
    if (typeof message !== 'string' || !message.startsWith(prefix)) return false
    const parts = message.slice(prefix.length).split(':')
    if (parts.length !== 3) return false
    const [msgAction, tsRaw, bodyHash] = parts
    if (msgAction !== action) return false
    const ts = Number(tsRaw)
    if (!Number.isFinite(ts)) return false
    const age = Date.now() - ts
    if (age < 0 || age > MAX_MESSAGE_AGE_MS) return false
    if (!isPda(wallet)) return false
    if (bodyHash !== await sha256Hex(canonicalPayload(payload))) return false

    const messageBytes = new TextEncoder().encode(message)
    const signatureBytes = bs58.decode(signature)
    const walletBytes = bs58.decode(wallet)
    return nacl.sign.detached.verify(messageBytes, signatureBytes, walletBytes)
  } catch {
    return false
  }
}

// Read auth for the two GET routes that hand back someone's data keyed by a
// wallet address (GET /api/cargo/history, GET /api/cargo). The signature
// travels in query params rather than a body because these are GETs; the
// signed message binds the route (`action`) and the target wallet, so it
// can't be moved to the other read route or pointed at a different wallet.
// Returns the verified caller wallet, or null.
async function verifyReadAuth(url, action, payload) {
  const auth = {
    wallet: url.searchParams.get('auth_wallet') || '',
    message: url.searchParams.get('auth_message') || '',
    signature: url.searchParams.get('auth_signature') || '',
  }
  const ok = await verifyBoundMessage(auth, READ_MESSAGE_PREFIX, action, payload)
  return ok ? auth.wallet : null
}

// proof that the caller holds `wallet` right now, for POST /api/cargo/accept,
// which records that wallet as the booking's carrier; GET /api/cargo and
// POST /api/cargo/complete read that column
function verifyCargoAccept({ wallet, message, signature }) {
  return verifySignedMessage({ wallet, message, signature }, CARGO_ACCEPT_MESSAGE_PREFIX)
}

// proof that the caller holds `wallet` right now, for POST /api/cargo/complete,
// which then checks that the wallet is the booking's shipper or its recorded
// carrier before recording the outcome
function verifyCargoComplete({ wallet, message, signature }) {
  return verifySignedMessage({ wallet, message, signature }, CARGO_COMPLETE_MESSAGE_PREFIX)
}

// proof that the caller holds the shipper wallet it names before POST
// /api/cargo writes booking metadata attributed to that wallet (the route
// then checks that an existing row's shipper is the same wallet)
function verifyCargo({ wallet, message, signature }) {
  return verifySignedMessage({ wallet, message, signature }, CARGO_MESSAGE_PREFIX)
}

// fee-payer endpoints require this on top of the transaction's own
// signature — it's a cheap, freshness-checked proof of wallet control the
// worker can check before touching D1 or deserializing anything, and it
// pins the request to one specific wallet for rate-limiting/logging instead
// of trusting whatever the caller claims
function verifyFeePayerAuth({ wallet, message, signature }) {
  return verifySignedMessage({ wallet, message, signature }, FEEPAYER_MESSAGE_PREFIX)
}

export {
  isPda,
  verifyOwner,
  verifyCargo,
  verifyCargoAccept,
  verifyCargoComplete,
  verifyReadAuth,
  verifyFeePayerAuth,
}
