import * as Crypto from 'expo-crypto';

import { API } from './constants';
import { toBase58Signature, type SigningWallet } from './profile';
import { signWithRetry, timedSignMessage } from './sponsor';

/**
 * Off-chain cargo metadata — GET /api/cargo?pdas=…
 *
 * Mirrors the web client's fetchCargoMeta (solana/app/src/lib/api.js). Two
 * modes, and the difference matters:
 *
 *   - WITHOUT a wallet: unsigned, returns the non-PII half only (route
 *     names, weight, volume). No signature prompt.
 *   - WITH a wallet: adds a read-scoped signature, which unlocks
 *     contact_name/contact_phone for bookings this wallet is the shipper or
 *     accepted carrier of. The worker decides per row; the client never
 *     filters.
 *
 * A refused or failed signature degrades to the unsigned read rather than
 * failing the screen — cards still render, contact rows just don't appear.
 * Same fallback the web client takes.
 */

export type CargoMeta = {
  pickup_name?: string | null;
  dropoff_name?: string | null;
  weight_kg?: number | null;
  volume_m3?: number | null;
  distance_km?: number | null;
  waypoints?: unknown[] | null;
  disputed?: number | boolean | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  pickup_contact_name?: string | null;
  pickup_contact_phone?: string | null;
  dropoff_contact_name?: string | null;
  dropoff_contact_phone?: string | null;
  /** Proof of delivery, stored as a base64 data URL directly in D1 (the
   *  worker writes the whole thing into cargo.delivery_photo — there is no
   *  object storage). Already returned by GET /api/cargo's SELECT *; this
   *  client simply never read it until now. */
  delivery_photo?: string | null;
};

const READ_MESSAGE_PREFIX = 'pura:read:';

/**
 * The read scope uses the worker's BOUND message form, not the plain
 * `<prefix><ts>` one the write scopes use:
 *
 *     pura:read:<action>:<ts>:<sha256(canonical payload)>
 *
 * See worker/index.js's verifyBoundMessage / canonicalPayload. The hash
 * commits the signature to this exact action and payload, so a captured
 * triple cannot be replayed against another route or another target — which
 * is the whole reason the bound form exists. Getting any part of this shape
 * wrong produces a silent 401 and simply no contact rows, so it is copied
 * from the server rather than approximated:
 *
 *   - keys sorted, auth envelope keys dropped, undefined dropped
 *   - JSON.stringify of that object
 *   - lowercase hex sha256
 *   - query params are auth_wallet / auth_message / auth_signature
 */
function canonicalPayload(payload: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    if (key === 'wallet' || key === 'message' || key === 'signature') continue;
    if (payload[key] === undefined) continue;
    out[key] = payload[key];
  }
  return JSON.stringify(out);
}

