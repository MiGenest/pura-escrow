// The escrow demo's server: the eight routes the mobile app calls, as one
// Cloudflare Worker over one D1 database.
//
//   POST /api/profile          GET  /api/profile
//   POST /api/cargo            GET  /api/cargo
//   POST /api/cargo/accept     POST /api/cargo/complete
//   GET  /api/cargo/history    POST /api/fee-payer/sign
//
// A copy of production's worker, with deletions and one addition: the
// on-chain carrier check behind POST /api/cargo/accept (refuseUnlessCarrier
// and the three declarations above it). Every other function, constant and
// route handler has production's code, and the comments describe this
// copy. Where the code differs, a comment that begins "PUBLIC COPY —
// differs from production:" says so.
//
// auth.js holds the wallet-signature checks; sponsor.js the fee payer's
// instruction allowlist, rent maths, request limits and daily cap.
// normalizeCountry and parseAmount keep the export keyword they have in
// production.

import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  isPda,
  verifyOwner,
  verifyCargo,
  verifyCargoAccept,
  verifyCargoComplete,
  verifyReadAuth,
  verifyFeePayerAuth,
} from './auth.js'
import {
  validateInstructions,
  checkAndLogSponsorship,
  SponsorshipRejected,
  LAMPORTS_PER_SIGNATURE,
  PURA_PROGRAM_ID,
  BOOKING_ACCOUNT_LEN,
} from './sponsor.js'

// The API is called cross-origin from a few legitimate places that aren't
// same-origin with this worker: local dev (Vite on http://localhost:5173)
// and the Capacitor-packaged native app (its own non-https origin) — see
// App.jsx's `API` constant.
//
// This used to be a wildcard `*`, justified by "no cookies, so no
// credentialed-CORS risk". That justification does not hold for reads whose
// only input is a wallet address: a wildcard lets ANY page on the internet
// read this API in the visitor's browser and exfiltrate the response. The
// allowlist below is echoed back per-request (see corsAllowOrigin/the fetch
// wrapper) rather than hardcoded to one value, because the native app's
// origin can't be a single static string — Capacitor serves the bundle from
// `https://localhost` (capacitor.config.json's ios/androidScheme), and older
// / differently-configured builds use `capacitor://localhost` or
// `ionic://localhost`.
const ALLOWED_ORIGINS = [
  'https://pura.misha-9f1.workers.dev',
  // PUBLIC COPY — differs from production: production allows more origins here.
  'http://localhost:5173',
]
// Capacitor/Ionic webview origins + any localhost port (Vite on a non-5173
// port, `capacitor run` dev server, native webview). Localhost origins are
// only reachable by something already running on the user's own machine.
const NATIVE_ORIGIN_RE = /^(?:capacitor|ionic):\/\/localhost$|^https?:\/\/localhost(?::\d+)?$/

// Per-ROUTE origin grants, deliberately separate from ALLOWED_ORIGINS above.
// Adding an origin to ALLOWED_ORIGINS instead would hand any script on that
// origin a browser-credentialed path to EVERY route here, including the
// signed writes and the PII reads. The grant is keyed by exact pathname, so
// a new route does not inherit it by being under the same prefix.
// PUBLIC COPY — differs from production: production grants route-specific
// origins here.
const ROUTE_ORIGINS = {}

function corsAllowOrigin(request, pathname) {
  const origin = request.headers.get('Origin')
  if (!origin) return null // non-browser or same-origin caller: no CORS header needed
  if (ALLOWED_ORIGINS.includes(origin) || NATIVE_ORIGIN_RE.test(origin)) return origin
  if (ROUTE_ORIGINS[pathname]?.includes(origin)) return origin
  return null
}

// No Access-Control-Allow-Origin here — the exported fetch wrapper adds it
// per-request when (and only when) the caller's Origin is allowlisted. Vary
// is set unconditionally so a cache can never serve one origin's allowed
// response to another origin.
const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
}
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS_HEADERS }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

// carrier vehicle types the open-loads filter (a separate follow-up task)
// will match against — see VEHICLE_TYPE_CARDS in App.jsx for the matching
// client-side picker
const VEHICLE_TYPES = ['flatbed', 'refrigerated', 'curtainside', 'tanker']

