// TYPE-ONLY, deliberately. `import type` is erased at compile time, so these
// two lines emit no runtime require and do not touch native code.
//
// WHY THAT MATTERS: expo-image-picker and expo-image-manipulator are NATIVE
// modules. A value import here executes at MODULE LOAD, and on a build where
// those pods are not linked it throws during import — not on first use. That
// is not hypothetical: on 2026-09-20 it crashed the carrier device inside
// expo-router's route loading, because SignedIn.tsx imports BOTH CarrierHome
// and ShipperHome so it can branch on role at render time, and the shipper
// tree reaches this file via ShipperTracking -> DeliveryPhoto -> photo.ts.
// Role-gating at render cannot help when the import is static: the whole
// graph loads before anything decides what to show.
//
// The real require now happens inside pickDeliveryPhoto, which only runs when
// a carrier actually taps capture.
import type { Action } from 'expo-image-manipulator';
import type { ImagePickerOptions } from 'expo-image-picker';

import { API } from './constants';
import { type SigningWallet } from './profile';
import { signPrefixed } from './sponsor';

/**
 * Proof-of-delivery photo capture and upload.
 *
 * NEVER A HARD GATE — a deliberate divergence from what the program asks for.
 * mark_delivered.rs says in so many words that "the client should require a
 * delivery photo be attached before it lets a carrier call this — that's a UX
 * gate, not an on-chain one". The web client does NOT honour that: its Mark
 * delivered button is enabled whether or not a photo exists, with only a nudge
 * underneath, and DeliveryPhoto.jsx's own comment states the opposite policy
 * outright — "Never a hard gate: a failed/missing photo must not block the
 * escrow release."
 *
 * Mobile matches web rather than the program comment. Enforcing it here would
 * make the two clients disagree about whether a carrier can get paid, which is
 * a worse outcome than both being consistently lenient. The intent stated in
 * mark_delivered.rs is unenforced in BOTH clients; that is a product decision
 * to revisit deliberately, not a mobile-only gap to close unilaterally.
 *
 * STORAGE IS BASE64 IN D1, not object storage. The worker writes the whole
 * data URL into cargo.delivery_photo (UPDATE cargo SET delivery_photo = ?),
 * so the size cap below is a real database constraint, not a network nicety.
 */

/** Longest edge, in px. Mirrors web's MAX_PHOTO_DIM. */
const MAX_PHOTO_DIM = 800;
/** JPEG quality. Mirrors web's PHOTO_QUALITY. */
const PHOTO_QUALITY = 0.72;
/**
 * The worker's own cap: isDataImage() rejects anything over 400,000 CHARACTERS
 * of data URL (worker/index.js). That is roughly 293 KB of JPEG once the
 * "data:image/jpeg;base64," prefix and base64's 4/3 expansion are accounted
 * for. Enforced here so an oversized photo fails with something a carrier can
 * act on, rather than as an opaque 400 after the upload has already run.
 */
const MAX_IMAGE_LEN = 400_000;

const PHOTO_MESSAGE_PREFIX = 'pura:photo:';

export type PhotoSource = 'camera' | 'library';

/**
 * Open the camera or the photo library and return a compressed data URL, or
 * null if the user cancelled.
 *
 * Web uses a single `<input capture="environment">`, which prefers the rear
 * camera but still lets the user pick from their library. There is no single
 * control with that behaviour on iOS, so the two paths are separate here and
 * the caller offers both.
 *
 * Throws with a user-facing message on permission denial or an oversized
 * result. Cancellation is NOT an error — it returns null.
 */
export async function pickDeliveryPhoto(source: PhotoSource): Promise<string | null> {
  // Dynamic import: the first point at which native code is genuinely needed.
  // Cached by the module system, so the repeat in compressToDataUrl is free.
  const ImagePicker = await import('expo-image-picker');

  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      throw new Error('Camera access is off for Pura. Turn it on in Settings to take a delivery photo.');
    }
  } else {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      throw new Error('Photo access is off for Pura. Turn it on in Settings to attach a delivery photo.');
    }
  }

  const opts: ImagePickerOptions = {
    mediaTypes: ['images'],
    // Compression happens in the manipulator pass below, at web's exact
    // quality. Asking the picker for full quality first avoids compressing
    // twice and losing more than web does for the same settings.
    quality: 1,
    exif: false,
  };
  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync(opts)
    : await ImagePicker.launchImageLibraryAsync(opts);

  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset?.uri) throw new Error('No photo came back from the picker.');

  return compressToDataUrl(asset.uri, asset.width, asset.height);
}