async function sha256Hex(str: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, str, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

async function signRead(wallet: SigningWallet, action: string, payload: Record<string, unknown>) {
  const bodyHash = await sha256Hex(canonicalPayload(payload));
  const message = `${READ_MESSAGE_PREFIX}${action}:${Date.now()}:${bodyHash}`;
  // Same timing probe the write scopes use — this is the call that timed out
  // on the carrier side, so it needs the same visibility. See sponsor.ts.
  const signature = await timedSignMessage(wallet, message, `read:${action}`);
  return { message, signature: toBase58Signature(signature) };
}

export async function fetchCargoMeta(
  pdas: string[],
  wallet?: SigningWallet
): Promise<Record<string, CargoMeta>> {
  if (!pdas.length) return {};
  try {
    const params = new URLSearchParams({ pdas: pdas.join(',') });
    let signed = false;
    if (wallet?.address) {
      try {
        // payload is { target: <this wallet> } — worker/index.js:1230 calls
        // verifyReadAuth(url, 'cargo-meta', { target: callerWallet }).
        const auth = await signRead(wallet, 'cargo-meta', { target: wallet.address });
        params.set('wallet', wallet.address);
        params.set('auth_wallet', wallet.address);
        params.set('auth_message', auth.message);
        params.set('auth_signature', auth.signature);
        signed = true;
      } catch (err) {
        console.log('[cargo] read signature unavailable, falling back unsigned', String(err));
      }
    }
    const res = await fetch(`${API}/api/cargo?${params.toString()}`);
    const data = (await res.json()) as { cargo?: Record<string, CargoMeta> };
    const cargo = data.cargo ?? {};

    // Whether PII actually came back is the ONLY way to tell a verified
    // bound read signature from a rejected one: the worker strips contact
    // fields on rejection and returns the same 200 with the same row count,
    // and the card renders identically either way. `contactRows` vs
    // `hasContactKey` also separates "signature refused" from "the shipper
    // never entered contact details", which otherwise look the same.
    const rows = Object.values(cargo);
    const contactRows = rows.filter((r) => r.contact_name).length;
    const hasContactKey = rows.some((r) => 'contact_name' in r);
    console.log(
      `[cargo] read signed=${signed} rows=${rows.length} contactRows=${contactRows} contactKeyPresent=${hasContactKey}`
    );
    return cargo;
  } catch (err) {
    console.log('[cargo] meta fetch failed', String(err));
    return {};
  }
}

/**
 * `pura:cargo-complete:<ts>` — the PLAIN unbound form, not the bound read
 * form above. worker/index.js's verifyCargoComplete calls
 * verifySignedMessage (prefix + timestamp only), unlike verifyReadAuth's
 * verifyBoundMessage. Using the bound shape here would fail the prefix
 * check and 401.
 */
const CARGO_COMPLETE_MESSAGE_PREFIX = 'pura:cargo-complete:';

/**
 * Records a finished booking into D1 — the ONLY place its outcome survives.
 *
 * release() and cancel() both `close` the on-chain Booking account, so the
 * moment this call is made is the last moment the outcome exists anywhere.
 * Miss it and the booking simply vanishes: gone from Tracking, never in
 * History, on this client and the web one alike. That is why cancel.ts
 * calls this unconditionally rather than treating it as optional telemetry.
 *
 * Deliberately never throws. The chain is already authoritative by the time
 * this runs — the escrow is refunded and the account is closed whatever
 * happens here — so a failure must not surface as "cancel failed" when the
 * cancel unambiguously succeeded. It returns whether the record landed so
 * the caller can say so honestly instead.
 *
 * Two silent-failure modes worth knowing, both of which return false:
 *   - 403 when no `cargo` row exists for this PDA. The route is an UPDATE,
 *     not an upsert (worker/index.js:1327 SELECTs the row first), so a
 *     booking never POSTed to /api/cargo at creation can never be recorded.
 *   - 401 on a stale signature, past the worker's 5-minute window.
 */
export async function recordCargoCompletion(
  wallet: SigningWallet,
  bookingPda: string,
  status: 'released' | 'cancelled',
  amountRaw: bigint | number
): Promise<boolean> {
  try {
    // Retried once on a wallet-bridge hiccup — see signWithRetry. This is the
    // MOST consequential of the three: release()/cancel() have already closed
    // the Booking account by the time this runs, so if the signature never
    // lands the outcome exists nowhere. The booking does not appear in
    // History on either client, and there is no second chance — unlike
    // book/accept, whose metadata at least leaves a recoverable row behind.
    const auth = await signWithRetry(wallet, CARGO_COMPLETE_MESSAGE_PREFIX, 'complete');
    const res = await fetch(`${API}/api/cargo/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        booking_pda: bookingPda,
        wallet: wallet.address,
        message: auth.message,
        signature: auth.signature,
        status,
        // The worker does Number(b.amount) and rejects anything non-finite.
        // This is the GROSS escrowed amount, the same unit as the on-chain
        // booking.amount — not a post-fee payout. History displays it as-is.
        amount: Number(amountRaw),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      console.log(`[complete] cargo/complete ${res.status}: ${body.error ?? '(no body)'}`);
      return false;
    }
    console.log(`[complete] cargo/complete ok status=${status} pda=${bookingPda}`);
    return true;
  } catch (err) {
    console.log('[complete] cargo/complete failed', String(err));
    return false;
  }
}

/** One finished booking, as GET /api/cargo/history returns it. These are D1
 *  columns, not on-chain fields — the account is gone by the time a row
 *  exists, so there is no PublicKey or bigint here, only what was recorded. */
export type CargoHistoryRow = {
  booking_pda: string;
  shipper: string;
  carrier?: string | null;
  pickup_name?: string | null;
  dropoff_name?: string | null;
  completed_status: 'released' | 'cancelled';
  /** Raw u64 micro-USDC, same unit as the on-chain booking.amount. GROSS
   *  escrowed, not a post-fee payout — the web client displays it as-is and
   *  flags the same caveat. */
  completed_amount: number;
  completed_at: number;
};

export type CargoHistoryResult = {
  rows: CargoHistoryRow[];
  /** True when the read signature was REFUSED, as opposed to there being
   *  nothing to show. These are completely different things and must never
   *  render the same: "no completed shipments" is a lie when the truth is
   *  that nothing was ever fetched. The web client learned this the hard
   *  way — see ShipmentsView's authRequired banner. */
  authRequired: boolean;
};

/**
 * GET /api/cargo/history — the ONLY source for finished bookings, since
 * release()/cancel() close the on-chain account.
 *
 * No pagination to implement: the worker's query is a fixed
 * `ORDER BY completed_at DESC LIMIT 100` with no offset or cursor
 * (worker/index.js:1363). If a shipper ever passes 100 finished bookings
 * this silently truncates — the web client has the same ceiling, so this
 * is parity, not a new limit.
 *
 * Self-only, deliberately: one wallet, one signature.
 */
export async function fetchCargoHistory(
  wallet: SigningWallet
): Promise<CargoHistoryResult> {
  let auth;
  try {
    // payload is { target: <this wallet> } — worker/index.js:1357 calls
    // verifyReadAuth(url, 'cargo-history', { target: wallet }).
    auth = await signRead(wallet, 'cargo-history', { target: wallet.address });
  } catch (err) {
    // A refusal is NOT an empty history. Unlike fetchCargoMeta, there is no
    // unsigned fallback to degrade to here — the route 401s without a
    // signature — so the only honest thing is to say so.
    console.log('[history] read signature refused/unavailable', String(err));
    return { rows: [], authRequired: true };
  }

  try {
    const params = new URLSearchParams({
      wallet: wallet.address,
      auth_wallet: wallet.address,
      auth_message: auth.message,
      auth_signature: auth.signature,
    });
    const res = await fetch(`${API}/api/cargo/history?${params.toString()}`);
    if (res.status === 401 || res.status === 403) {
      // The signature was made but the worker rejected it — expired past the
      // 5-minute window, or this wallet may not read that target. Same user-
      // facing meaning as a refusal: retry, don't claim an empty history.
      console.log(`[history] worker rejected the read: ${res.status}`);
      return { rows: [], authRequired: true };
    }
    const data = (await res.json()) as { cargo?: CargoHistoryRow[] };
    const rows = data.cargo ?? [];
    console.log(`[history] ${rows.length} finished bookings`);
    return { rows, authRequired: false };
  } catch (err) {
    console.log('[history] fetch failed', String(err));
    return { rows: [], authRequired: true };
  }
}