// The two corridors a booking can be in. POST /api/cargo derives one from
// the pickup and drop-off countries and stores it with the booking.
const CORRIDOR_CROSS_BORDER = 'CROSS_BORDER'
const CORRIDOR_GEORGIA_DOMESTIC = 'GEORGIA_DOMESTIC'
const GEORGIA_COUNTRY_CODE = 'GE'

/**
 * A country as we store it: ISO-3166-1 alpha-2, uppercase, or null.
 *
 * Anything that is not two letters becomes null: "Georgia", "GEO" and ""
 * are all "not recorded", not errors.
 */
export const normalizeCountry = (c) =>
  (typeof c === 'string' && /^[A-Za-z]{2}$/.test(c.trim()) ? c.trim().toUpperCase() : null)

// GEORGIA_DOMESTIC only when BOTH ends are in Georgia. Either end outside,
// or either end unknown, is CROSS_BORDER.
function resolveCorridor(pickupCountry, dropoffCountry) {
  const a = normalizeCountry(pickupCountry)
  const b = normalizeCountry(dropoffCountry)
  if (!a || !b) return CORRIDOR_CROSS_BORDER
  return (a === GEORGIA_COUNTRY_CODE && b === GEORGIA_COUNTRY_CODE)
    ? CORRIDOR_GEORGIA_DOMESTIC
    : CORRIDOR_CROSS_BORDER
}

const MAX_IMAGE_LEN = 400_000

function isDataImage(s) { return typeof s === 'string' && s.startsWith('data:image/') && s.length <= MAX_IMAGE_LEN }

/* One parser for every monetary amount that arrives over the wire.
 *
 * WHY IT EXISTS. `Number.isFinite(Number(v))` is not a number check. Number()
 * coerces, so a JSON body carrying `true` passes it and becomes 1, and
 * `[1500]` and `'1500'` pass it the same way.
 *
 * WHAT IS ACCEPTED
 *   a number        finite, not negative, at most 2 decimal places
 *   a STRING in canonical form, matching /^\d+(\.\d{1,2})?$/
 *
 * Numeric strings stay accepted on purpose, but only the canonical form — the
 * point of a money parser is that there is exactly one spelling of a price.
 *
 * WHAT IS REFUSED, AND WHY EACH ONE MATTERS
 *   true / false        Number(true) === 1; this is the bug above
 *   [1500], {}, null    Number([1500]) === 1500; an array is not a price
 *   ''  '   '           Number('') === 0, which would book a free load
 *   '1,500'            thousands separators are ambiguous across locales —
 *                       in much of Europe that comma is a DECIMAL point, so
 *                       the same string means 1500 or 1.5 depending on who
 *                       typed it. Never guess at a price.
 *   '1.5e3'            exponent notation is not something a person types into
 *                       a rate field; accepting it means accepting 1e21 too
 *   ' 1500 '           whitespace usually means a copy-paste from a spreadsheet
 *                       or a chat message, which is exactly when the rest of
 *                       the string is worth a second look
 *   '1500.005'         currency amounts settle to 2 decimal places
 *   negatives           no route here takes one; a refund is not modelled as a
 *                       negative amount
 *   NaN, Infinity       not prices
 *
 * Returns the number, or null. Callers still apply their own RANGE rules: a
 * completion amount may be 0.
 */

// canonical money string: digits, optionally a dot and one or two digits.
// No sign, no separators, no exponent, no surrounding space.
const CANONICAL = /^\d+(\.\d{1,2})?$/

// at most two decimal places, checked on the decimal spelling rather than by
// arithmetic — `Number.isInteger(1500.07 * 100)` is false, because that
// product is 150006.99999999999
function atMostTwoDecimals(n) {
  const s = String(n)
  if (s.includes('e') || s.includes('E')) return false
  const dot = s.indexOf('.')
  return dot < 0 || s.length - dot - 1 <= 2
}