/**
 * Resize the longest edge to MAX_PHOTO_DIM and encode as a JPEG data URL.
 *
 * THE RESIZE IS LOAD-BEARING, not cosmetic. expo-image-picker cannot resize —
 * its `quality` only re-encodes at the original dimensions — and a current
 * phone camera produces an image that blows past the worker's 400,000-char cap
 * even at low quality. Web gets this for free by drawing to a canvas at the
 * scaled size; here it needs an explicit manipulator pass.
 *
 * Which edge to constrain depends on orientation: passing only `width` keeps
 * the aspect ratio, so a portrait photo constrained to width 800 would still
 * be ~1400 tall. Web scales by `min(1, 800 / max(w, h))`, i.e. it caps the
 * LONGER edge — mirrored here.
 */
async function compressToDataUrl(uri: string, width: number, height: number): Promise<string> {
  const ImageManipulator = await import('expo-image-manipulator');

  const longest = Math.max(width, height);
  const actions: Action[] = [];
  if (longest > MAX_PHOTO_DIM) {
    actions.push(
      width >= height
        ? { resize: { width: MAX_PHOTO_DIM } }
        : { resize: { height: MAX_PHOTO_DIM } }
    );
  }

  const out = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: PHOTO_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  if (!out.base64) throw new Error('Could not encode the photo.');

  // The manipulator returns bare base64; the worker's isDataImage() requires
  // the data: prefix, so it is added here rather than assumed.
  const dataUrl = `data:image/jpeg;base64,${out.base64}`;

  if (dataUrl.length > MAX_IMAGE_LEN) {
    const kb = Math.round((dataUrl.length * 3) / 4 / 1024);
    throw new Error(
      `That photo is too large to attach (about ${kb} KB after compression). Try a photo with less detail.`
    );
  }
  console.log(`[photo] ${out.width}x${out.height}, ${Math.round(dataUrl.length / 1024)}KB of data URL`);
  return dataUrl;
}

export type UploadResult = { ok: true } | { ok: false; error: string };

/**
 * POST /api/cargo/photo — signed, carrier-only.
 *
 * `pura:photo:<ts>` is the PLAIN unbound form (verifySignedMessage), the same
 * shape as pura:cargo-complete:, not the bound read form. The worker's carrier
 * check reads cargo.carrier, which is a MIRROR written by POST
 * /api/cargo/accept after the on-chain accept — so a booking whose mirror
 * write failed will 403 here even though the chain says this wallet is the
 * carrier. That is the mirror's bug to fix, per the worker's own comment, and
 * is surfaced below rather than papered over.
 *
 * Returns a result instead of throwing: an upload is advisory, and a failure
 * must never read as though the delivery itself failed.
 */
export async function uploadDeliveryPhoto(
  wallet: SigningWallet,
  bookingPda: string,
  dataUrl: string
): Promise<UploadResult> {
  try {
    const auth = await signPrefixed(wallet, PHOTO_MESSAGE_PREFIX);
    const res = await fetch(`${API}/api/cargo/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        booking_pda: bookingPda,
        photo: dataUrl,
        wallet: wallet.address,
        message: auth.message,
        signature: auth.signature,
      }),
    });
    if (res.ok) {
      console.log(`[photo] upload ok pda=${bookingPda}`);
      return { ok: true };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.log(`[photo] upload ${res.status}: ${body.error ?? '(no body)'}`);
    // The worker's own wording is good enough for 403/429; the rest get
    // something a carrier can act on.
    const message =
      res.status === 403 ? 'This booking is not registered to your wallet yet — try again in a moment.'
      : res.status === 404 ? 'This booking has no record to attach a photo to.'
      : res.status === 401 ? 'That signature expired. Try again.'
      : body.error ?? `Upload failed (${res.status}).`;
    return { ok: false, error: message };
  } catch (err) {
    console.log('[photo] upload failed', String(err));
    return { ok: false, error: 'Could not reach the server to attach the photo.' };
  }
}
