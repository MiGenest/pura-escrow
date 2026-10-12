import bs58 from 'bs58';
import { Buffer } from 'buffer';
import * as SecureStore from 'expo-secure-store';

import { API } from './constants';

/**
 * Profile read/write against the same worker the web client uses.
 *
 * Field names and the exact role strings are copied from
 * solana/app/worker/index.js's POST /api/profile and
 * migrations/0002_users.sql — the server rejects anything that is not
 * literally 'shipper' or 'carrier' (worker/index.js: `if (p.role !==
 * 'shipper' && p.role !== 'carrier') return 400`), and `users.wallet` is the
 * PRIMARY KEY with a single `role` column, so a wallet holds exactly one
 * role. There is no dual-role state to represent.
 */

export const ROLES = ['shipper', 'carrier'] as const;
export type Role = (typeof ROLES)[number];

export type Profile = {
  role: Role;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  plate?: string | null;
};

/** Matches the web client's signProfileMessage — the worker's verifyOwner
 *  only accepts this prefix for a profile write. */
const PROFILE_MESSAGE_PREFIX = 'pura:profile:';

/**
 * BOTH ends of Privy's signMessage are base64, and neither is documented.
 * Confirmed by reading @privy-io/js-sdk-core, which forwards the request as
 *
 *   params: { message: <what you passed>, encoding: 'base64' }
 *
 * and reconstructs signatures with `Buffer.from(sig, 'base64')`.
 *
 * So the message must be base64 of the UTF-8 bytes — passing the raw string
 * makes Privy base64-decode it into unrelated bytes and sign THOSE, which
 * verifies against nothing. That is what produced a 401 "invalid signature"
 * on 2026-09-17, and it is indistinguishable from a genuinely bad key.
 *
 * The worker, meanwhile, does `bs58.decode(signature)` and verifies against
 * `new TextEncoder().encode(message)` (worker/index.js verifySignedMessage),
 * so the signature has to be re-encoded base64 -> base58 on the way out.
 */
export function encodeMessageForPrivy(message: string): string {
  return Buffer.from(new TextEncoder().encode(message)).toString('base64');
}

/** base64 (what Privy returns) -> base58 (what the worker decodes). Tolerant
 *  of an already-base58 value in case a future SDK version changes. */
export function toBase58Signature(sig: string): string {
  try {
    const asB58 = bs58.decode(sig);
    if (asB58.length === 64) return sig;
  } catch {
    /* not base58 — expected, fall through to base64 */
  }
  const bytes = new Uint8Array(Buffer.from(sig, 'base64'));
  if (bytes.length !== 64) {
    throw new Error(`unexpected signature length ${bytes.length} (want 64) from "${sig.slice(0, 12)}…"`);
  }
  return bs58.encode(bytes);
}

/**
 * Minimal shape of the Privy embedded Solana wallet we depend on.
 *
 * Two request forms, mirroring @privy-io/js-sdk-core's own overloads:
 *   signMessage     -> { signature }          (base64 in, base64 out)
 *   signTransaction -> { signedTransaction }  (live Transaction object,
 *                                              returned mutated with the
 *                                              signature attached)
 * Declared as an overloaded call signature rather than a union so the
 * return type narrows by method at each call site.
 */
export type SigningWallet = {
  address: string;
  getProvider: () => Promise<{
    request: {
      (r: { method: 'signMessage'; params: { message: string } }): Promise<{
        signature: string;
      }>;
      <T>(r: { method: 'signTransaction'; params: { transaction: T } }): Promise<{
        signedTransaction: T;
      }>;
    };
  }>;
};

/**
 * GET /api/profile?wallet= — public, unsigned, returns role/name/company
 * only (never phone or email; see the worker's own comment). Used purely to
 * decide whether onboarding is needed, mirroring the web client, which
 * renders Onboarding only when there is no profile.
 */
export async function fetchProfile(wallet: string): Promise<Profile | null> {
  try {
    const res = await fetch(`${API}/api/profile?wallet=${wallet}`);
    const data = (await res.json()) as { profile?: Profile | null };
    return data.profile ?? null;
  } catch (err) {
    // A failed lookup must not be read as "no profile" — that would push an
    // existing user back through onboarding and let them overwrite their own
    // role, which the server permits (`role = excluded.role`) even though no
    // UI offers it. Caller treats null-vs-throw differently for that reason.
    console.log('[profile] fetch failed', err);
    throw err;
  }
}

/**
 * POST /api/profile — role and details in ONE write, matching the web
 * client's two-step / single-POST onboarding (App.jsx collects role, then
 * details, then calls syncProfileToServer once). The worker requires a
 * fresh pura:profile: signature from the wallet being written.
 */