export function parseAmount(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null
    return atMostTwoDecimals(v) ? v : null
  }
  if (typeof v === 'string') {
    if (!CANONICAL.test(v)) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function base64ToBytes(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// avoids depending on the Node Buffer global, which isn't guaranteed
// present in the Workers runtime without the nodejs_compat flag
function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

// This copy's own: the on-chain check behind POST /api/cargo/accept (see the
// PUBLIC COPY note there). BOOKING_DISCRIMINATOR is the IDL's accounts →
// Booking entry (mobile/src/idl/pura_escrow.json), copied, not recomputed.
const BOOKING_DISCRIMINATOR = [147, 50, 61, 138, 208, 21, 254, 156]

// One account through JSON-RPC getAccountInfo, from SOLANA_RPC_URL or else
// Solana's public devnet RPC. Returns null when the chain has no such
// account, otherwise { owner, data }; throws when the call fails (a network
// error, a non-200 answer, a JSON-RPC error).
async function getAccountInfo(env, address) {
  const res = await fetch(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [address, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  })
  if (!res.ok) throw new Error(`RPC answered ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error)}`)
  const account = body.result.value
  if (account === null) return null
  return { owner: account.owner, data: base64ToBytes(account.data[0]) }
}

// The carrier a Booking account names, in base58, or null when the account
// is not a Booking: another owner than the escrow program, fewer than
// BOOKING_ACCOUNT_LEN (162) bytes, or another discriminator. The layout is
// decodeBooking's (mobile/src/lib/chain.ts): discriminator 0–8, booking_id
// 8–16, amount 16–24, shipper 24–56, carrier 56–88, mint 88–120, status 120,
// bump 121, then the coordinates and dates.
function bookingCarrier(account) {
  if (account.owner !== PURA_PROGRAM_ID.toBase58()) return null
  if (account.data.length < BOOKING_ACCOUNT_LEN) return null
  if (BOOKING_DISCRIMINATOR.some((byte, i) => account.data[i] !== byte)) return null
  return new PublicKey(account.data.slice(56, 88)).toBase58()
}

// Returns null when the booking's on-chain account names `wallet` as its
// carrier, and otherwise the refusal to send. An open booking holds the
// default (all-zero) key as its carrier, meaning none yet; that key matches
// no caller, since tweetnacl accepts some signatures for it. The app calls
// the route right after its accept confirms, so a missing account or
// another carrier is read once more, about a second later, in case the RPC
// node lags.
async function refuseUnlessCarrier(env, bookingPda, wallet) {
  const namesWallet = (account) => {
    const carrier = bookingCarrier(account)
    return carrier === wallet && carrier !== PublicKey.default.toBase58()
  }
  let account
  try {
    account = await getAccountInfo(env, bookingPda)
    if (!account || (bookingCarrier(account) && !namesWallet(account))) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      account = await getAccountInfo(env, bookingPda)
    }
  } catch {
    return json({ error: 'chain unavailable' }, 503)
  }
  if (!account) return json({ error: 'booking not found on-chain' }, 404)
  if (!bookingCarrier(account)) return json({ error: 'not a booking' }, 400)
  if (!namesWallet(account)) return json({ error: 'not this booking\'s carrier' }, 403)
  return null
}

// the only PII columns on cargo — the shipper's own contact (since
// migrations/0001_init.sql) and the pickup/dropoff-point contact (since
// migrations/0013_cargo_contact_details.sql, confirmed applied in
// production). GET /api/cargo/history strips them from any row the caller
// is not a party to — route, price, status, and dates aren't PII.
const CARGO_PII_FIELDS = [
  'contact_name', 'contact_phone',
  'pickup_contact_name', 'pickup_contact_phone',
  'dropoff_contact_name', 'dropoff_contact_phone',
]
function stripCargoPii(rows) {
  for (const row of rows) {
    for (const field of CARGO_PII_FIELDS) delete row[field]
  }
  return rows
}

export default {
  // PUBLIC COPY — differs from production: production's worker serves more
  // than these routes; this copy keeps only the escrow demo's.
  async fetch(request, env, ctx) {
    const response = await handleRequest(request, env, ctx)
    // Only json()'s responses and the preflight below carry CORS_HEADERS,
    // and this step passes anything else through untouched. The allowed
    // origin is echoed per-request (see corsAllowOrigin) — a caller whose
    // Origin isn't allowlisted gets the response with no
    // Access-Control-Allow-Origin at all, which is what makes the browser
    // refuse to hand it to the calling page.
    if (!response.headers.has('Access-Control-Allow-Methods')) return response
    // pathname is needed because some origins are granted per-route rather
    // than globally (see ROUTE_ORIGINS) — including on the OPTIONS preflight,
    // which carries the real route's pathname.
    const origin = corsAllowOrigin(request, new URL(request.url).pathname)
    if (!origin) return response
    const out = new Response(response.body, response)
    out.headers.set('Access-Control-Allow-Origin', origin)
    return out
  },
}

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url)

    // PUBLIC COPY — differs from production: production serves other paths
    // here; in this copy they end at the "not found" at the bottom.

    // CORS preflight — browsers send this ahead of any cross-origin POST
    // with a Content-Type: application/json body (which is every write
    // route here) before the real request. Every /api/* response also
    // carries the same headers via json()'s JSON_HEADERS.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }


    try {
      // PUBLIC COPY — differs from production: production has further routes
      // here; none of them answers the routes below.

      // ── cargo metadata ──────────────────────────────────────────

      if (url.pathname === '/api/cargo' && request.method === 'POST') {
        const b = await request.json()

        if (!isPda(b.booking_pda)) return json({ error: 'invalid booking_pda' }, 400)
        if (!isPda(b.shipper)) return json({ error: 'invalid shipper' }, 400)
        // the shipper is the actor writing their own booking's metadata
        if (!verifyCargo({ wallet: b.shipper, message: b.message, signature: b.signature })) {
          return json({ error: 'invalid signature' }, 401)
        }
        if (b.required_vehicle_type && !VEHICLE_TYPES.includes(b.required_vehicle_type)) {
          return json({ error: 'invalid required_vehicle_type' }, 400)
        }

        // The signature proves WHO is calling; it does not prove this booking
        // is theirs. booking_pda is derived on-chain from the shipper's own
        // pubkey, so a row's shipper never legitimately changes — but the
        // ON CONFLICT branch below rewrites description/waypoints/weight/
        // vehicle type, and without this an attacker signing honestly as
        // themselves could still overwrite another shipper's booking just by
        // posting their booking_pda, which is public on-chain. The signature
        // decides WHO, this check decides WHAT.
        const existingCargo = await env.DB.prepare(
          `SELECT shipper FROM cargo WHERE booking_pda = ?`
        ).bind(b.booking_pda).first()
        if (existingCargo && existingCargo.shipper !== b.shipper) {
          return json({ error: 'not your booking' }, 403)
        }

        // The corridor is derived here from the two country codes, not taken
        // from the client: a corridor the client sends that disagrees with them
        // is refused. All three fields are optional; without the countries the
        // corridor is CROSS_BORDER and the country columns stay NULL.
        //
        // Limit: the corridor is only as trustworthy as the country codes the
        // client sends. This route makes no RPC call, so it does not check
        // them against the coordinates in the on-chain Booking account.
        const pickupCountry = normalizeCountry(b.pickup_country)
        const dropoffCountry = normalizeCountry(b.dropoff_country)
        const corridor = resolveCorridor(pickupCountry, dropoffCountry)
        if (b.corridor && b.corridor !== corridor) {
          return json({ error: 'corridor does not match the supplied countries' }, 400)
        }

        await env.DB.prepare(
          `INSERT INTO cargo (
             booking_pda, shipper, weight_kg, volume_m3, description,
             pickup_name, dropoff_name, contact_name, contact_phone,
             pickup_contact_name, pickup_contact_phone,
             dropoff_contact_name, dropoff_contact_phone,
             price_usd, distance_km, waypoints, required_vehicle_type,
             corridor, pickup_country, dropoff_country, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(booking_pda) DO UPDATE SET
             weight_kg = excluded.weight_kg,
             volume_m3 = excluded.volume_m3,
             description = excluded.description,
             waypoints = excluded.waypoints,
             required_vehicle_type = excluded.required_vehicle_type`
        ).bind(
          b.booking_pda,
          b.shipper,
          b.weight_kg ?? null,
          b.volume_m3 ?? null,
          (b.description || '').slice(0, 280),
          (b.pickup_name || '').slice(0, 200),
          (b.dropoff_name || '').slice(0, 200),
          (b.contact_name || '').slice(0, 100),
          (b.contact_phone || '').slice(0, 40),
          (b.pickup_contact_name || '').slice(0, 100) || null,
          (b.pickup_contact_phone || '').slice(0, 40) || null,
          (b.dropoff_contact_name || '').slice(0, 100) || null,
          (b.dropoff_contact_phone || '').slice(0, 40) || null,
          b.price_usd ?? null,
          b.distance_km ?? null,
          b.waypoints ? JSON.stringify(b.waypoints).slice(0, 2000) : null,
          b.required_vehicle_type || null,
          corridor,
          pickupCountry,
          dropoffCountry,
          Date.now()
        ).run()

        return json({ ok: true })
      }

      if (url.pathname === '/api/cargo' && request.method === 'GET') {
        const raw = url.searchParams.get('pdas') || ''
        const pdas = raw.split(',').map((s) => s.trim()).filter(isPda).slice(0, 100)
        // No signature is needed for a read. A caller who wants the contact
        // fields must PROVE the wallet it names: `wallet` must come with a
        // read-scoped signature bound to it, as GET /api/cargo/history
        // requires.
        //
        // Omitting the wallet is fine and unsigned: that path returns the
        // non-PII half (route names, weight, vehicle type) with every contact
        // field stripped. So an anonymous metadata read costs nothing, and
        // only the PII unlock costs a signature.
        const callerWallet = url.searchParams.get('wallet')
        let caller = null
        if (callerWallet) {
          if (!isPda(callerWallet)) return json({ error: 'invalid wallet' }, 400)
          const verified = await verifyReadAuth(url, 'cargo-meta', { target: callerWallet })
          if (!verified) return json({ error: 'invalid or expired read signature' }, 401)
          if (verified !== callerWallet) return json({ error: 'signature does not match wallet' }, 403)
          caller = verified
        }

        if (pdas.length === 0) return json({ cargo: {} })

        const marks = pdas.map(() => '?').join(',')
        const { results } = await env.DB.prepare(
          `SELECT * FROM cargo WHERE booking_pda IN (${marks})`
        ).bind(...pdas).all()

        const map = {}
        for (const row of results) {
          if (row.waypoints) { try { row.waypoints = JSON.parse(row.waypoints) } catch { row.waypoints = null } }
          // the six contact fields — the shipper's own contact and the
          // pickup/delivery contact persons — come back only to the booking's
          // shipper or to the wallet recorded as its carrier. Every other
          // caller gets all six stripped entirely rather than nulled, so their
          // absence is unambiguous.
          //
          // THE `!caller` TEST IS LOAD-BEARING — do not fold it away as
          // redundant. With no ?wallet= param `caller` is null, and for a
          // booking with no carrier recorded `row.carrier` is null too; without
          // the test, `caller !== row.carrier` would be `null !== null`, the
          // condition would collapse, and an anonymous read would not be
          // stripped.
          if (!caller || (caller !== row.shipper && caller !== row.carrier)) {
            delete row.contact_name
            delete row.contact_phone
            delete row.pickup_contact_name
            delete row.pickup_contact_phone
            delete row.dropoff_contact_name
            delete row.dropoff_contact_phone
          }
          map[row.booking_pda] = row
        }
        return json({ cargo: map })
      }

      // mirrors an on-chain `accept` into cargo.carrier, which GET /api/cargo
      // and POST /api/cargo/complete read. The app calls this right after its
      // accept confirms, and the signer is recorded only if the booking's
      // on-chain account names it as the carrier.
      if (url.pathname === '/api/cargo/accept' && request.method === 'POST') {
        const b = await request.json()
        if (!isPda(b.booking_pda)) return json({ error: 'invalid booking_pda' }, 400)
        if (!verifyCargoAccept({ wallet: b.wallet, message: b.message, signature: b.signature })) {
          return json({ error: 'invalid signature' }, 401)
        }
        // PUBLIC COPY — differs from production: this copy checks on-chain that
        // the signer is the booking's carrier before recording it.
        const refusal = await refuseUnlessCarrier(env, b.booking_pda, b.wallet)
        if (refusal) return refusal

        await env.DB.prepare(
          `UPDATE cargo SET carrier = ? WHERE booking_pda = ?`
        ).bind(b.wallet, b.booking_pda).run()

        return json({ ok: true })
      }

      // mirrors an on-chain release() or cancel() into cargo.completed_*.
      // Both instructions close the Booking account, so the outcome is kept
      // here for GET /api/cargo/history. The booking's shipper or its
      // recorded carrier may write it; what each may record is checked below.
      if (url.pathname === '/api/cargo/complete' && request.method === 'POST') {
        const b = await request.json()
        if (!isPda(b.booking_pda)) return json({ error: 'invalid booking_pda' }, 400)
        if (b.status !== 'released' && b.status !== 'cancelled') {
          return json({ error: 'invalid status' }, 400)
        }
        // 0 is legitimate here (a cancelled booking settles at zero), so the
        // range check differs from the others — but the parse does not.
        const amount = parseAmount(b.amount)
        if (amount === null || amount < 0) return json({ error: 'invalid amount' }, 400)
        if (!verifyCargoComplete({ wallet: b.wallet, message: b.message, signature: b.signature })) {
          return json({ error: 'invalid signature' }, 401)
        }

        // EITHER PARTY may record the outcome, because either party can cause
        // it on-chain. release.rs accepts booking.shipper (any time) or
        // booking.carrier (once Delivered and REVIEW_WINDOW_SECS has elapsed),
        // so a carrier self-release is a first-class path — and this route was
        // the only place its outcome could ever be written, since release()
        // closes the Booking account.
        //
        // Observed on devnet 2026-09-26: three carrier self-releases each
        // logged `403: not this booking's shipper`, and all three bookings are
        // now permanently absent from History on both clients. The shipper-only
        // check dated from when shipper-initiated release was the only path.
        //
        // The status a party may claim is constrained to what they can actually
        // do on-chain: cancel.rs gates on STATUS_OPEN *and* the shipper, so a
        // carrier can never cause a cancellation and must not be able to record
        // one. A carrier may therefore record 'released' only.
        const row = await env.DB.prepare(
          `SELECT shipper, carrier FROM cargo WHERE booking_pda = ?`
        ).bind(b.booking_pda).first()
        if (!row) return json({ error: 'no cargo row for this booking' }, 403)
        const isShipper = row.shipper === b.wallet
        // carrier is a mirror written by /api/cargo/accept; a booking whose
        // mirror write failed leaves the carrier unable to record here.
        const isCarrier = !!row.carrier && row.carrier === b.wallet
        if (!isShipper && !isCarrier) {
          return json({ error: 'not a party to this booking' }, 403)
        }
        if (isCarrier && !isShipper && b.status !== 'released') {
          return json({ error: 'carrier may only record a release' }, 403)
        }

        await env.DB.prepare(
          `UPDATE cargo SET completed_status = ?, completed_amount = ?, completed_at = ? WHERE booking_pda = ?`
        ).bind(b.status, amount, Date.now(), b.booking_pda).run()

        return json({ ok: true })
      }

      // history for a wallet's finished bookings (either side): the outcomes
      // POST /api/cargo/complete recorded once release() or cancel() closed
      // the on-chain account.
      //
      // The WHERE clause proves a *row* belongs to the wallet, not that the
      // caller IS it, and wallet addresses are public. So the read needs a
      // read-scoped signature bound to this route and this wallet, and the
      // caller must be the wallet itself.
      if (url.pathname === '/api/cargo/history' && request.method === 'GET') {
        const wallet = url.searchParams.get('wallet') || ''
        if (!isPda(wallet)) return json({ cargo: [] })

        const caller = await verifyReadAuth(url, 'cargo-history', { target: wallet })
        if (!caller) return json({ error: 'invalid or expired read signature' }, 401)
        // PUBLIC COPY — differs from production: here only the wallet itself
        // may read its history.
        if (caller !== wallet) {
          return json({ error: 'not permitted to read this wallet\'s history' }, 403)
        }

        const { results } = await env.DB.prepare(
          `SELECT * FROM cargo WHERE (shipper = ?1 OR carrier = ?1) AND completed_status IS NOT NULL
           ORDER BY completed_at DESC LIMIT 100`
        ).bind(wallet).all()

        // PII rule is the same as GET /api/cargo's: the six contact fields
        // are for the booking's own shipper or its recorded carrier, nobody
        // else. When caller === wallet this strips nothing, since the WHERE
        // above already makes them one of the two parties.
        for (const row of results) {
          if (row.waypoints) { try { row.waypoints = JSON.parse(row.waypoints) } catch { row.waypoints = null } }
          if (caller !== row.shipper && caller !== row.carrier) stripCargoPii([row])
        }
        return json({ cargo: results })
      }

      // PUBLIC COPY — differs from production: production has further routes
      // here that the demo does not call.

      // ── user profiles ────────────────────────────────────────────

      if (url.pathname === '/api/profile' && request.method === 'POST') {
        const b = await request.json()

        if (!verifyOwner({ wallet: b.wallet, message: b.message, signature: b.signature })) {
          return json({ error: 'invalid signature' }, 401)
        }

        const p = b.profile || {}
        if (p.role !== 'shipper' && p.role !== 'carrier') {
          return json({ error: 'invalid role' }, 400)
        }
        if (p.license_doc && !isDataImage(p.license_doc)) return json({ error: 'invalid license_doc' }, 400)
        if (p.insurance_doc && !isDataImage(p.insurance_doc)) return json({ error: 'invalid insurance_doc' }, 400)
        if (p.vehicle_type && !VEHICLE_TYPES.includes(p.vehicle_type)) {
          return json({ error: 'invalid vehicle_type' }, 400)
        }
        // optional numeric fields — a carrier who hasn't set these yet must
        // still be able to save the rest of their profile
        const maxWeightKg = p.max_weight_kg == null || p.max_weight_kg === '' ? null : Number(p.max_weight_kg)
        const maxVolumeM3 = p.max_volume_m3 == null || p.max_volume_m3 === '' ? null : Number(p.max_volume_m3)
        if (maxWeightKg != null && (!Number.isFinite(maxWeightKg) || maxWeightKg < 0)) {
          return json({ error: 'invalid max_weight_kg' }, 400)
        }
        if (maxVolumeM3 != null && (!Number.isFinite(maxVolumeM3) || maxVolumeM3 < 0)) {
          return json({ error: 'invalid max_volume_m3' }, 400)
        }

        // verification_status is computed here, not trusted from the client:
        // both documents on file earn "pending", otherwise "unverified". This
        // route never sets "verified", and keeps it when the row already has it.
        const verificationStatus = (p.license_doc && p.insurance_doc) ? 'pending' : 'unverified'

        const now = Date.now()
        // only set on a genuine first-ever write while already pending —
        // see migrations/0014_verification_requested_at.sql for why this
        // exists separately from updated_at (which every edit bumps)
        const verificationRequestedAt = verificationStatus === 'pending' ? now : null
        await env.DB.prepare(
          `INSERT INTO users (
             wallet, role, name, company, phone, email, plate,
             license_doc, insurance_doc, verification_status,
             max_weight_kg, max_volume_m3, vehicle_type, created_at, updated_at,
             verification_requested_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(wallet) DO UPDATE SET
             role = excluded.role,
             name = excluded.name,
             company = excluded.company,
             phone = excluded.phone,
             email = excluded.email,
             plate = excluded.plate,
             license_doc = excluded.license_doc,
             insurance_doc = excluded.insurance_doc,
             verification_status = CASE
               WHEN users.verification_status = 'verified' THEN 'verified'
               ELSE excluded.verification_status
             END,
             max_weight_kg = excluded.max_weight_kg,
             max_volume_m3 = excluded.max_volume_m3,
             vehicle_type = excluded.vehicle_type,
             updated_at = excluded.updated_at,
             -- stamped only on the transition into 'pending' (previously
             -- not pending, freshly computed as pending this write) —
             -- kept as-is on every subsequent edit while still pending,
             -- cleared if it drops back to unverified, left untouched once
             -- verified (irrelevant there, verified rows never re-enter
             -- the pending queue anyway)
             verification_requested_at = CASE
               WHEN users.verification_status = 'verified' THEN users.verification_requested_at
               WHEN excluded.verification_status != 'pending' THEN NULL
               WHEN users.verification_status = 'pending' THEN users.verification_requested_at
               ELSE excluded.updated_at
             END`
        ).bind(
          b.wallet,
          p.role,
          (p.name || '').slice(0, 100),
          (p.company || '').slice(0, 100),
          (p.phone || '').slice(0, 40),
          (p.email || '').slice(0, 120),
          (p.plate || '').slice(0, 20),
          p.license_doc || null,
          p.insurance_doc || null,
          verificationStatus,
          maxWeightKg,
          maxVolumeM3,
          p.vehicle_type || null,
          now,
          now,
          verificationRequestedAt
        ).run()

        return json({ ok: true })
      }

      // GET /api/profile?wallet=<pubkey> — public lookup, but only ever
      // returns fields safe to show before a booking exists between two
      // parties. phone/email/documents never come back from an open lookup.
      if (url.pathname === '/api/profile' && request.method === 'GET') {
        const wallet = url.searchParams.get('wallet') || ''
        if (!isPda(wallet)) return json({ profile: null })

        const row = await env.DB.prepare(
          `SELECT role, name, company, verification_status FROM users WHERE wallet = ?`
        ).bind(wallet).first()

        return json({ profile: row || null })
      }

      // partial-signs a client-built, already-user-signed transaction as fee
      // payer, once validateInstructions (sponsor.js) has accepted every
      // instruction in it. Requires a fresh wallet-signed message (same scheme
      // as verifyOwner) BEFORE anything else, cross-checked against whichever
      // wallet actually signed the transaction — not just the transaction's
      // own signature, so an abusive caller is rejected before the worker
      // spends any effort deserializing or rate-limit-querying for them.
      if (url.pathname === '/api/fee-payer/sign' && request.method === 'POST') {
        const b = await request.json()
        const ip = request.headers.get('CF-Connecting-IP')
        const kind = b.kind
        // PUBLIC COPY — differs from production: production also accepts
        // 'resolve_dispute' behind an extra gate; this copy refuses it, so
        // validateInstructions' resolve_dispute branch (sponsor.js) is
        // unreachable here.
        if (!['initialize', 'cancel', 'release', 'accept', 'mark_delivered', 'dispute'].includes(kind)) {
          return json({ error: 'invalid kind' }, 400)
        }
        if (typeof b.tx !== 'string' || !b.tx) return json({ error: 'invalid tx' }, 400)
        if (!verifyFeePayerAuth(b)) return json({ error: 'invalid or expired wallet signature' }, 401)
        if (!env.FEE_PAYER_SECRET || !env.USDC_MINT) return json({ error: 'fee payer not configured' }, 500)

        try {
          const feePayer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(env.FEE_PAYER_SECRET)))
          const mint = new PublicKey(env.USDC_MINT)
          const tx = Transaction.from(base64ToBytes(b.tx))

          if (!tx.feePayer?.equals(feePayer.publicKey)) return json({ error: 'wrong fee payer' }, 400)
          if (!tx.verifySignatures(false)) return json({ error: 'invalid signature' }, 400)

          const { wallet: signerWallet, atRiskLamports } = validateInstructions(kind, tx.instructions, feePayer.publicKey, mint)
          if (signerWallet.toBase58() !== b.wallet) return json({ error: 'signed message does not match transaction signer' }, 401)
          const signerEntry = tx.signatures.find((s) => s.publicKey.equals(signerWallet))
          if (!signerEntry?.signature) return json({ error: 'missing wallet signature' }, 400)

          await checkAndLogSponsorship(env, {
            wallet: signerWallet.toBase58(), ip, kind, lamports: atRiskLamports + 2 * LAMPORTS_PER_SIGNATURE,
          })

          tx.partialSign(feePayer)
          return json({ signedTx: bytesToBase64(tx.serialize()) })
        } catch (err) {
          if (err instanceof SponsorshipRejected) return json({ error: err.message }, 429)
          return json({ error: 'sponsorship failed', detail: String(err?.message || err) }, 400)
        }
      }

      return json({ error: 'not found' }, 404)
    } catch (err) {
      return json({ error: String(err) }, 500)
    }
}