export async function saveProfile(wallet: SigningWallet, profile: Profile): Promise<void> {
  const message = `${PROFILE_MESSAGE_PREFIX}${Date.now()}`;
  const provider = await wallet.getProvider();
  const { signature } = await provider.request({
    method: 'signMessage',
    // base64, per the SDK's own `encoding: 'base64'` — NOT the raw string.
    params: { message: encodeMessageForPrivy(message) },
  });
  const signatureB58 = toBase58Signature(signature);
  // Shape only, never a secret: enough to tell an encoding fault from a
  // genuine auth failure without another round-trip to the device.
  console.log(
    `[profile] sig shape: raw.len=${signature.length} b58.len=${signatureB58.length} wallet=${wallet.address.slice(0, 4)}…`
  );

  const res = await fetch(`${API}/api/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wallet: wallet.address,
      message,
      signature: signatureB58,
      // Only the fields this screen collects. The server also accepts
      // license_doc/insurance_doc/vehicle_type/max_weight_kg/max_volume_m3 —
      // all optional, all part of verification and carrier capacity rather
      // than onboarding, and all left for a later screen.
      profile: {
        role: profile.role,
        name: profile.name ?? null,
        company: profile.company ?? null,
        phone: profile.phone ?? null,
        email: profile.email ?? null,
        plate: profile.plate ?? null,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`profile save failed (${res.status}) ${body.slice(0, 120)}`);
  }

  // Keep a local copy — see storeProfile. Deliberately after the server
  // write: a profile that failed to save must not be cached as if it had.
  await storeProfile(wallet.address, profile);
}

/* ------------------------------------------------------------------ *
 * Local copy
 *
 * GET /api/profile returns role, name and company — and DELIBERATELY never
 * phone or email (the worker says so in its own comment; that PII travels
 * through /api/cargo on an accepted booking instead). So the server cannot
 * be the source of the shipper's phone number.
 *
 * Without a local copy, `profile.phone` was non-null only during the single
 * session in which onboarding collected it. Every later launch re-fetched
 * from the server and got null back — and the booking flow writes
 * cargo.contact_phone straight from this field, which the worker stores
 * INSERT-only (its ON CONFLICT branch never updates the contact columns).
 * A load posted on a relaunched app would therefore have carried a
 * permanently empty phone number for the carrier to call.
 *
 * The web client has had this all along as localStorage's pura_profile_<pk>
 * (App.jsx's loadProfile/persistProfile); this is the same idea with the
 * same key shape. SecureStore rather than AsyncStorage because a name and
 * phone number are personal data sitting on a device that gets lost.
 * ------------------------------------------------------------------ */

/** SecureStore keys allow alphanumerics, '.', '-' and '_'. Base58 addresses
 *  are alphanumeric by definition, so this is always a legal key. */
const profileKey = (wallet: string) => `pura_profile_${wallet}`;

/** Never throws: a device that cannot store a profile is a degraded
 *  experience (re-enter your phone), not a broken sign-up. SecureStore is
 *  also simply absent on web, which the Expo build targets. */
export async function storeProfile(wallet: string, profile: Profile): Promise<void> {
  try {
    await SecureStore.setItemAsync(profileKey(wallet), JSON.stringify(profile));
    // Read straight back. setItemAsync rejects on a genuine failure, but the
    // thing this guards against is the write appearing to succeed and the
    // value not being there on the next launch — at which point the only
    // symptom is a booking posted with an empty contact_phone, a field the
    // worker will never let us correct. Cheap to prove now, impossible to
    // diagnose later.
    const readBack = await SecureStore.getItemAsync(profileKey(wallet));
    const ok = !!readBack && (JSON.parse(readBack) as Profile).phone === (profile.phone ?? null);
    console.log(`[profile] local store: ${ok ? 'ok' : 'WROTE BUT READ BACK WRONG'} phone=${profile.phone ? 'set' : 'none'}`);
  } catch (err) {
    console.log('[profile] local store FAILED (non-fatal)', String(err));
  }
}

export async function loadStoredProfile(wallet: string): Promise<Profile | null> {
  try {
    const raw = await SecureStore.getItemAsync(profileKey(wallet));
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch (err) {
    console.log('[profile] local read failed (non-fatal)', String(err));
    return null;
  }
}

export async function clearStoredProfile(wallet: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(profileKey(wallet));
  } catch (err) {
    console.log('[profile] local clear failed (non-fatal)', String(err));
  }
}

/**
 * What the app should actually run on: the server's answer for the fields it
 * owns, plus the locally-held fields it will never return.
 *
 * Server-authoritative for role/name/company on purpose — those can be
 * changed from the web client on another device, and a stale local copy must
 * not win. phone/email/plate can only ever come from here.
 */
export function mergeProfile(server: Profile, stored: Profile | null): Profile {
  if (!stored) return server;
  return {
    ...server,
    phone: stored.phone ?? null,
    email: stored.email ?? null,
    plate: server.plate ?? stored.plate ?? null,
  };
}
